// hermes-footprint: desktop half. Plain ESM, loaded uncompiled by Hermes Desktop (no JSX, no build).
//
// Surfaces: route /footprint (sidebar row "Footprint" + ⌘K "Open Footprint") and a status-bar chip.
// Data: the plugin's own backend first, ctx.rest('/scan') -> dashboard/plugin_api.py (mounted by Hermes
//       when the plugin is in plugins.enabled); if that is unavailable, the CLI: host.requestProfile(route,
//       "cli.exec", { argv: ["--profile", p, "footprint", "--json"] }). Scans on open and on Rescan.
// Removal: only after the user reviews the marked list; runs `footprint trash PATH... --json`, which
//       re-scans, refuses anything the scan did not mark, and moves to the desktop trash (never rm).
// Look: theme variables only (--ui-*), so it follows Nous dark and every other skin.

import { host, PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, STATUSBAR_AREAS } from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-footprint'
const ROUTE = '/footprint'
const CLI_TIMEOUT_MS = 120000

// ── data ────────────────────────────────────────────────────────────────────
// Footprint measures THIS machine's disk, so it only runs on local routes, never on a remote
// connection. The plugin is enabled per profile, so try the profile in focus first, then the
// primary, then the rest, and remember the first one where `hermes footprint` exists.
let goodRoute = null
async function localRoutes() {
  const owner = host.state?.focusedSessionOwner?.get?.() || null
  const routes = (await host.profileRoutes()).filter((r) => r.mode === 'local')
  if (!routes.length) throw new Error('No local Hermes profile available')
  const rank = (r) => (goodRoute && r.connectionId === goodRoute.connectionId && r.profile === goodRoute.profile ? 0
    : owner && r.connectionId === owner.connectionId && r.profile === owner.profile ? 1 : r.primary ? 2 : 3)
  return [...routes].sort((a, b) => rank(a) - rank(b))
}
const NOT_HERE = /is not a `?hermes`? command|invalid choice: 'footprint'/

function parseCliJson(output) {
  const lines = String(output || '').split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue
    try { return JSON.parse(lines[i]) } catch { /* keep looking */ }
  }
  const last = lines.slice(-2).join(' ')
  throw new Error(last ? `unreadable output from hermes footprint (${last.length > 160 ? `${last.slice(0, 160)}…` : last})` : 'empty output from hermes footprint')
}

// cli.exec returns at most 48,000 characters, so a big scan arrives as base64 parts.
function b64Bytes(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out }
async function joinParts(first, onPart) {
  const rest = []
  for (let i = 1; i < first.parts; i++) rest.push(i)
  const got = [first]
  for (let k = 0; k < rest.length; k += 4) { // four processes at a time
    const batch = await Promise.all(rest.slice(k, k + 4).map((i) => runFootprint(['part', String(i)])))
    got.push(...batch)
    if (onPart) onPart(got.length, first.parts)
  }
  if (got.some((p) => p.id !== first.id)) throw new Error('scan changed while loading; press Rescan')
  got.sort((a, b) => a.part - b.part)
  const chunks = got.map((p) => b64Bytes(p.data))
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) { all.set(c, at); at += c.length }
  return JSON.parse(new TextDecoder().decode(all))
}
async function scan() {
  const first = await runFootprint([])
  if (first.stopped) return first
  if (!first.parts) return first
  store.progress = { phase: 'load', step: 1, steps: first.parts }; notify()
  return joinParts(first, (n, of) => { store.progress = { phase: 'load', step: n, steps: of }; notify() })
}

// While a scan runs, read its progress file (`footprint progress`) one call at a time.
async function pollProgress() {
  while (store.inflight) {
    try {
      const p = await runFootprint(['progress'])
      if (store.inflight && p.running && store.progress?.phase !== 'load') { store.progress = p; notify() }
    } catch { /* progress is best effort */ }
    await new Promise((r) => setTimeout(r, 1200))
  }
}
function stopScan() { store.stopping = true; notify(); runFootprint(['stop']).catch(() => null) }

// ── backend: REST (dashboard/plugin_api.py) first, the CLI as fallback ──────
let pluginCtx = null           // set in register(); ctx.rest is this plugin's own REST namespace
let backend = null             // 'rest' | 'cli', once one has answered
let restFailure = null
const REST_TIMEOUT_MS = 180000
function restAvailable() { return !!(pluginCtx && typeof pluginCtx.rest === 'function') }
async function viaRest(args) {
  const rest = (path, opts) => pluginCtx.rest(path, { timeoutMs: REST_TIMEOUT_MS, ...(opts || {}) })
  const [cmd, ...tail] = args
  if (!cmd) return rest('/scan')
  if (cmd === 'progress') return rest('/progress', { timeoutMs: 10000 })
  if (cmd === 'stop') return rest('/stop', { method: 'POST', body: {} })
  if (cmd === 'trash') return rest('/trash', { method: 'POST', body: { paths: tail } })
  if (cmd === 'open') return rest('/open', { method: 'POST', body: { path: tail[0] } })
  throw new Error(`no REST route for ${cmd}`)
}

async function runFootprint(args) {
  if (backend !== 'cli' && restAvailable()) {
    try {
      const r = await viaRest(args)
      backend = 'rest'
      return r
    } catch (e) {
      restFailure = String(e && e.message || e)
      if (backend === 'rest') throw e   // the backend answered before, so this is a real failure
      console.error(`[hermes-footprint] backend REST unavailable (${restFailure}); trying the CLI`)
    }
  }
  const r = await viaCli(args)
  backend = 'cli'
  return r
}

async function runOn(route, args) {
  const res = await host.requestProfile(route, 'cli.exec',
    { argv: ['--profile', route.targetProfile, 'footprint', ...args, '--json'], timeout: CLI_TIMEOUT_MS / 1000 }, CLI_TIMEOUT_MS + 5000)
  if (res && res.blocked) throw new Error(res.hint || 'cli.exec blocked')
  if (NOT_HERE.test(String(res && res.output || ''))) return null
  const payload = parseCliJson(res && res.output)
  if (payload.error) throw new Error(payload.error)
  return payload
}

async function viaCli(args) {
  const tried = []
  for (const route of await localRoutes()) {
    const payload = await runOn(route, args)
    if (payload) { goodRoute = route; return payload }
    tried.push(route.profile)
  }
  throw new Error(`the hermes-footprint plugin is not enabled in any local profile (tried ${tried.join(', ')}). ` +
    'Run: hermes plugins enable hermes-footprint, then restart Hermes Desktop.' + (restFailure ? ` (backend: ${restFailure})` : ''))
}

// One shared store so the page and the status chip never double-scan.
const store = { data: null, error: null, at: 0, listeners: new Set(), inflight: null }
function notify() { store.listeners.forEach((fn) => fn()) }
function rescan() {
  if (store.inflight) return store.inflight
  store.progress = null; store.stopped = false; store.stopping = false
  store.inflight = scan()
    .then((d) => { if (d.stopped) store.stopped = true; else { store.data = d; store.error = null; store.at = Date.now() } })
    .catch((e) => { store.error = String(e && e.message || e); console.error(`[hermes-footprint] scan failed: ${store.error}`) })
    .finally(() => { store.inflight = null; store.progress = null; store.stopping = false; notify() })
  notify()
  setTimeout(pollProgress, 1500)
  return store.inflight
}
function useFootprint() {
  const [, bump] = useState(0)
  useEffect(() => {
    const fn = () => bump((n) => n + 1)
    store.listeners.add(fn)
    if (store.data || store.error) fn() // the scan may have finished before this subscribed
    else if (!store.inflight) rescan()
    return () => store.listeners.delete(fn)
  }, [])
  return store
}

// ── theme ───────────────────────────────────────────────────────────────────
const V = (name, fallback) => `var(${name}, ${fallback})`
const C = {
  accent: V('--ui-accent', '#4a84fe'), red: V('--ui-red', '#ff7b72'), yellow: V('--ui-yellow', '#d29922'),
  green: V('--ui-green', '#3fb950'), t1: V('--ui-text-primary', '#e6edf3'), t2: V('--ui-text-secondary', '#b1bac4'),
  t3: V('--ui-text-tertiary', '#7d8590'), t4: V('--ui-text-quaternary', '#6e7681'),
  stroke: V('--ui-stroke-tertiary', '#30363d'), panel: V('--ui-bg-elevated', '#010409'),
}
function cssColor(varName, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return v || fallback
}
const MONO = 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace'
// What a folder is to Hermes -> theme variable. Canvas needs real colours, so they are read at paint time.
const KIND_VARS = {
  app: ['--ui-accent', '#4a84fe'], toolchain: ['--ui-purple', '#bc8cff'], memory: ['--ui-green', '#3fb950'],
  skills: ['--ui-cyan', '#39c5cf'], worktree: ['--ui-orange', '#ffa657'], backup: ['--ui-yellow', '#d29922'],
  browser: ['--ui-pink', '#f778ba'], cache: ['--ui-text-tertiary', '#7d8590'], bot: ['--ui-blue', '#79c0ff'],
  other: ['--ui-text-quaternary', '#6e7681'],
}
const kindColor = (k) => { const [v, f] = KIND_VARS[k] || KIND_VARS.other; return cssColor(v, f) }
const kindCss = (k) => { const [v, f] = KIND_VARS[k] || KIND_VARS.other; return V(v, f) }

