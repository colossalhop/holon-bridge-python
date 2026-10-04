"""Tests for the shared .env loader.

Each test resets the module-level "already loaded" guard and clears any env
vars the loader might touch, since the whole point of that guard is to make
loading a no-op on the second call within one process — which is exactly
what would make these tests interfere with each other if left alone.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from holonbridge import envfile

REPO_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    envfile.reset_for_testing()
    monkeypatch.delenv("HOLONBRIDGE_ENV_FILE", raising=False)
    monkeypatch.delenv("SOME_TEST_VAR", raising=False)
    monkeypatch.chdir(tmp_path)
    yield
    envfile.reset_for_testing()


def write_env(path, **pairs) -> None:
    path.write_text("\n".join(f"{k}={v}" for k, v in pairs.items()) + "\n")


def test_no_file_anywhere_is_silent(tmp_path):
    assert envfile.load_shared_env() is None


def test_cwd_dotenv_is_found_and_loaded(tmp_path, monkeypatch):
    write_env(tmp_path / ".env", SOME_TEST_VAR="from-cwd")
    used = envfile.load_shared_env()
    assert used == tmp_path / ".env"
    assert os.getenv("SOME_TEST_VAR") == "from-cwd"


def test_explicit_path_overrides_cwd_discovery(tmp_path, monkeypatch):
    write_env(tmp_path / ".env", SOME_TEST_VAR="from-cwd")
    elsewhere = tmp_path / "elsewhere.env"
    write_env(elsewhere, SOME_TEST_VAR="from-explicit-path")
    monkeypatch.setenv("HOLONBRIDGE_ENV_FILE", str(elsewhere))

    used = envfile.load_shared_env()
    assert used == elsewhere
    assert os.getenv("SOME_TEST_VAR") == "from-explicit-path"


def test_explicit_path_works_regardless_of_cwd(tmp_path, monkeypatch):
    other_dir = tmp_path / "elsewhere"
    other_dir.mkdir()
    target = other_dir / "shared.env"
    write_env(target, SOME_TEST_VAR="found-me")
    monkeypatch.setenv("HOLONBRIDGE_ENV_FILE", str(target))
    # cwd (tmp_path, set by the autouse fixture) has no .env of its own —
    # the explicit path must not depend on it.

    assert envfile.load_shared_env() == target
    assert os.getenv("SOME_TEST_VAR") == "found-me"


def test_a_missing_explicit_path_fails_loudly(tmp_path, monkeypatch):
    monkeypatch.setenv("HOLONBRIDGE_ENV_FILE", str(tmp_path / "nope.env"))
    with pytest.raises(SystemExit, match="does not exist"):
        envfile.load_shared_env()


def test_a_real_environment_variable_beats_the_file(tmp_path, monkeypatch):
    write_env(tmp_path / ".env", SOME_TEST_VAR="from-file")
    monkeypatch.setenv("SOME_TEST_VAR", "from-real-shell")

    envfile.load_shared_env()
    assert os.getenv("SOME_TEST_VAR") == "from-real-shell"


def test_loading_is_idempotent_within_one_process(tmp_path, monkeypatch):
    write_env(tmp_path / ".env", SOME_TEST_VAR="from-file")
    first = envfile.load_shared_env()
    assert first is not None

    # A second call is a no-op — even if the file changes underneath it —
    # which is what lets both entry points call it unconditionally without
    # re-reading the file on every access.
    write_env(tmp_path / ".env", SOME_TEST_VAR="changed-after-first-load")
    second = envfile.load_shared_env()
    assert second is None
    assert os.getenv("SOME_TEST_VAR") == "from-file"


def test_both_entry_points_see_the_same_shared_file(tmp_path):
    """The property the user actually asked for: one file, both processes.

    ``holonbridge_mcp.session`` reads BEARER_TOKEN into ``BEARER`` at import
    time (it moved there from ``server.py`` on 2026-08-28). Re-importing in this
    process is not meaningful -- Python caches modules, and reloading ``session``
    would build a second FastMCP instance and orphan every registered tool -- so
    this starts a fresh interpreter in a directory containing only the ``.env``,
    which is exactly what a second entry point launched there would be.
    It also keeps the loaded value out of this process's ``os.environ``.
    """
    write_env(tmp_path / ".env", BEARER_TOKEN="shared-value")

    env = {
        key: value
        for key, value in os.environ.items()
        if key not in {"BEARER_TOKEN", "HOLONBRIDGE_ENV_FILE"}
    }
    env["PYTHONPATH"] = os.pathsep.join(
        part for part in (str(REPO_ROOT), env.get("PYTHONPATH", "")) if part
    )

    result = subprocess.run(
        [sys.executable, "-c", "from holonbridge_mcp import session; print(session.BEARER)"],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip().splitlines()[-1] == "shared-value"
