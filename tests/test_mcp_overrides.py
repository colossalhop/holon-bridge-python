"""Per-identity dataset and bank overrides in ``holonbridge_mcp.session``.

Replaces ``test_dataset_persistence.py`` and the MCP half of
``test_bank_persistence.py``, which were written for the original design: one
module-level string per process (``server._bank_override``,
``server._resolve_initial_bank()``, ``server._persist_bank(name)``). That state
moved to ``session.py`` on 2026-08-28, and on 2026-09-23 became one value per
caller identity, keyed by ``identity.current_github_login``, so two people
sharing a running process no longer see each other's ``switch_dataset``.

The behaviours the old tests pinned still hold and are kept here:

- an explicit env var beats a persisted file
- persisting an empty name clears the file
- a persist failure never raises
- a missing file reads as "no override", not an error
- a caller-supplied ``?bank=`` beats the session default, and merging keeps
  every other query parameter

What is new, and had no test before: identities are isolated from each other,
each gets its own state file, ``None`` (the shared-token mode) keeps using the
original un-suffixed file, and an env pin applies to every identity.

Dataset and bank state are structurally identical, so the shared behaviours are
parametrised over both. Every test redirects the state file into ``tmp_path``
and empties the in-memory caches, so nothing touches ``~/.holonbridge``.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass

import pytest

from holonbridge_mcp import session
from holonbridge_mcp.identity import current_github_login


@contextmanager
def as_login(login: str | None):
    """Run a block as one caller identity (``None`` = shared-token caller)."""
    token = current_github_login.set(login)
    try:
        yield
    finally:
        current_github_login.reset(token)


@dataclass
class Kind:
    """Uniform handle on the dataset or the bank flavour of the override."""

    name: str

    def current(self) -> str:
        return getattr(session, f"current_{self.name}_override")()

    def source(self) -> str:
        return getattr(session, f"current_{self.name}_override_source")()

    def set(self, value: str, source: str = "explicit") -> None:
        getattr(session, f"set_{self.name}_override")(value, source)

    def file_for(self, login: str | None):
        return getattr(session, f"_{self.name}_state_file_for")(login)

    def persist(self, login: str | None, value: str) -> None:
        getattr(session, f"_persist_{self.name}")(login, value)

    def forget_cached(self, monkeypatch) -> None:
        """Drop the in-memory cache, as a process restart would."""
        monkeypatch.setattr(session, f"_{self.name}_overrides", {})
        monkeypatch.setattr(session, f"_{self.name}_override_sources", {})

    def pin_env(self, monkeypatch, value: str) -> None:
        monkeypatch.setattr(session, f"_ENV_{self.name.upper()}", value)


def _isolate(name: str, monkeypatch, tmp_path) -> Kind:
    kind = Kind(name)
    monkeypatch.setattr(session, f"_{name.upper()}_STATE_FILE", tmp_path / f"mcp-{name}-override")
    monkeypatch.setattr(session, f"_ENV_{name.upper()}", "")
    kind.forget_cached(monkeypatch)
    return kind


@pytest.fixture(params=["dataset", "bank"])
def kind(request, monkeypatch, tmp_path) -> Kind:
    return _isolate(request.param, monkeypatch, tmp_path)


@pytest.fixture
def bank(monkeypatch, tmp_path) -> Kind:
    return _isolate("bank", monkeypatch, tmp_path)


@pytest.fixture
def dataset(monkeypatch, tmp_path) -> Kind:
    return _isolate("dataset", monkeypatch, tmp_path)


# --- resolution and persistence (the behaviours the old tests pinned) ---------


def test_with_nothing_set_the_override_is_empty(kind):
    with as_login(None):
        assert kind.current() == ""
        assert kind.source() == "none"


def test_a_persisted_value_is_restored(kind):
    """The core behaviour: what a process restart does instead of reverting."""
    path = kind.file_for(None)
    path.write_text("ggsc", encoding="utf-8")
    with as_login(None):
        assert kind.current() == "ggsc"
        assert kind.source() == "persisted"


def test_an_explicit_env_var_beats_a_persisted_value(kind, monkeypatch):
    """A real env var is a deliberate pin and must win over a stale file."""
    kind.file_for(None).write_text("ggsc", encoding="utf-8")
    kind.pin_env(monkeypatch, "bridgerton")
    with as_login(None):
        assert kind.current() == "bridgerton"
        assert kind.source() == "env"


def test_setting_persists_and_clearing_removes_the_file(kind, monkeypatch):
    path = kind.file_for(None)
    with as_login(None):
        kind.set("ggsc")
        assert path.read_text(encoding="utf-8") == "ggsc"

        kind.set("")
        assert not path.exists()

    # and a restart finds nothing to restore
    kind.forget_cached(monkeypatch)
    with as_login(None):
        assert (kind.current(), kind.source()) == ("", "none")


def test_persist_then_restart_round_trips(kind, monkeypatch):
    with as_login(None):
        kind.set("ggsc")
    kind.forget_cached(monkeypatch)
    with as_login(None):
        assert kind.current() == "ggsc"
        assert kind.source() == "persisted"


def test_a_missing_state_file_reads_as_empty_not_an_error(kind):
    assert not kind.file_for(None).exists()
    with as_login(None):
        assert kind.current() == ""


def test_persisting_creates_parent_directories(kind, monkeypatch, tmp_path):
    nested = tmp_path / "a" / "b" / f"mcp-{kind.name}-override"
    monkeypatch.setattr(session, f"_{kind.name.upper()}_STATE_FILE", nested)
    with as_login(None):
        kind.set("ggsc")
    assert nested.read_text(encoding="utf-8") == "ggsc"


def test_a_persist_failure_does_not_raise(kind, monkeypatch, tmp_path):
    """Best-effort by design: a disk problem must not break the live switch."""
    path = tmp_path / "unwritable" / f"mcp-{kind.name}-override"
    monkeypatch.setattr(session, f"_{kind.name.upper()}_STATE_FILE", path)

    def boom(*args, **kwargs):
        raise OSError("no")

    monkeypatch.setattr(type(path), "mkdir", boom)
    with as_login(None):
        kind.set("ggsc")  # must not raise
        assert kind.current() == "ggsc"  # still in effect for this session
    assert not path.exists()


# --- per-identity behaviour (new in the 2026-09-23 change) --------------------


def test_a_named_login_gets_its_own_suffixed_file(kind):
    with as_login("alice"):
        kind.set("one")
    assert kind.file_for("alice").read_text(encoding="utf-8") == "one"
    assert kind.file_for("alice") != kind.file_for(None)
    assert not kind.file_for(None).exists()


def test_identities_do_not_see_each_others_override(kind):
    with as_login("alice"):
        kind.set("one")
    with as_login("bob"):
        kind.set("two")

    with as_login("alice"):
        assert kind.current() == "one"
    with as_login("bob"):
        assert kind.current() == "two"
    with as_login(None):
        assert kind.current() == ""


def test_clearing_one_identity_leaves_the_other_alone(kind):
    with as_login("alice"):
        kind.set("one")
    with as_login("bob"):
        kind.set("two")
    with as_login("alice"):
        kind.set("")

    assert not kind.file_for("alice").exists()
    with as_login("bob"):
        assert kind.current() == "two"


def test_a_restart_restores_each_identity_from_its_own_file(kind, monkeypatch):
    kind.file_for("alice").write_text("one", encoding="utf-8")
    with as_login("alice"):
        assert (kind.current(), kind.source()) == ("one", "persisted")
    with as_login("bob"):
        assert (kind.current(), kind.source()) == ("", "none")


def test_an_env_pin_applies_to_every_identity(kind, monkeypatch):
    """The env var is an operator-level pin, deliberately not keyed by login."""
    kind.file_for("alice").write_text("personal", encoding="utf-8")
    kind.pin_env(monkeypatch, "pinned")
    for login in ("alice", "bob", None):
        with as_login(login):
            assert (kind.current(), kind.source()) == ("pinned", "env")


def test_a_login_cannot_escape_the_state_directory(kind):
    path = kind.file_for("../../evil")
    assert path.parent == kind.file_for(None).parent
    assert "/" not in path.name and "\\" not in path.name


def test_safe_filename_component_replaces_separators():
    cleaned = session._safe_filename_component("a/b\\c:d")
    assert cleaned == "a_b_c_d"


# --- ?bank= merging -------------------------------------------------------------


def test_no_bank_override_leaves_params_untouched(bank):
    with as_login(None):
        assert session._with_bank(None) is None
        assert session._with_bank({"limit": 5}) == {"limit": 5}


def test_the_bank_override_is_applied_as_a_query_param(bank):
    with as_login(None):
        bank.set("ggsc")
        assert session._with_bank(None) == {"bank": "ggsc"}


def test_caller_params_are_preserved_alongside_the_bank(bank):
    """Regression guard: replacing rather than merging would silently drop
    every other query parameter on the call."""
    with as_login(None):
        bank.set("ggsc")
        assert session._with_bank({"limit": 5}) == {"limit": 5, "bank": "ggsc"}


def test_an_explicit_caller_bank_wins_over_the_session_default(bank):
    with as_login(None):
        bank.set("ggsc")
        assert session._with_bank({"bank": "chosen"}) == {"bank": "chosen"}


def test_the_bank_param_is_per_identity(bank):
    with as_login("alice"):
        bank.set("ggsc")
    with as_login("alice"):
        assert session._with_bank(None) == {"bank": "ggsc"}
    with as_login("bob"):
        assert session._with_bank(None) is None


# --- request headers ---------------------------------------------------------------


def test_bank_and_dataset_overrides_are_independent(bank, dataset):
    """They travel by different channels -- bank as a query param, dataset as a
    header -- and neither switch may disturb the other."""
    with as_login(None):
        bank.set("ggsc")
        dataset.set("storme")
        assert session._with_bank(None) == {"bank": "ggsc"}
        assert session._headers()["X-Dataset-Override"] == "storme"


def test_headers_carry_the_callers_own_dataset_and_identity(dataset):
    with as_login("alice"):
        dataset.set("d1")
    with as_login("bob"):
        dataset.set("d2")

    with as_login("alice"):
        headers = session._headers()
    assert headers["X-Dataset-Override"] == "d1"
    assert headers["X-Holon-Animus-Id"] == "alice"
    assert headers["X-Holon-Animus-Type"] == "GitHubIdentity"

    with as_login("bob"):
        assert session._headers()["X-Dataset-Override"] == "d2"


def test_a_shared_token_caller_sends_no_animus_header(dataset):
    with as_login(None):
        assert "X-Holon-Animus-Id" not in session._headers()