function fmt(b) {
  if (b == null) return '—'
  if (b >= 1e12) return `${(b / 1e12).toFixed(2)} TB`
  if (b >= 1e9) return `${(b / 1e9).toFixed(b >= 1e10 ? 1 : 2)} GB`
  if (b >= 1e6) return `${(b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB`
  if (b >= 1e3) return `${Math.round(b / 1e3)} KB`
  return `${b} B`
}
function ago(ts) {
  if (!ts) return ''
  const d = (Date.now() / 1000 - ts) / 86400
  return d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 60 ? `${Math.floor(d)} days ago` : `${Math.floor(d / 30)} months ago`
}

// ── squarified treemap (Bruls, Huizing, van Wijk) ───────────────────────────
function squarify(items, x, y, w, h) {
  const total = items.reduce((s, it) => s + it.value, 0)
  if (!total || w <= 0 || h <= 0) return []
  const scale = (w * h) / total
  const rest = items.map((it) => ({ it, area: it.value * scale })).filter((r) => r.area > 0)
  const out = []
  let row = []
  const worst = (r, side) => {
    const s = r.reduce((a, b) => a + b.area, 0)
    let max = 0, min = Infinity
    for (const q of r) { max = Math.max(max, q.area); min = Math.min(min, q.area) }
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min))
  }
  const layoutRow = () => {
    const s = row.reduce((a, b) => a + b.area, 0)
    if (w >= h) {
      const cw = s / h; let cy = y
      for (const q of row) { const ch = q.area / cw; out.push({ it: q.it, x, y: cy, w: cw, h: ch }); cy += ch }
      x += cw; w -= cw
    } else {
      const ch = s / w; let cx = x
      for (const q of row) { const cw = q.area / ch; out.push({ it: q.it, x: cx, y, w: cw, h: ch }); cx += cw }
      y += ch; h -= ch
    }
    row = []
  }
  for (const r of rest) {
    const side = Math.min(w, h)
    if (!row.length || worst([...row, r], side) <= worst(row, side)) row.push(r)
    else { layoutRow(); row.push(r) }
  }
  if (row.length) layoutRow()
  return out
}

// Lay out `node`'s children in a box; folders big enough get a header strip and their own children.
function layout(node, x, y, w, h, depth, maxDepth, out) {
  const kids = (node.children || []).filter((c) => c.bytes > 0).map((c) => ({ value: c.bytes, node: c }))
  for (const r of squarify(kids, x, y, w, h)) {
    const n = r.it.node
    const tile = { node: n, x: r.x, y: r.y, w: r.w, h: r.h, depth }
    out.push(tile)
    const open = depth < maxDepth && n.children && n.children.length && r.w > 70 && r.h > 46
    if (open) { tile.header = true; layout(n, r.x + 2, r.y + 17, r.w - 4, r.h - 19, depth + 1, maxDepth, out) }
  }
  return out
}

function findPath(root, path) {
  const trail = [root]
  if (!path) return trail
  let cur = root
  for (;;) {
    const next = (cur.children || []).find((c) => !c.rest && !c.file && (path === c.path || path.startsWith(c.path + '/')))
    if (!next) return trail
    trail.push(next); cur = next
    if (next.path === path) return trail
  }
}

// ── the treemap ─────────────────────────────────────────────────────────────
function Treemap({ root, marked, onOpen, onToggle }) {
  const wrap = useRef(null), canvas = useRef(null)
  const [size, setSize] = useState({ w: 800, h: 460 })
  const [hover, setHover] = useState(null)
  const tiles = useMemo(() => layout(root, 0, 0, size.w, size.h, 0, 2, []), [root, size.w, size.h])

  useEffect(() => {
    const el = wrap.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => setSize({ w: Math.max(200, el.clientWidth), h: Math.max(240, el.clientHeight) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const cv = canvas.current
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    cv.width = size.w * dpr; cv.height = size.h * dpr
    const g = cv.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, size.w, size.h)
    const bg = cssColor('--ui-bg-elevated', '#010409'), text = cssColor('--ui-text-primary', '#e6edf3')
    const red = cssColor('--ui-red', '#ff7b72')
    g.font = '11px system-ui, sans-serif'; g.textBaseline = 'top'
    for (const t of tiles) {
      const n = t.node, col = kindColor(n.kind)
      const x = t.x + 0.5, y = t.y + 0.5, w = Math.max(0, t.w - 1), h = Math.max(0, t.h - 1)
      if (w < 1 || h < 1) continue
      g.fillStyle = bg; g.fillRect(x, y, w, h)
      g.globalAlpha = n.rest ? 0.12 : t.header ? 0.16 : 0.42 - t.depth * 0.06
      g.fillStyle = col; g.fillRect(x, y, w, h)
      g.globalAlpha = 1
      if (n.reclaim) { // disktree's hatch: this space can come back
        g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip()
        g.strokeStyle = col; g.globalAlpha = 0.55; g.lineWidth = 1.2
        for (let k = -h; k < w; k += 7) { g.beginPath(); g.moveTo(x + k, y + h); g.lineTo(x + k + h, y); g.stroke() }
        g.restore()
      }
      g.strokeStyle = col; g.globalAlpha = hover === t ? 1 : 0.6; g.lineWidth = hover === t ? 2 : 1
      g.strokeRect(x, y, w, h); g.globalAlpha = 1
      if (marked.has(n.fullPath)) { g.strokeStyle = red; g.lineWidth = 2.5; g.setLineDash([5, 3]); g.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3); g.setLineDash([]) }
      if (w > 46 && h > 15) {
        g.save(); g.beginPath(); g.rect(x + 3, y, w - 6, h); g.clip()
        g.fillStyle = text; g.globalAlpha = n.rest ? 0.55 : 0.95
        g.font = `${t.depth === 0 ? 600 : 500} ${t.depth === 0 ? 12 : 11}px system-ui, sans-serif`
        g.fillText(n.name, x + 5, y + 3)
        if (!t.header && h > 32) { g.globalAlpha = 0.6; g.font = `10.5px ${MONO}`; g.fillText(fmt(n.bytes), x + 5, y + 18) }
        if (t.header && w > 140) { g.globalAlpha = 0.6; g.font = `10.5px ${MONO}`; const s = fmt(n.bytes); g.fillText(s, x + w - 6 - g.measureText(s).width, y + 3) }
        g.restore()
      }
    }
  }, [tiles, hover, marked, size.w, size.h])

  const hit = (e) => {
    const r = canvas.current.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top
    let best = null
    for (const t of tiles) if (px >= t.x && px < t.x + t.w && py >= t.y && py < t.y + t.h) best = t // deepest wins
    return best
  }
  const tip = hover && hover.node
  return jsxs('div', {
    ref: wrap, style: { position: 'relative', flex: 1, minHeight: 300, borderRadius: 8, overflow: 'hidden', border: `1px solid ${C.stroke}` },
    children: [
      jsx('canvas', {
        ref: canvas, style: { width: '100%', height: '100%', display: 'block', cursor: tip && (tip.reclaim || (tip.children && !tip.rest)) ? 'pointer' : 'default' },
        onMouseMove: (e) => setHover(hit(e)), onMouseLeave: () => setHover(null),
        onClick: (e) => {
          const t = hit(e); if (!t) return
          let n = t.node
          if (n.reclaim) return onToggle(n)
          if (!n.children || n.rest) { // a file or a folded tile: open its folder instead
            const owner = tiles.filter((u) => u.header && t.x >= u.x && t.y >= u.y && t.x < u.x + u.w && t.y < u.y + u.h).pop()
            if (!owner) return
            n = owner.node
          }
          onOpen(n)
        },
      }),
      tip ? jsxs('div', {
        style: { position: 'absolute', left: Math.min(hover.x + 8, size.w - 290), top: Math.min(hover.y + hover.h + 6, size.h - 96), width: 280, pointerEvents: 'none',
          background: C.panel, border: `1px solid ${C.stroke}`, borderRadius: 8, padding: '8px 10px', fontSize: 11.5, color: C.t2, boxShadow: '0 8px 24px rgba(0,0,0,.4)' },
        children: [
          jsx('div', { style: { color: C.t1, fontWeight: 600, wordBreak: 'break-all' }, children: tip.rest ? tip.name : tip.fullPath }),
          jsx('div', { style: { fontFamily: MONO, marginTop: 3 }, children: `${fmt(tip.bytes)}${tip.files > 1 ? ` · ${tip.files.toLocaleString()} files` : ''}${tip.mtime ? ` · changed ${ago(tip.mtime)}` : ''}` }),
          jsx('div', { style: { color: kindCss(tip.kind), marginTop: 2 }, children: store.data?.kinds?.[tip.kind] || tip.kind }),
          tip.reclaim ? jsx('div', { style: { color: C.yellow, marginTop: 4 }, children: `Can go: ${tip.reclaim}. Click to mark.` }) : null,
        ],
      }) : null,
    ],
  })
}

