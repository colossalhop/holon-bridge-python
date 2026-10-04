"""Command-line entry point for holonbridge-mcp.

    python -m holonbridge_mcp                     # stdio, for Claude Desktop
    python -m holonbridge_mcp --transport sse     # remote, legacy HTTP+SSE at /sse
    python -m holonbridge_mcp --transport http    # remote, Streamable HTTP at /mcp
    python -m holonbridge_mcp --transport both    # remote, /sse and /mcp together

``python -m holonbridge_mcp.server`` still runs stdio directly, so existing
client configurations keep working unchanged.

stdio is a child process the client launches, so nothing else can reach it.
The remote transports are reachable by anyone who can reach the URL and carry
the bridge's own bearer token, so they require an inbound token of their own —
see :mod:`holonbridge_mcp.remote`.

HTTP+SSE is deprecated in the MCP spec. ``both`` exists so a deployment can
move its connectors to ``/mcp`` one at a time without a coordinated cutover;
once none still use ``/sse``, switch to ``http``.
"""

from __future__ import annotations

import argparse
import os

from .server import mcp


def main() -> None:
    parser = argparse.ArgumentParser(prog="holonbridge-mcp")
    parser.add_argument(
        "--transport",
        default=os.getenv("MCP_TRANSPORT", "stdio"),
        choices=("stdio", "sse", "http", "streamable-http", "both"),
        help=(
            "stdio for a locally launched client; sse (/sse), http (/mcp, also "
            "spelled streamable-http) or both (/sse and /mcp) to serve over a URL"
        ),
    )
    parser.add_argument("--host", default=os.getenv("MCP_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("MCP_PORT", "3032")))
    args = parser.parse_args()

    if args.transport == "stdio":
        mcp.run(transport="stdio")
        return

    from .remote import serve

    serve(mcp, transport=args.transport, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
