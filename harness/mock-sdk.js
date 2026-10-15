// Test harness only: mimics the parts of @hermes/plugin-sdk that hermes-footprint uses.
// "trash" is answered with a canned result here; the harness never touches the disk.
import payload from './payload.js'
export const ROUTES_AREA = 'routes', SIDEBAR_NAV_AREA = 'sidebar.nav', PALETTE_AREA = 'palette', STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' }
export { payload }
export function trashResult(paths) {
  const results = paths.map((p) => ({ path: p, ok: true, bytes: (payload.reclaimable.find((r) => r.path === p) || {}).bytes || 0, why: null }))
  const freed = results.reduce((s, r) => s + r.bytes, 0)
  return { results, freed_bytes: freed, free_after: payload.disk.free + freed }
}
export function progressObj() {
  const t = (Date.now() - (window.__scanStart || Date.now())) / 1000
  return { running: true, phase: t < 3 ? 'walk' : 'sizes', files: Math.round(t * 160000), where: t < 1.5 ? 'hermes-agent' : 'installs', expected_files: 494823, step: 4, steps: 13 }
}
export const host = {
  state: { focusedSessionOwner: { get: () => null } },
  navigate: (p) => console.log('navigate', p),
  profileRoutes: async () => [{ connectionId: 'local', mode: 'local', primary: true, profile: 'ceo', targetProfile: 'ceo' }],
  requestProfile: async (route, method, params) => {
    window.__calls = (window.__calls || []).concat([{ method, argv: params.argv }])
    if (params.argv.includes('progress')) {
      const t = (Date.now() - (window.__scanStart || Date.now())) / 1000
      return { code: 0, output: JSON.stringify({ running: true, phase: t < 3 ? 'walk' : 'sizes', files: Math.round(t * 160000), where: t < 1.5 ? 'hermes-agent' : 'installs', expected_files: 494823, step: 4, steps: 13 }) }
    }
    if (params.argv.includes('stop')) return { code: 0, output: '{"ok":true}' }
    if (params.argv.includes('open')) return { code: 0, output: JSON.stringify({ ok: true, path: params.argv[params.argv.indexOf('open') + 1] }) }
    const i = params.argv.indexOf('trash')
    if (i >= 0) {
      const paths = params.argv.slice(i + 1, -1)
      const results = paths.map((p) => ({ path: p, ok: true, bytes: (payload.reclaimable.find((r) => r.path === p) || {}).bytes || 0, why: null }))
      const freed = results.reduce((s, r) => s + r.bytes, 0)
      return { code: 0, output: JSON.stringify({ results, freed_bytes: freed, free_after: payload.disk.free + freed }) }
    }
    if (!params.argv.includes('part') && new URLSearchParams(location.search).get('slow')) { window.__scanStart = Date.now(); await new Promise((r) => setTimeout(r, 6000)) }
    // Same protocol and the same 48,000-character cap as the real cli.exec.
    const bytes = new TextEncoder().encode(JSON.stringify(payload)), PART = 30000
    const parts = Math.max(1, Math.ceil(bytes.length / PART))
    const j = params.argv.indexOf('part'), n = j >= 0 ? Number(params.argv[j + 1]) : 0
    let bin = ''
    for (const b of bytes.subarray(n * PART, (n + 1) * PART)) bin += String.fromCharCode(b)
    const out = 'some log line\n' + JSON.stringify({ id: 'mock', part: n, parts, data: btoa(bin) })
    return { code: 0, output: out.slice(0, 48000) }
  },
}