// Paths in the payload are relative to ~/.hermes; give every node its full display path once.
// The payload carries names only; rebuild each node's path (relative to ~/.hermes) from its parents.
function withFullPaths(n, prefix, parentPath = null) {
  if (parentPath === null) n.path = ''
  else n.path = n.rest ? parentPath : parentPath ? `${parentPath}/${n.name}` : n.name
  n.fullPath = n.path ? `${prefix}/${n.path}` : prefix
  for (const c of n.children || []) withFullPaths(c, prefix, n.path)
  return n
}
function kindTotals(n, acc = {}) {
  if (!n.children || n.reclaim) { acc[n.kind] = (acc[n.kind] || 0) + n.bytes; return acc }
  for (const c of n.children) kindTotals(c, acc)
  return acc
}

// ── page ────────────────────────────────────────────────────────────────────
const btn = (extra) => ({ fontSize: 12, padding: '4px 11px', borderRadius: 6, border: `1px solid ${C.stroke}`, background: 'transparent', color: C.t2, cursor: 'pointer', ...extra })
const label = { fontSize: 10.5, letterSpacing: '.09em', color: C.t3, textTransform: 'uppercase' }

// ── actions: Ask a Bot, Open, Copy ──────────────────────────────────────────
const COMPOSER_INSERT = 'hermes:composer-insert'
const COMPOSER_FOCUS = 'hermes:composer-focus'
// Puts a draft in the chat box (never sends it), the same events core and GitHermes use.
function askBot(item) {
  const text = `Footprint shows \`${item.path}\` using ${fmt(item.bytes)} (${store.data?.kinds?.[item.kind] || item.kind}).` +
    (item.reason ? ` Footprint's reason: ${item.reason}.` : '') +
    ' What is it, what made it, and is it safe to remove? Look only; do not delete or move anything.'
  host.navigate('/')
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent(COMPOSER_INSERT, { detail: { mode: 'block', target: 'main', text } }))
    window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS, { detail: { target: 'main' } }))
  }, 250)
}
function copyPath(p) { try { navigator.clipboard.writeText(p) } catch { /* no clipboard */ } }
function openFolder(p) { return runFootprint(['open', p]).catch(() => null) }
const KEPT_KEY = 'hermes-footprint.kept'
function loadKept() { try { return new Set(JSON.parse(localStorage.getItem(KEPT_KEY) || '[]')) } catch { return new Set() } }
function saveKept(set) { try { localStorage.setItem(KEPT_KEY, JSON.stringify([...set])) } catch { /* private mode */ } }
const safety = (r) => /look first/.test(r.reason) ? { label: 'LOOK FIRST', color: C.yellow } : /rebuilt|reinstallable/.test(r.reason) ? { label: 'SAFE', color: C.green } : { label: 'CHECK', color: C.t2 }

function ActionRow({ item, compact }) {
  const [copied, setCopied] = useState(false)
  const b = btn({ fontSize: compact ? 10.5 : 11.5, padding: compact ? '1px 7px' : '4px 10px' })
  return jsxs('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' }, onClick: (e) => e.stopPropagation(), children: [
    jsx('button', { type: 'button', style: b, title: 'Draft a question to the Bot in chat (not sent)', onClick: () => askBot(item), children: '✦ Ask a Bot' }),
    jsx('button', { type: 'button', style: b, title: 'Show in the file manager', onClick: () => openFolder(item.path), children: 'Open' }),
    jsx('button', { type: 'button', style: b, onClick: () => { copyPath(item.path); setCopied(true); setTimeout(() => setCopied(false), 1200) }, children: copied ? 'Copied' : 'Copy path' }),
  ] })
}

