"""Dataset listing and override tools.

Both tools here read or write the calling identity's own dataset override
via ``session.current_dataset_override()`` / ``session.set_dataset_override()``
-- never the raw ``session._dataset_overrides`` dict directly -- so this
module imports ``session`` itself (qualified access), not just
``mcp``/``_call``. See ``session.py``'s own docstring for why a plain name
import would go stale, and for the 2026-09-23 change from one override per
process to one per caller identity.
"""

from __future__ import annotations

from .. import session
from ..session import mcp, _call


@mcp.tool()
async def list_datasets() -> dict:
    """List the datasets the backend actually hosts.

    Different question from ``list_banks``, which reports the bridge's
    configured banks. A bank names a dataset it expects; this says what is
    really there. ``active`` marks the one *your own* calls are currently
    going to -- since 2026-09-23 this is your own dataset override, not a
    single value every caller through this process shares; a colleague
    calling this at the same moment can correctly see a different
    ``active`` if they've switched to a different dataset themselves.
    """
    result = await _call("GET", "/datasets")
    if isinstance(result, dict) and not result.get("error"):
        result["active"] = session.current_dataset_override() or result.get("active")
        result["datasetOverrideSource"] = session.current_dataset_override_source()
    return result


@mcp.tool()
async def switch_dataset(name: str) -> dict:
    """Point every subsequent call *you* make at a different dataset.

    Validates first: switching to a name the server does not host would
    otherwise produce empty reads that look exactly like empty data, which is
    a slow way to find a typo. Sets ``X-Dataset-Override`` on every following
    request you make, so it needs no restart and no second bridge process.

    Scoped to your own identity, not to this process as a whole -- since
    2026-09-23, a colleague reaching the same running holonbridge-mcp
    process under their own identity is completely unaffected by this call,
    and this call is unaffected by theirs. Before that change this override
    was a single value shared by every caller through the same process,
    which meant one person's switch silently moved the ground under
    everyone else's very next call.

    Persisted to disk under your own identity, not held only in memory — a
    process restart restores your choice instead of silently falling back
    to whatever ``HOLONBRIDGE_DATASET`` (or nothing) says, which is exactly
    the failure that motivated this. An explicit ``HOLONBRIDGE_DATASET`` env
    var still wins over any persisted value, for every identity alike, on
    the *next* restart, the same as every other setting in this codebase —
    persistence is a convenience for the ordinary case, not a way to
    override a deliberate operator-level pin.

    Pass an empty string to clear your own override and fall back to the
    active bank's own dataset. Clearing also removes your persisted file, so
    a restart after clearing starts genuinely fresh rather than restoring
    the just-cleared value.
    """
    if not name.strip():
        session.set_dataset_override("", "none")
        endpoint = await _call("GET", "/endpoint")
        return {
            "ok": True,
            "cleared": True,
            "dataset": endpoint.get("dataset") if isinstance(endpoint, dict) else None,
            "note": "override cleared; using the active bank's dataset",
        }

    check = await _call("GET", f"/datasets/{name.strip()}")
    if isinstance(check, dict) and check.get("error"):
        return {
            "ok": False,
            "requested": name,
            "detail": check.get("detail"),
            "note": "dataset not switched",
        }

    session.set_dataset_override(name.strip(), "explicit")
    return {
        "ok": True,
        "dataset": name.strip(),
        "graphs": check.get("graphs") if isinstance(check, dict) else None,
    }
