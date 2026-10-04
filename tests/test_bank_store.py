"""``BankStore`` reading ``config.json``, including the legacy ``profiles`` key.

A *bank* is a named backend connection -- a server URL, a default dataset, and
optional credentials -- previously called a "profile". Existing configs must
keep working across the rename without being edited.

This file used to be ``test_bank_persistence.py`` and also covered the MCP-layer
bank override. That half moved to ``test_mcp_overrides.py`` when the override
became per-identity (see its docstring); only the config-loading tests remain.
"""

from __future__ import annotations

import json

from holonbridge.config import BankStore, Settings


def _store(tmp_path, payload) -> BankStore:
    path = tmp_path / "config.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return BankStore(Settings(config_path=path))


def test_banks_key_is_read(tmp_path):
    store = _store(
        tmp_path,
        {"default": "ggsc", "banks": {"ggsc": {"url": "https://x", "dataset": "ggsc"}}},
    )
    assert store.active.name == "ggsc"
    assert store.get("ggsc").dataset == "ggsc"


def test_the_legacy_profiles_key_still_works(tmp_path, caplog):
    """Existing configs must survive the rename un-edited -- and say so once."""
    store = _store(
        tmp_path,
        {"default": "ggsc", "profiles": {"ggsc": {"url": "https://x", "dataset": "ggsc"}}},
    )
    assert store.active.name == "ggsc"
    assert any("legacy 'profiles' key" in r.getMessage() for r in caplog.records)


def test_banks_wins_when_both_keys_are_present(tmp_path):
    """An operator mid-migration should get the new key, not a merge or a
    coin toss."""
    store = _store(
        tmp_path,
        {
            "default": "new",
            "banks": {"new": {"url": "https://new", "dataset": "n"}},
            "profiles": {"old": {"url": "https://old", "dataset": "o"}},
        },
    )
    assert store.active.name == "new"
    assert [b["name"] for b in store.list()] == ["local", "new"]


def test_a_local_bank_always_exists(tmp_path):
    """The bridge must start cleanly with no config file present."""
    store = BankStore(Settings(config_path=tmp_path / "absent.json"))
    assert store.active.name == "local"


def test_the_public_view_never_leaks_a_token(tmp_path):
    store = _store(
        tmp_path,
        {
            "default": "ggsc",
            "banks": {
                "ggsc": {
                    "url": "https://x",
                    "dataset": "ggsc",
                    "auth": {"type": "bearer", "token": "SECRET"},
                }
            },
        },
    )
    public = store.get("ggsc").as_public()
    assert public["authenticated"] is True
    assert "SECRET" not in json.dumps(public)