// One card at a time: Keep (K) or Trash (T). Trash only marks; the Trash step still asks once more.
function Deck({ items, onDone, onCancel, start = 0 }) {
  const [i, setI] = useState(start)
  const [picks, setPicks] = useState({})
  const r = items[i]
  const decide = (choice) => { setPicks((p) => ({ ...p, [r.path]: choice })); setI((n) => n + 1) }
  useEffect(() => {
    const onKey = (e) => {
      if (!r) return
      if (e.key === 'k' || e.key === 'K' || e.key === 'ArrowLeft') decide('keep')
      else if (e.key === 't' || e.key === 'T' || e.key === 'ArrowRight') decide('trash')
      else if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const trash = items.filter((x) => picks[x.path] === 'trash'), keep = items.filter((x) => picks[x.path] === 'keep')
  const shell = (children) => jsx('div', { style: { position: 'absolute', inset: 0, background: 'rgba(1,4,9,.86)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5 }, children })
  if (!r) {
    const freed = trash.reduce((a, x) => a + x.bytes, 0)
    return shell(jsxs('div', { style: { width: 'min(460px, 92%)', background: C.panel, border: `1px solid ${C.stroke}`, borderRadius: 14, padding: 22, textAlign: 'center' }, children: [
      jsx('div', { style: { ...label, marginBottom: 8 }, children: 'Review done' }),
      jsx('div', { style: { fontSize: 34, fontWeight: 650, color: trash.length ? C.green : C.t1 }, children: fmt(freed) }),
      jsx('div', { style: { fontSize: 12.5, color: C.t3, marginTop: 4 }, children: `${trash.length} to Trash · ${keep.length} kept (they stay off this list)` }),
      jsxs('div', { style: { display: 'flex', gap: 8, justifyContent: 'center', marginTop: 18 }, children: [
        jsx('button', { type: 'button', onClick: onCancel, style: btn(), children: 'Cancel' }),
        jsx('button', { type: 'button', onClick: () => onDone(trash, keep), style: btn({ background: trash.length ? C.red : C.accent, color: '#fff', border: 0, padding: '6px 14px' }),
          children: trash.length ? `Next: confirm ${trash.length} for Trash` : 'Save and close' }),
      ] }),
    ] }))
  }
  const sf = safety(r)
  return shell(jsxs('div', { style: { width: 'min(520px, 92%)' }, children: [
    jsx('div', { style: { display: 'flex', gap: 4, marginBottom: 10 }, children: items.map((x, k) => jsx('div', { key: x.path, style: { flex: 1, height: 3, borderRadius: 2,
      background: picks[x.path] === 'trash' ? C.red : picks[x.path] === 'keep' ? C.green : k === i ? C.t1 : C.stroke } })) }),
    jsxs('div', { key: r.path, style: { position: 'relative', background: C.panel, border: `1px solid ${C.stroke}`, borderTop: `3px solid ${kindCss(r.kind)}`, borderRadius: 14, padding: '18px 20px',
      boxShadow: '0 24px 60px rgba(0,0,0,.55)', animation: 'fpIn .18s ease-out' }, children: [
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8 }, children: [
        jsx('span', { style: { fontSize: 10.5, fontWeight: 700, letterSpacing: '.08em', color: sf.color, border: `1px solid ${sf.color}`, borderRadius: 5, padding: '1px 6px' }, children: sf.label }),
        jsx('span', { style: { fontSize: 11.5, color: kindCss(r.kind) }, children: store.data?.kinds?.[r.kind] || r.kind }),
        jsx('span', { style: { marginLeft: 'auto', fontSize: 11, color: C.t4 }, children: `${i + 1} of ${items.length}` }),
      ] }),
      jsx('div', { style: { fontSize: 44, fontWeight: 650, color: C.t1, margin: '10px 0 2px', fontFamily: MONO, letterSpacing: '-.02em' }, children: fmt(r.bytes) }),
      jsx('div', { style: { fontSize: 13, color: C.t1, wordBreak: 'break-all' }, children: r.path }),
      jsx('div', { style: { fontSize: 12.5, color: sf.color === C.yellow ? C.yellow : C.t2, marginTop: 8, lineHeight: 1.45 }, children: r.reason }),
      r.mtime ? jsx('div', { style: { fontSize: 11.5, color: C.t3, marginTop: 4 }, children: `Last changed ${ago(r.mtime)}` }) : null,
      r.git ? jsx(GitBlock, { g: r.git }) : null,
      jsx('div', { style: { marginTop: 14 }, children: jsx(ActionRow, { item: r }) }),
      jsxs('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 16 }, children: [
        jsx('button', { type: 'button', onClick: () => decide('keep'), style: btn({ padding: '10px 0', fontSize: 13, color: C.t1 }), children: 'Keep  ·  K' }),
        jsx('button', { type: 'button', onClick: () => decide('trash'), style: btn({ padding: '10px 0', fontSize: 13, color: '#fff', background: C.red, border: 0 }), children: 'Trash  ·  T' }),
      ] }),
    ] }),
    jsx('div', { style: { textAlign: 'center', fontSize: 11, color: C.t4, marginTop: 10 }, children: 'Nothing moves until you confirm at the end. Esc to stop.' }),
  ] }))
}

// ── catalog-style cards (same shape as the Hermes plugin catalog) ────────────
const KIND_GLYPH = { app: '◆', toolchain: '⚙', memory: '◉', skills: '✦', worktree: '⑂', backup: '⧉', browser: '◎', cache: '◫', bot: '☺', other: '▢' }
// A card's plain name, and its bullets: why it can go, then when it changed or what to check.
function whatItIs(r) {
  const parts = r.path.split('/'), name = parts[parts.length - 1]
  const bot = /profiles\/([^/]+)/.exec(r.path)?.[1]
  const browser = bot ? `${bot}'s browser` : 'Hermes browser'
  let title
  if (r.kind === 'worktree') title = `Worktree ${name}`
  else if (name === 'uv') title = 'Python package cache'
  else if (name === 'pip') title = 'pip package cache'
  else if (name === '_cacache') title = 'npm package cache'
  else if (name === '__pycache__') title = `Compiled Python ${/python-(\d+\.\d+)/.exec(r.path)?.[1] || ''}`.trim()
  else if (name === 'node_modules') title = `npm packages (${parts[parts.length - 2]})`
  else if (name === 'Code Cache') title = `${browser} code cache`
  else if (name === 'GPUCache' || name === 'ShaderCache') title = `${browser} GPU cache`
  else if (name === 'Crashpad') title = `${browser} crash reports`
  else if (name === 'Cache') title = `${browser} cache`
  else if (r.kind === 'backup') title = `Backup ${name}`
  else title = name
  const [why, look] = r.reason.split('; ')
  const short = why.includes(': ') ? why.split(': ').pop() : why
  const bullets = [short.charAt(0).toUpperCase() + short.slice(1)]
  if (look && !r.git) bullets.push(look.replace(/^it has/, 'Has').replace(/ \(then.*$/, ''))
  if (r.mtime && !r.git) bullets.push(`Last changed ${ago(r.mtime)}`)
  return { title, bullets }
}

function IconTile({ kind, size = 36 }) {
  return jsx('div', { style: { width: size, height: size, borderRadius: 9, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: size * 0.5, color: kindCss(kind), background: `color-mix(in srgb, ${kindCss(kind)} 16%, transparent)`, border: `1px solid color-mix(in srgb, ${kindCss(kind)} 30%, transparent)` },
    children: KIND_GLYPH[kind] || KIND_GLYPH.other })
}

function CatalogCard({ icon, title, subtitle, label: lbl = 'What it is', bullets, badge, action, onAction, marked, extra }) {
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', background: C.panel, borderRadius: 12, padding: '14px 14px 12px', minHeight: 196,
      border: marked ? `1.5px solid ${C.red}` : `1px solid ${C.stroke}`, transition: 'border-color .12s, transform .12s' },
    onMouseEnter: (e) => { if (!marked) e.currentTarget.style.borderColor = 'var(--ui-text-quaternary, #6e7681)' },
    onMouseLeave: (e) => { if (!marked) e.currentTarget.style.borderColor = '' },
    children: [
      jsxs('div', { style: { display: 'flex', gap: 10, alignItems: 'center' }, children: [
        icon,
        jsxs('div', { style: { minWidth: 0 }, children: [
          jsx('div', { style: { fontSize: 15, fontWeight: 650, color: C.t1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title, children: title }),
          jsx('div', { style: { fontSize: 11.5, color: C.t3, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: subtitle, children: subtitle }),
        ] }),
      ] }),
      jsx('div', { style: { fontSize: 11.5, fontWeight: 650, color: C.t2, marginTop: 12 }, children: lbl }),
      jsx('ul', { style: { margin: '5px 0 0', paddingLeft: 16, fontSize: 12.5, lineHeight: 1.45, color: C.t2 }, children: bullets.map((b, i) => jsx('li', { style: { marginBottom: 2 }, children: b }, i)) }),
      extra || null,
      jsxs('div', { style: { display: 'flex', alignItems: 'center', marginTop: 'auto', paddingTop: 10 }, children: [
        badge ? jsx('span', { style: { fontSize: 11, color: badge.color }, children: badge.label }) : null,
        jsx('button', { type: 'button', onClick: onAction, style: { marginLeft: 'auto', background: 'none', border: 0, color: C.t1, fontSize: 12.5, cursor: 'pointer', padding: '2px 0' },
          children: `${action}  →` }),
      ] }),
    ] })
}

// One thing that can go: size is the hero, safety is the colour, Keep / Trash are right there.
function GoCard({ r, share, marked, onToggle, onDetails }) {
  const sf = safety(r), w = whatItIs(r)
  const edge = marked ? C.red : sf.color
  return jsxs('div', {
    style: { position: 'relative', display: 'flex', flexDirection: 'column', background: C.panel, borderRadius: 12, padding: '14px 14px 12px 17px', overflow: 'hidden',
      border: `1px solid ${marked ? C.red : C.stroke}`, transition: 'border-color .12s, transform .12s' },
    onMouseEnter: (e) => { e.currentTarget.style.transform = 'translateY(-2px)' }, onMouseLeave: (e) => { e.currentTarget.style.transform = '' },
    children: [
      jsx('div', { style: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: edge } }),
      jsxs('div', { style: { display: 'flex', gap: 10, alignItems: 'center' }, children: [
        jsx(IconTile, { kind: r.kind, size: 34 }),
        jsxs('div', { style: { minWidth: 0, flex: 1 }, children: [
          jsx('div', { style: { fontSize: 14.5, fontWeight: 650, color: C.t1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: w.title, children: w.title }),
          jsx('div', { style: { fontSize: 11, color: C.t3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: r.path, children: r.path.replace('~/.hermes/', '') }),
        ] }),
      ] }),
      jsxs('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 12 }, children: [
        jsx('span', { style: { fontSize: 30, fontWeight: 650, color: C.t1, fontFamily: MONO, letterSpacing: '-.02em', whiteSpace: 'nowrap' }, children: fmt(r.bytes) }),
        jsx('span', { style: { marginLeft: 'auto', alignSelf: 'center', flex: 'none', fontSize: 10, fontWeight: 700, letterSpacing: '.07em', color: marked ? C.red : sf.color,
          border: `1px solid ${marked ? C.red : sf.color}`, borderRadius: 20, padding: '2px 8px' }, children: marked ? 'TRASH' : sf.label }),
      ] }),
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }, children: [
        jsx('div', { style: { flex: 1, height: 4, borderRadius: 2, background: C.stroke }, children:
          jsx('div', { style: { width: `${Math.max(1.5, share)}%`, height: '100%', borderRadius: 2, background: edge } }) }),
        jsx('span', { style: { fontSize: 11, color: C.t3, whiteSpace: 'nowrap' }, children: `${share < 1 ? '<1' : Math.round(share)}% of what can go` }),
      ] }),
      jsx('ul', { style: { margin: '10px 0 0', paddingLeft: 16, fontSize: 12.5, lineHeight: 1.45, color: C.t2 }, children: w.bullets.map((b, i) => jsx('li', { children: b }, i)) }),
      r.git ? jsx(GitBlock, { g: r.git }) : null,
      jsxs('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 'auto', paddingTop: 12 }, children: [
        jsx('button', { type: 'button', onClick: () => marked && onToggle(r), style: btn({ padding: '5px 12px', color: marked ? C.t2 : C.t1, borderColor: marked ? C.stroke : C.t4 }), children: 'Keep' }),
        jsx('button', { type: 'button', onClick: () => !marked && onToggle(r),
          style: btn({ padding: '5px 12px', color: marked ? '#fff' : C.t2, background: marked ? C.red : 'transparent', border: marked ? 0 : `1px solid ${C.stroke}` }), children: marked ? '✓ Trash' : 'Trash' }),
        jsx('button', { type: 'button', onClick: onDetails, style: { marginLeft: 'auto', background: 'none', border: 0, color: C.t2, fontSize: 12.5, cursor: 'pointer' }, children: 'Details  →' }),
      ] }),
    ] })
}

