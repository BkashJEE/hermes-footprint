"""hermes-footprint: what Hermes Agent has left on your disk, inside Hermes Desktop.

Registers:
  * ``hermes footprint`` CLI command (``--json`` for the desktop page, ``trash PATH...`` to move
    reviewed, reclaimable paths to the desktop trash);
  * ``/footprint`` slash command with a text summary.

The desktop UI lives in ``desktop/plugin.js`` and reads data by running
``hermes footprint --json`` through the gateway's ``cli.exec`` RPC.
"""

from __future__ import annotations

from . import commands


def register(ctx) -> None:
    ctx.register_command(
        "footprint",
        handler=commands.slash_command,
        description="How much disk Hermes uses and what can go (hermes-footprint)",
        args_hint="",
    )
    ctx.register_cli_command(
        name="footprint",
        help="Disk used by Hermes and your Bots, and what is safe to reclaim (hermes-footprint plugin)",
        setup_fn=commands.setup_argparse,
        handler_fn=commands.handle_cli,
    )
