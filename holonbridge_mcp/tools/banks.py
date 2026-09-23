"""Bank listing and override tools.

Same qualified-``session``-access reasoning as ``tools/datasets.py`` --
see that module's and ``session.py``'s docstrings, including the
2026-09-23 change from one override per process to one per caller
identity.
"""

from __future__ import annotations

from .. import session
from ..session import mcp, _call


@mcp.tool()
async def list_banks() -> dict:
    """List the banks the bridge has configured, and which one this process uses.

    A *bank* is a named backend connection — a server URL, a default dataset,
    and optional credentials. Formerly called a "profile".

    ``active`` in the bridge's own response is the bank the *bridge* treats as
    current. ``bankOverride`` is your own per-call override — since
    2026-09-23 this is scoped to your own identity, not this MCP process as a
    whole: it takes precedence for every call you make, and changes nothing
    for anyone else reaching the same running process under a different
    identity. (Before that change this claim was aspirational rather than
    true — the override was a single value every caller through the process
    shared, so one person's switch was visible, and applied, to everyone.)
    """
    result = await _call("GET", "/endpoints")
    if isinstance(result, dict) and not result.get("error"):
        result["bankOverride"] = session.current_bank_override()
        result["bankOverrideSource"] = session.current_bank_override_source()
    return result


@mcp.tool()
async def switch_bank(name: str) -> dict:
    """Point every subsequent call *you* make from this process at a different bank.

    Validates first: switching to a bank the bridge has not configured would
    otherwise produce 404s, or worse, silently fall through to the wrong
    store. Applied as ``?bank=`` on every following request you make, so it
    needs no restart and no second bridge process.

    Different from ``set_endpoint``, deliberately. ``set_endpoint`` changes
    the bridge's *own* active bank, which every client then sees; this
    changes only what your own calls ask for, leaving every other caller —
    including someone else reaching this same process under their own
    identity — alone. Prefer this one unless the intent really is to move
    the whole bridge for everyone.

    Persisted to disk under your own identity, on the same reasoning as
    ``switch_dataset``: a process restart restores your choice rather than
    silently reverting, because a call that reaches the wrong store still
    succeeds and still returns data. An explicit ``HOLONBRIDGE_BANK`` env var
    still wins, for every identity alike, on the next restart.

    Pass an empty string to clear your own override and fall back to
    whatever the bridge considers active. Clearing removes your persisted
    file too.
    """
    if not name.strip():
        session.set_bank_override("", "none")
        endpoint = await _call("GET", "/endpoint")
        return {
            "ok": True,
            "cleared": True,
            "bank": endpoint.get("bank") if isinstance(endpoint, dict) else None,
            "note": "override cleared; using the bridge's active bank",
        }

    wanted = name.strip()
    listing = await _call("GET", "/endpoints")
    if isinstance(listing, dict) and listing.get("error"):
        return {
            "ok": False,
            "requested": wanted,
            "detail": listing.get("detail"),
            "note": "bank not switched; could not read the bank list",
        }

    known = [
        b.get("name")
        for b in (listing.get("banks") or [])
        if isinstance(b, dict)
    ]
    if wanted not in known:
        return {
            "ok": False,
            "requested": wanted,
            "known": known,
            "note": "bank not switched; no bank by that name is configured",
        }

    session.set_bank_override(wanted, "explicit")
    return {"ok": True, "bank": wanted, "known": known}