function CardsView({ items, marked, onToggle, onReview, onTrashMarked, keptCount, onShowKept }) {
  const total = items.reduce((a, r) => a + r.bytes, 0)
  const markedItems = items.filter((r) => marked.has(r.path))
  const markedBytes = markedItems.reduce((a, r) => a + r.bytes, 0)
  const safeBytes = items.filter((r) => safety(r).label === 'SAFE').reduce((a, r) => a + r.bytes, 0)
  const summary = jsxs('div', { style: { gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', background: C.panel,
    border: `1px solid ${C.stroke}`, borderRadius: 12, padding: '14px 16px' }, children: [
    jsxs('div', { children: [
      jsx('div', { style: label, children: 'Can go' }),
      jsx('div', { style: { fontSize: 34, fontWeight: 650, color: C.t1, fontFamily: MONO, letterSpacing: '-.02em', lineHeight: 1.15 }, children: fmt(total) }),
      jsx('div', { style: { fontSize: 12, color: C.t3 }, children: `${items.length} item${items.length === 1 ? '' : 's'} · ${fmt(safeBytes)} safe to trash · ${fmt(total - safeBytes)} to look at first` }),
    ] }),
    jsxs('div', { style: { flex: 1, minWidth: 240 }, children: [
      jsx('div', { style: { display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', gap: 2 }, children: items.map((r) => jsx('div', { key: r.path, title: `${whatItIs(r).title} · ${fmt(r.bytes)}`,
        style: { flex: `${Math.max(r.bytes, total * 0.004)} 0 0`, background: marked.has(r.path) ? C.red : safety(r).color, opacity: marked.has(r.path) ? 1 : 0.75 } })) }),
      jsx('div', { style: { fontSize: 11.5, color: markedItems.length ? C.red : C.t3, marginTop: 6 }, children: markedItems.length ? `${markedItems.length} marked · ${fmt(markedBytes)} goes to the Trash when you confirm` : 'Mark cards with Trash, or review them one by one.' }),
    ] }),
    jsxs('div', { style: { display: 'flex', gap: 8, alignItems: 'center' }, children: [
      keptCount ? jsx('button', { type: 'button', onClick: onShowKept, style: { background: 'none', border: 0, color: C.t3, fontSize: 12, cursor: 'pointer' }, children: `${keptCount} kept · show` }) : null,
      jsx('button', { type: 'button', onClick: () => onReview(0), style: btn({ color: C.t1, padding: '6px 12px' }), children: 'Review one by one' }),
      markedItems.length ? jsx('button', { type: 'button', title: 'Draft a prompt in chat for a Bot to clear the marked items (not sent)', onClick: () => handToBot(markedItems),
        style: btn({ color: C.t1, padding: '6px 12px' }), children: '✦ Hand to a Bot' }) : null,
      jsx('button', { type: 'button', disabled: !markedItems.length, onClick: onTrashMarked,
        style: btn({ padding: '6px 12px', background: markedItems.length ? C.red : 'transparent', color: markedItems.length ? '#fff' : C.t4, border: markedItems.length ? 0 : `1px solid ${C.stroke}`, cursor: markedItems.length ? 'pointer' : 'default' }),
        children: markedItems.length ? `Move to Trash · ${fmt(markedBytes)}` : 'Move to Trash' }),
    ] }),
  ] })
  return jsx('div', { style: { flex: 1, minHeight: 0, overflow: 'auto' }, children: items.length
    ? jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))', gap: 12 }, children: [summary,
      ...items.map((r, i) => jsx(GoCard, { key: r.path, r, share: (100 * r.bytes) / total, marked: marked.has(r.path), onToggle, onDetails: () => onReview(i) }))] })
    : keptCount
      ? jsxs('div', { style: { color: C.t2, fontSize: 13, display: 'flex', gap: 10, alignItems: 'center' }, children: [
        `Nothing new can go. You chose to keep ${keptCount} item${keptCount === 1 ? '' : 's'}.`,
        jsx('button', { type: 'button', onClick: onShowKept, style: btn({ color: C.t1, padding: '5px 12px' }), children: `Show ${keptCount} kept` })] })
      : jsx('div', { style: { color: C.green, fontSize: 13 }, children: 'Nothing can go right now. Hermes is tidy.' }) })
}

function GitBlock({ g }) {
  const where = g.branch ? `Branch ${g.branch}` : `Detached at ${(g.short || '?').slice(0, 7)}`
  const row = (text, color) => jsx('div', { style: { color: color || C.t2 }, children: text })
  return jsxs('div', { style: { marginTop: 10, padding: '8px 10px', borderRadius: 8, background: 'color-mix(in srgb, var(--ui-text-primary, #e6edf3) 4%, transparent)',
    border: `1px solid ${C.stroke}`, fontSize: 12, lineHeight: 1.55 }, children: [
    row(`${where}${g.last_commit ? ` · last commit ${ago(g.last_commit)}` : ''}`, C.t1),
    row(g.unpushed ? `${g.unpushed} commit${g.unpushed > 1 ? 's' : ''} on no remote: only here` : g.unpushed === 0 ? 'Every commit is on a remote' : 'Could not check remotes',
      g.unpushed ? C.red : g.unpushed === 0 ? C.green : C.t3),
    row(g.changed || g.untracked ? `${g.changed} changed · ${g.untracked} untracked` : 'No uncommitted changes', g.changed || g.untracked ? C.yellow : C.green),
    g.stashes ? row(`${g.stashes} stash${g.stashes > 1 ? 'es' : ''} in its main repo (not removed with it)`, C.t3) : null,
  ] })
}

// Ask a Bot to clear the marked list, disktree's "copy a prompt for a coding agent", but straight into
// Hermes chat as a draft. Paths come from folder names on disk, which anything can create: a name with
// shell or markdown syntax ($, `, ;, |, &, quotes, newlines) could turn into a command the Bot runs, so
// only plain names are listed, and only names without a space get a ready-made command.
// Each tool's own clean command, pointed at THIS folder (a bare `uv cache clean` would empty the global cache instead).
const CLEAN_HINT = { uv: (p) => `~/.hermes/bin/uv cache clean --cache-dir ${p}`, pip: (p) => `PIP_CACHE_DIR=${p} pip cache purge`,
  _cacache: (p) => `npm cache clean --force --cache ${p.replace(/\/_cacache$/, '')}` }
const PLAIN_PATH = /^[A-Za-z0-9_.~/@+ -]+$/
export function draftForBot(items) {
  const safe = items.filter((r) => PLAIN_PATH.test(r.path))
  const left = items.length - safe.length
  const lines = safe.map((r) => {
    const name = r.path.split('/').pop()
    const hint = r.kind === 'worktree' ? 'git worktree: use `git worktree remove` from its main repo, never if it holds work found nowhere else'
      : CLEAN_HINT[name] && !r.path.includes(' ') ? `the tool's own command, for this folder only: \`${CLEAN_HINT[name](r.path)}\`` : 'move it to the desktop trash'
    return `- ${r.path} (${fmt(r.bytes)}): ${r.reason}. How: ${hint}.`
  })
  return `Footprint found ${fmt(safe.reduce((a, r) => a + r.bytes, 0))} I want back on this machine. Free it by removing exactly these, and nothing else:\n\n${lines.join('\n')}\n\n` +
    'Before each one, check the path still exists and still is what the note says. For a git checkout, check for uncommitted changes, untracked files and commits that exist on no remote; if any, stop and ask me. ' +
    'Prefer a tool\'s own clean command; otherwise move to the trash (gio trash), never rm -rf. Never touch state.db, memories, skills, plugins, config, keys or the Hermes app. ' +
    'Show me the plan first and wait for my OK. Afterwards report what was removed and how much free space was gained.' +
    (left ? `\n\n(${left === 1 ? '1 item with an unusual name is' : `${left} items with unusual names are`} left out; use Footprint's own Trash for ${left === 1 ? 'it' : 'them'}.)` : '')
}
function handToBot(items) {
  const text = draftForBot(items)
  host.navigate('/')
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent(COMPOSER_INSERT, { detail: { mode: 'block', target: 'main', text } }))
    window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS, { detail: { target: 'main' } }))
  }, 250)
}

const PHASE = { walk: 'Scanning', sort: 'Sorting what it found', bots: "Reading your Bots' sessions", sizes: 'Measuring Bot folders', load: 'Loading results' }
function ScanProgress({ s }) {
  const p = s.progress || {}
  const frac = p.phase === 'walk' && p.expected_files ? Math.min(0.95, p.files / p.expected_files) * 0.8
    : p.phase === 'sort' ? 0.8 : p.phase === 'bots' ? 0.83 : p.phase === 'sizes' ? 0.85 + 0.07 * ((p.step || 0) / (p.steps || 1))
    : p.phase === 'load' ? 0.92 + 0.08 * ((p.step || 0) / (p.steps || 1)) : null
  const detail = p.phase === 'walk' ? `${(p.files || 0).toLocaleString()}${p.expected_files ? ` of ~${p.expected_files.toLocaleString()}` : ''} files${p.where ? ` · in ${p.where}` : ''}`
    : p.phase === 'sizes' ? `${p.step} of ${p.steps}${p.where ? ` · ${p.where}` : ''}` : p.phase === 'load' ? `part ${p.step} of ${p.steps}` : 'starting…'
  return jsxs('div', { style: { flex: 1, minWidth: 260, maxWidth: 520 }, children: [
    jsx('div', { style: { height: 8, borderRadius: 4, background: C.stroke, overflow: 'hidden' }, children: jsx('div', { style: {
      height: '100%', borderRadius: 4, background: C.accent, width: frac == null ? '30%' : `${Math.round(frac * 100)}%`, transition: 'width .6s ease',
      animation: frac == null ? 'fpPulse 1.2s ease-in-out infinite alternate' : 'none' } }) }),
    jsxs('div', { style: { display: 'flex', gap: 10, marginTop: 5, fontSize: 11.5, color: C.t3, alignItems: 'center' }, children: [
      jsx('span', { style: { color: C.t1 }, children: s.stopping ? 'Stopping…' : PHASE[p.phase] || 'Scanning' }),
      jsx('span', { style: { fontFamily: MONO }, children: detail }),
      p.phase !== 'load' ? jsx('button', { type: 'button', disabled: s.stopping, onClick: stopScan, style: btn({ marginLeft: 'auto', fontSize: 11, padding: '1px 9px' }), children: 'Stop' }) : null,
    ] }),
  ] })
}

function DiskBar({ disk, hermes, freeing }) {
  const pct = (b) => `${Math.max(0.4, (100 * b) / disk.total)}%`
  return jsxs('div', { style: { minWidth: 260, flex: 1, maxWidth: 520 }, children: [
    jsxs('div', { style: { display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: C.stroke }, children: [
      jsx('div', { style: { width: pct(disk.used - hermes), background: C.t4, opacity: 0.6 } }),
      jsx('div', { style: { width: pct(hermes - freeing), background: C.accent } }),
      freeing ? jsx('div', { style: { width: pct(freeing), background: `repeating-linear-gradient(135deg, ${C.green} 0 3px, transparent 3px 6px)` } }) : null,
    ] }),
    jsxs('div', { style: { display: 'flex', gap: 12, marginTop: 5, fontSize: 11, color: C.t3, fontFamily: MONO }, children: [
      jsx('span', { style: { color: C.accent }, children: `Hermes ${fmt(hermes)}` }),
      jsx('span', { children: `disk ${fmt(disk.used)} used` }),
      jsx('span', { style: { color: freeing ? C.green : C.t3 }, children: freeing ? `${fmt(disk.free)} → ${fmt(disk.free + freeing)} free` : `${fmt(disk.free)} free` }),
    ] }),
  ] })
}

function WorthALook({ items, marked, onToggle, onReview, onDeck, keptCount, onShowKept }) {
  const total = items.filter((r) => marked.has(r.path)).reduce((s, r) => s + r.bytes, 0)
  return jsxs('div', { style: { background: C.panel, border: `1px solid ${C.stroke}`, borderRadius: 10, padding: '10px 12px' }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center' }, children: [
      jsx('div', { style: label, children: `Worth a look · ${fmt(items.reduce((s, r) => s + r.bytes, 0))}` }),
      keptCount ? jsx('button', { type: 'button', onClick: onShowKept, style: { marginLeft: 'auto', background: 'none', border: 0, color: C.t3, fontSize: 11, cursor: 'pointer' }, children: `${keptCount} kept · show` }) : null,
    ] }),
    items.length ? jsx('button', { type: 'button', onClick: onDeck, style: btn({ width: '100%', margin: '8px 0 4px', padding: '8px 0', color: C.t1, background: 'color-mix(in srgb, var(--ui-accent, #4a84fe) 18%, transparent)', borderColor: C.accent }),
      children: `Review one by one · ${items.length} card${items.length > 1 ? 's' : ''}` }) : null,
    items.length ? items.map((r) => {
      const on = marked.has(r.path)
      return jsxs('label', { key: r.path, style: { display: 'flex', gap: 8, padding: '7px 0', borderBottom: `1px solid ${C.stroke}`, cursor: 'pointer', alignItems: 'flex-start' }, children: [
        jsx('input', { type: 'checkbox', checked: on, onChange: () => onToggle(r), style: { marginTop: 2, accentColor: 'var(--ui-red, #ff7b72)' } }),
        jsxs('div', { style: { minWidth: 0, flex: 1 }, children: [
          jsxs('div', { style: { display: 'flex', gap: 6 }, children: [
            jsx('span', { style: { width: 8, height: 8, borderRadius: 2, marginTop: 4, flex: 'none', background: kindCss(r.kind) } }),
            jsx('span', { style: { fontSize: 12, color: C.t1, wordBreak: 'break-all' }, children: r.path.replace('~/.hermes/', '') }),
            jsx('span', { style: { marginLeft: 'auto', fontSize: 11.5, color: C.t2, fontFamily: MONO, flex: 'none' }, children: fmt(r.bytes) }),
          ] }),
          jsx('div', { style: { fontSize: 11, color: /look first/.test(r.reason) ? C.yellow : C.t3, marginTop: 2 }, children: r.reason }),
          jsx('div', { style: { marginTop: 5 }, children: jsx(ActionRow, { item: r, compact: true }) }),
        ] }),
      ] })
    }) : jsx('div', { style: { fontSize: 12, color: C.green, padding: '8px 0' }, children: 'Nothing to reclaim. Hermes is tidy.' }),
    jsx('button', { type: 'button', disabled: !marked.size, onClick: onReview,
      style: btn({ marginTop: 10, width: '100%', padding: '7px 0', color: marked.size ? '#fff' : C.t4, background: marked.size ? C.red : 'transparent', border: marked.size ? 0 : `1px solid ${C.stroke}`, cursor: marked.size ? 'pointer' : 'default' }),
      children: marked.size ? `Review ${marked.size} · ${fmt(total)}` : 'Mark items to review' }),
    jsx('div', { style: { fontSize: 10.5, color: C.t4, marginTop: 6 }, children: 'Never offered: state.db, memories, skills, plugins, config, keys, cron, the Hermes app itself.' }),
  ] })
}

const TRASH_PHASE = { check: 'Checking', trash: 'Moving to Trash' }
function Review({ items, onCancel, onDone }) {
  const [busy, setBusy] = useState(false), [result, setResult] = useState(null), [err, setErr] = useState(null)
  const [stage, setStage] = useState(null)
  const total = items.reduce((s, r) => s + r.bytes, 0)
  const go = () => {
    setBusy(true); setErr(null); setStage({ phase: 'check', step: 0, steps: items.length })
    let live = true
    const poll = async () => { // the backend re-checks each path, then moves it; show which one it is on
      while (live) {
        await new Promise((r) => setTimeout(r, 900))
        if (!live) break
        try { const p = await runFootprint(['progress']); if (live && p && p.running && TRASH_PHASE[p.phase]) setStage(p) } catch { /* best effort */ }
      }
    }
    poll()
    runFootprint(['trash', ...items.map((r) => r.path)])
      .then((res) => { setResult(res); rescan() })
      .catch((e) => setErr(String(e && e.message || e)))
      .finally(() => { live = false; setBusy(false); setStage(null) })
  }
  return jsx('div', { style: { position: 'absolute', inset: 0, background: 'rgba(1,4,9,.86)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5 },
    children: jsxs('div', { style: { width: 'min(560px, 92%)', background: C.panel, border: `1px solid ${C.stroke}`, borderRadius: 12, padding: 18, boxShadow: '0 20px 60px rgba(0,0,0,.5)' }, children: [
      jsx('div', { style: { fontSize: 15, fontWeight: 600, color: C.t1 }, children: result ? 'Done' : `Move ${items.length} item${items.length > 1 ? 's' : ''} to the Trash?` }),
      jsx('div', { style: { fontSize: 12, color: C.t3, marginTop: 4 }, children: result
        ? `Freed ${fmt(result.freed_bytes)}. ${fmt(result.free_after)} free now. Restore anything from your file manager's Trash.`
        : `${fmt(total)} goes to your desktop Trash, not deleted. A fresh scan checks every path again first.` }),
      jsx('div', { style: { margin: '12px 0', maxHeight: 260, overflow: 'auto' }, children: (result ? result.results : items).map((r) => jsxs('div', {
        key: r.path, style: { display: 'flex', gap: 8, padding: '6px 0', borderBottom: `1px solid ${C.stroke}`, fontSize: 12 }, children: [
          jsx('span', { style: { color: result ? (r.ok ? C.green : C.yellow) : C.red, flex: 'none' }, children: result ? (r.ok ? '✓' : '–') : '→' }),
          jsxs('div', { style: { minWidth: 0, flex: 1 }, children: [
            jsx('div', { style: { color: C.t1, wordBreak: 'break-all' }, children: r.path }),
            !result && r.reason ? jsx('div', { style: { color: /look first/.test(r.reason) ? C.yellow : C.t3, fontSize: 11 }, children: r.reason }) : null,
            result && !r.ok ? jsx('div', { style: { color: C.yellow, fontSize: 11 }, children: r.why }) : null,
          ] }),
          jsx('span', { style: { fontFamily: MONO, color: C.t2, flex: 'none' }, children: fmt(r.bytes) }),
        ] })) }),
      err ? jsx('div', { style: { color: C.red, fontSize: 12, marginBottom: 8 }, children: err }) : null,
      busy && stage ? jsx('div', { style: { color: C.t2, fontSize: 12, marginBottom: 8, fontFamily: MONO },
        children: `${TRASH_PHASE[stage.phase] || 'Working'} ${stage.step || 0} of ${stage.steps || items.length}${stage.where ? ` · ${stage.where}` : ''}…` }) : null,
      jsxs('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' }, children: result
        ? [jsx('button', { type: 'button', onClick: onDone, style: btn({ color: C.t1 }), children: 'Close' }, 'c')]
        : [
          jsx('button', { type: 'button', onClick: () => { handToBot(items); onCancel() }, disabled: busy, style: btn({ marginRight: 'auto', color: C.t1 }),
            title: 'Draft a prompt in chat for a Bot to do it, checking each path first (not sent)', children: '✦ Hand to a Bot' }, 'bot'),
          jsx('button', { type: 'button', onClick: onCancel, disabled: busy, style: btn(), children: 'Cancel' }, 'x'),
          jsx('button', { type: 'button', onClick: go, disabled: busy, style: btn({ background: C.red, color: '#fff', border: 0 }), children: busy ? 'Working…' : `Move to Trash · ${fmt(total)}` }, 'go'),
        ] }),
    ] }) })
}

// A small, label-free treemap: the card's "art", drawn from the Bot's real folder.
function MiniMap({ node, w = 248, h = 92 }) {
  const ref = useRef(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    cv.width = w * dpr; cv.height = h * dpr
    const g = cv.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const bg = cssColor('--ui-bg-elevated', '#010409')
    g.fillStyle = bg; g.fillRect(0, 0, w, h)
    for (const t of layout(node, 0, 0, w, h, 0, 1, [])) {
      if (t.header) continue
      const col = kindColor(t.node.kind)
      g.globalAlpha = t.node.rest ? 0.18 : 0.55; g.fillStyle = col; g.fillRect(t.x + 0.5, t.y + 0.5, Math.max(0, t.w - 1), Math.max(0, t.h - 1))
      g.globalAlpha = 0.9; g.strokeStyle = bg; g.lineWidth = 1; g.strokeRect(t.x + 0.5, t.y + 0.5, Math.max(0, t.w - 1), Math.max(0, t.h - 1))
    }
    g.globalAlpha = 1
  }, [node, w, h])
  return jsx('canvas', { ref, style: { width: w, height: h, display: 'block', borderRadius: 6 } })
}

function biggest(n) {
  let best = null
  const go = (x) => { for (const c of x.children || []) { if (c.rest) continue; if (!c.children || c.reclaim) { if (!best || c.bytes > best.bytes) best = c } else go(c) } }
  go(n)
  return best
}

function BotCards({ root, bots, onOpen }) {
  const profiles = (root.children || []).find((c) => c.name === 'profiles' && !c.rest)
  const cards = profiles ? (profiles.children || []).filter((c) => !c.rest && !c.file) : []
  const folderCount = (bot) => bots.folders.filter((f) => f.exists && f.bots[bot]).length
  return jsx('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 12, marginBottom: 12 }, children: cards.map((c) => {
    const top = biggest(c)
    const can = []
    const walk = (x) => { if (x.reclaim) can.push(x); else (x.children || []).forEach(walk) }
    walk(c)
    const canBytes = can.reduce((a, x) => a + x.bytes, 0)
    const files = bots.files.by_bot[c.name] || 0, folders = folderCount(c.name)
    return jsx(CatalogCard, { key: c.name, icon: jsx(IconTile, { kind: 'bot' }), title: c.name, subtitle: `Bot · ${fmt(c.bytes)}`, label: "What's in it",
      bullets: [
        files || folders ? `Wrote ${files} file${files === 1 ? '' : 's'}, worked in ${folders} folder${folders === 1 ? '' : 's'}` : 'No files written outside Hermes',
        top ? `Biggest: ${top.path.replace(`profiles/${c.name}/`, '')} · ${fmt(top.bytes)}` : 'Nothing large',
      ],
      extra: jsx('div', { style: { marginTop: 8 }, children: jsx(MiniMap, { node: c, w: 220, h: 54 }) }),
      badge: canBytes ? { label: `${fmt(canBytes)} can go`, color: C.yellow } : { label: 'Nothing to clean', color: C.green },
      action: 'Open in treemap', onAction: () => onOpen(c) })
  }) })
}

function BotsView({ bots, root, onOpen }) {
  const f = bots.files
  const max = Math.max(1, ...Object.values(f.by_bot))
  const [showGone, setShowGone] = useState(false)
  const gone = bots.folders.filter((r) => !r.exists).length
  const folders = showGone ? bots.folders : bots.folders.filter((r) => r.exists)
  return jsxs('div', { style: { flex: 1, minHeight: 0, overflow: 'auto' }, children: [
    jsx(BotCards, { root, bots, onOpen }),
    jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 12 }, children: [
    jsxs('div', { style: { background: C.panel, border: `1px solid ${C.stroke}`, borderRadius: 10, padding: '10px 12px' }, children: [
      jsxs('div', { style: { display: 'flex', alignItems: 'center' }, children: [
        jsx('div', { style: label, children: `Folders your Bots worked in · ${bots.folders.length - gone}` }),
        gone ? jsx('button', { type: 'button', onClick: () => setShowGone((v) => !v), style: btn({ marginLeft: 'auto', fontSize: 11, padding: '2px 9px' }),
          children: showGone ? 'Hide removed' : `Show ${gone} removed` }) : null,
      ] }),
      jsxs('table', { style: { width: '100%', borderCollapse: 'collapse', marginTop: 6, fontSize: 12 }, children: [
        jsx('thead', { children: jsx('tr', { style: { color: C.t3, textAlign: 'left', fontSize: 11 }, children: ['Folder', 'Bots', 'Sessions', 'Files written', 'Size', 'Last'].map((h) => jsx('th', { style: { fontWeight: 500, padding: '4px 6px' }, children: h }, h)) }) }),
        jsx('tbody', { children: folders.map((r) => jsxs('tr', { style: { borderTop: `1px solid ${C.stroke}`, color: r.exists ? C.t2 : C.t4 }, children: [
          jsx('td', { style: { padding: '6px', color: r.exists ? C.t1 : C.t4, wordBreak: 'break-all' }, children: r.path + (r.exists ? '' : '  (gone)') }),
          jsx('td', { style: { padding: '6px' }, children: Object.entries(r.bots).map(([b, n]) => jsx('span', { title: `${n} session(s)`, style: { display: 'inline-block', fontSize: 10.5, padding: '1px 6px', margin: '1px 3px 1px 0', borderRadius: 9, border: `1px solid ${C.stroke}`, color: C.t2 }, children: b }, b)) }),
          jsx('td', { style: { padding: '6px', fontFamily: MONO }, children: r.sessions }),
          jsx('td', { style: { padding: '6px', fontFamily: MONO }, children: r.files_written ? `${r.files_still_there} of ${r.files_written}` : '—' }),
          jsx('td', { style: { padding: '6px', fontFamily: MONO }, children: r.exists ? (r.bytes == null ? 'large' : fmt(r.bytes)) : '—' }),
          jsx('td', { style: { padding: '6px', color: C.t3 }, children: ago(r.last) }),
        ] }, r.path)) }),
      ] }),
    ] }),
    jsxs('div', { style: { background: C.panel, border: `1px solid ${C.stroke}`, borderRadius: 10, padding: '10px 12px', alignSelf: 'start' }, children: [
      jsx('div', { style: label, children: 'Files your Bots wrote' }),
      jsx('div', { style: { fontSize: 28, color: C.t1, fontWeight: 600, marginTop: 6 }, children: f.written.toLocaleString() }),
      jsx('div', { style: { fontSize: 12, color: C.t3 }, children: `${f.still_there} still there (${fmt(f.bytes)}) · ${f.gone} since removed` }),
      jsx('div', { style: { marginTop: 12 }, children: Object.entries(f.by_bot).map(([b, n]) => jsxs('div', { key: b, style: { display: 'flex', alignItems: 'center', gap: 8, margin: '5px 0', fontSize: 12 }, children: [
        jsx('span', { style: { width: 64, color: C.t2 }, children: b }),
        jsx('div', { style: { flex: 1, height: 6, background: C.stroke, borderRadius: 3 }, children: jsx('div', { style: { width: `${(100 * n) / max}%`, height: '100%', borderRadius: 3, background: C.accent } }) }),
        jsx('span', { style: { width: 32, textAlign: 'right', fontFamily: MONO, color: C.t2 }, children: n }),
      ] })) }),
      jsx('div', { style: { fontSize: 10.5, color: C.t4, marginTop: 10 }, children: 'From each Bot\'s own sessions: the folder it started in and every write_file / patch. Shown for knowing, never offered for removal.' }),
    ] }),
  ] }),
  ] })
}

function FootprintPage() {
  const s = useFootprint()
  const [tab, setTab] = useState('hermes')
  const [zoom, setZoom] = useState('')
  const [marked, setMarked] = useState(() => new Set())
  const [review, setReview] = useState(false)
  const [deck, setDeck] = useState(false)
  const [kept, setKept] = useState(loadKept)
  const [showKept, setShowKept] = useState(false)
  const d = s.data
  const root = useMemo(() => d ? withFullPaths(d.hermes, '~/.hermes') : null, [d])
  const totals = useMemo(() => root ? Object.entries(kindTotals(root)).sort((a, b) => b[1] - a[1]) : [], [root])
  useEffect(() => { // a fresh scan drops marks that are no longer offered
    if (!d) return
    const ok = new Set(d.reclaimable.map((r) => r.path))
    setMarked((m) => new Set([...m].filter((p) => ok.has(p))))
  }, [d])

  const toggle = (r) => setMarked((m) => { const n = new Set(m); const p = r.fullPath || r.path; n.has(p) ? n.delete(p) : n.add(p); return n })
  const head = jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', marginBottom: 12 }, children: [
    jsxs('div', { children: [
      jsx('div', { style: { fontSize: 18, fontWeight: 600, color: C.t1 }, children: 'Footprint' }),
      jsx('div', { style: { fontSize: 12, color: C.t3 }, children: d ? `${d.files_scanned.toLocaleString()} files · scanned in ${d.scan_seconds}s` : '' }),
    ] }),
    s.inflight ? jsx(ScanProgress, { s }) : d ? jsx(DiskBar, { disk: d.disk, hermes: d.hermes.bytes, freeing: d.reclaimable.filter((r) => marked.has(r.path)).reduce((a, r) => a + r.bytes, 0) }) : null,
    s.stopped && !s.inflight ? jsx('span', { style: { fontSize: 12, color: C.t3 }, children: d ? 'Scan stopped; showing the last one.' : 'Scan stopped.' }) : null,
    jsx('button', { type: 'button', onClick: () => rescan(), disabled: !!s.inflight, style: btn({ marginLeft: 'auto' }), children: s.inflight ? 'Scanning…' : 'Rescan' }),
  ] })
  if (!d) {
    return jsxs('div', { style: { padding: '16px 22px', height: '100%', overflow: 'auto' }, children: [head,
      s.error ? jsx('div', { style: { color: C.red, fontSize: 12.5 }, children: `Could not read your footprint: ${s.error}` }) : null,
      s.error ? jsx('div', { style: { color: C.t3, fontSize: 12, marginTop: 8, fontFamily: MONO }, children: 'Fix: hermes plugins enable hermes-footprint   (then restart Hermes Desktop; use -p <profile> for the Bot Desktop is using)' }) : null] })
  }
  const open = d.reclaimable.filter((r) => !kept.has(r.path))
  const trail = findPath(root, zoom)
  const here = trail[trail.length - 1]
  const tabBtn = (id, text) => jsx('button', { type: 'button', onClick: () => setTab(id),
    style: btn({ color: tab === id ? C.t1 : C.t3, background: tab === id ? 'color-mix(in srgb, var(--ui-accent, #4a84fe) 16%, transparent)' : 'transparent', borderColor: tab === id ? C.accent : 'transparent' }), children: text }, id)

  return jsxs('div', { style: { position: 'relative', padding: '14px 22px 16px', height: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }, children: [
    head,
    jsxs('div', { style: { display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center' }, children: [
      tabBtn('hermes', `Hermes itself · ${fmt(d.hermes.bytes)}`),
      tabBtn('cards', `Can go · ${open.length}${d.reclaimable.length > open.length ? ` · ${d.reclaimable.length - open.length} kept` : ''}`),
      tabBtn('bots', `Made by your Bots · ${d.bots.files.written} files`),
      tab === 'hermes' ? jsx('div', { style: { marginLeft: 12, fontSize: 12, color: C.t3, display: 'flex', gap: 4, flexWrap: 'wrap' }, children: trail.map((n, i) => jsxs('span', { key: n.fullPath, children: [
        i ? ' / ' : '',
        jsx('button', { type: 'button', onClick: () => setZoom(n.path), style: { background: 'none', border: 0, padding: 0, cursor: 'pointer', color: i === trail.length - 1 ? C.t1 : C.accent, fontSize: 12 }, children: n.name }),
      ] })) }) : null,
    ] }),
    tab === 'cards' ? jsx(CardsView, { items: showKept ? d.reclaimable : open, marked, onToggle: toggle, keptCount: d.reclaimable.length - open.length,
      onShowKept: () => setShowKept((v) => !v), onReview: (i) => setDeck({ start: i }), onTrashMarked: () => setReview(true) }) :
    tab === 'bots' ? jsx(BotsView, { bots: d.bots, root, onOpen: (n) => { setZoom(n.path); setTab('hermes') } }) : jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 12, flex: 1, minHeight: 0 }, children: [
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0 }, children: [
        jsx(Treemap, { root: here, marked, onOpen: (n) => setZoom(n.path), onToggle: toggle }),
        jsx('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 8, fontSize: 11, color: C.t3 }, children: [
          ...totals.map(([k, b]) => jsxs('span', { key: k, style: { display: 'inline-flex', alignItems: 'center', gap: 5 }, children: [
            jsx('span', { style: { width: 9, height: 9, borderRadius: 2, background: kindCss(k), opacity: 0.85 } }),
            `${d.kinds[k] || k} `, jsx('span', { style: { fontFamily: MONO, color: C.t2 }, children: fmt(b) }),
          ] })),
          jsxs('span', { key: 'hatch', style: { display: 'inline-flex', alignItems: 'center', gap: 5 }, children: [
            jsx('span', { style: { width: 9, height: 9, borderRadius: 2, background: `repeating-linear-gradient(135deg, ${C.t2} 0 1.5px, transparent 1.5px 4px)` } }), 'hatched = can go',
          ] }),
        ] }),
      ] }),
      jsx('div', { style: { overflow: 'auto', minHeight: 0 }, children: jsx(WorthALook, { items: showKept ? d.reclaimable : open, marked, onToggle: toggle, onReview: () => setReview(true),
        onDeck: () => setDeck({ start: 0 }), keptCount: d.reclaimable.length - open.length, onShowKept: () => setShowKept((v) => !v) }) }),
    ] }),
    deck ? jsx(Deck, { items: showKept ? d.reclaimable : open, start: deck.start || 0, onCancel: () => setDeck(false), onDone: (trash, keep) => {
      const k = new Set(kept); keep.forEach((x) => k.add(x.path)); setKept(k); saveKept(k)
      setMarked((m) => { const n = new Set(m); trash.forEach((x) => n.add(x.path)); keep.forEach((x) => n.delete(x.path)); return n }); setDeck(false); if (trash.length) setReview(true)
    } }) : null,
    jsx('style', { children: '@keyframes fpPulse{from{opacity:.35}to{opacity:1}}@keyframes fpIn{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}' }),
    review ? jsx(Review, { items: d.reclaimable.filter((r) => marked.has(r.path)), onCancel: () => setReview(false), onDone: () => { setReview(false); setMarked(new Set()) } }) : null,
  ] })
}

function StatusChip() {
  const s = useFootprint()
  const d = s.data
  if (!d) return null
  const r = d.reclaimable_bytes
  return jsx('button', {
    type: 'button', title: 'Open Footprint', onClick: () => host.navigate(ROUTE),
    style: { background: 'transparent', border: 0, cursor: 'pointer', padding: '0 6px', fontSize: 11, color: r > 1e9 ? C.yellow : C.t3, fontFamily: MONO },
    children: `▦ Hermes ${fmt(d.hermes.bytes)}${r > 1e8 ? ` · ${fmt(r)} can go` : ''}`,
  })
}

export default {
  id: ID,
  name: 'Footprint',
  register(ctx) {
    pluginCtx = ctx
    ctx.register({ id: 'page', area: ROUTES_AREA, data: { path: ROUTE }, render: () => jsx(FootprintPage, {}) })
    ctx.register({ id: 'nav', area: SIDEBAR_NAV_AREA, order: 87, data: { path: ROUTE, label: 'Footprint', codicon: 'database' } })
    ctx.register({ id: 'open', area: PALETTE_AREA, data: { id: `${ID}.open`, label: 'Open Footprint', keywords: ['footprint', 'disk', 'storage', 'space', 'cleanup', 'treemap'], run: () => host.navigate(ROUTE) } })
    ctx.register({ id: 'statusbar', area: STATUSBAR_AREAS.right, order: 132, render: () => jsx(StatusChip, {}) })
  },
}
