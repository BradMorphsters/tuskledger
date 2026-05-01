"""
Tusk Ledger CLI — agent-friendly entry point for non-UI operations.

Today this is just the `doctor` command (a structured health check),
but the module is designed so future subcommands (`sync`, `export`,
`backup`, etc.) drop in next to it.

Invocation patterns:

  # From the repo root, via the wrapper script:
  ./tuskledger doctor                 # human-readable
  ./tuskledger doctor --json          # machine-readable

  # Or directly:
  cd backend && python -m app.cli doctor [--json]

Why this exists: it gives an AI assistant ONE call that returns the
entire diagnostic state of a user's install, in a structured shape.
The user can paste the JSON output into Claude / Cursor / Cowork and
get a fix without their assistant having to grep around blindly.

Output contract for `doctor --json` (stable; agents may rely on this):

  {
    "ok": bool,                 # true iff every check has status=pass
    "version": "...",           # the doctor schema version (this file)
    "summary": {"total": N, "pass": N, "warn": N, "fail": N},
    "checks": [
      {
        "name": "snake_case_id",
        "category": "env" | "db" | "runtime" | "filesystem" | ...,
        "status": "pass" | "warn" | "fail",
        "message": "human-readable one-liner",
        "fix_hint": "optional — what to try if status != pass"
      },
      ...
    ]
  }
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable

# Stable schema version. Bump if you change the JSON shape so an agent
# parsing old output knows it might not match newer expectations.
DOCTOR_SCHEMA_VERSION = "1"

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_ROOT / "backend"
FRONTEND_DIR = REPO_ROOT / "frontend"


# ── Result type ───────────────────────────────────────────────────

@dataclass
class CheckResult:
    name: str
    category: str
    status: str  # "pass" | "warn" | "fail"
    message: str
    fix_hint: str | None = None


# ── Individual checks ─────────────────────────────────────────────
# Each `check_*` function returns one CheckResult. Keep them small and
# independent; the runner composes them. None of them should raise —
# any exception during a check should be caught and turned into a
# fail-status result with the exception text as the message. Otherwise
# one bad check can blind the user to all the others.

def check_python_version() -> CheckResult:
    expected_file = REPO_ROOT / ".python-version"
    actual = f"{sys.version_info.major}.{sys.version_info.minor}"
    if not expected_file.exists():
        return CheckResult(
            "python_version", "runtime", "warn",
            f"Running Python {actual}, but no .python-version file to compare against.",
            "If you have pyenv installed, create .python-version with '3.12'."
        )
    expected = expected_file.read_text().strip()
    if not expected:
        return CheckResult(
            "python_version", "runtime", "warn",
            f"Running Python {actual}; .python-version is empty.",
            None
        )
    # Compare major.minor only — patch versions don't matter
    expected_short = ".".join(expected.split(".")[:2])
    if actual == expected_short:
        return CheckResult(
            "python_version", "runtime", "pass",
            f"Python {actual} matches .python-version ({expected})."
        )
    return CheckResult(
        "python_version", "runtime", "warn",
        f"Running Python {actual}, but .python-version says {expected}.",
        f"Install Python {expected} (e.g. `pyenv install {expected}`) and recreate the venv."
    )


def check_node_version() -> CheckResult:
    expected_file = REPO_ROOT / ".nvmrc"
    if not expected_file.exists():
        return CheckResult(
            "node_version", "runtime", "warn",
            "No .nvmrc file found; can't verify Node version.",
            None
        )
    expected = expected_file.read_text().strip()
    try:
        out = subprocess.run(
            ["node", "--version"], capture_output=True, text=True, timeout=5
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return CheckResult(
            "node_version", "runtime", "fail",
            "`node` not found on PATH.",
            f"Install Node {expected} (e.g. `nvm install {expected} && nvm use {expected}`)."
        )
    actual = out.stdout.strip().lstrip("v")
    expected_major = expected.lstrip("v").split(".")[0]
    actual_major = actual.split(".")[0]
    if actual_major == expected_major:
        return CheckResult(
            "node_version", "runtime", "pass",
            f"Node v{actual} matches .nvmrc major version ({expected})."
        )
    return CheckResult(
        "node_version", "runtime", "warn",
        f"Running Node v{actual}, but .nvmrc says {expected}.",
        f"`nvm use {expected}` (or install it first with `nvm install {expected}`)."
    )


def check_env_file() -> CheckResult:
    env_path = BACKEND_DIR / ".env"
    if not env_path.exists():
        return CheckResult(
            "env_file", "env", "fail",
            "backend/.env is missing.",
            "Run `cp backend/.env.example backend/.env` and fill in your Plaid keys."
        )
    return CheckResult(
        "env_file", "env", "pass",
        "backend/.env exists."
    )


def check_required_env_vars() -> CheckResult:
    """
    We don't import the Pydantic Settings module here on purpose —
    we want this check to work even if config loading would fail. So
    we read the .env file directly and look for the keys.
    """
    env_path = BACKEND_DIR / ".env"
    if not env_path.exists():
        return CheckResult(
            "env_vars", "env", "fail",
            "Skipped (no .env file).",
            "See env_file check."
        )
    required = {"PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ENV"}
    found: set[str] = set()
    placeholder_values = {"", "your_client_id", "your_secret", "changeme", "todo"}
    placeholders: list[str] = []
    for raw in env_path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key in required:
            found.add(key)
            if value.lower() in placeholder_values:
                placeholders.append(key)
    missing = required - found
    if missing:
        return CheckResult(
            "env_vars", "env", "fail",
            f"Missing required keys in backend/.env: {', '.join(sorted(missing))}.",
            "Add them. See backend/.env.example for the canonical list."
        )
    if placeholders:
        return CheckResult(
            "env_vars", "env", "fail",
            f"Placeholder values still in backend/.env: {', '.join(placeholders)}.",
            "Get your real Plaid sandbox keys from dashboard.plaid.com → Developers → Keys."
        )
    return CheckResult(
        "env_vars", "env", "pass",
        "All required env vars present and look populated."
    )


def check_encryption_key() -> CheckResult:
    key_path = BACKEND_DIR / ".encryption_key"
    if not key_path.exists():
        return CheckResult(
            "encryption_key", "filesystem", "warn",
            "backend/.encryption_key is missing — will be auto-generated on next start.",
            "Normal on a fresh install. After first start, BACK THIS FILE UP — without it, "
            "stored Plaid tokens become unreadable."
        )
    # Permission check — should be 600
    mode = key_path.stat().st_mode & 0o777
    if mode != 0o600:
        return CheckResult(
            "encryption_key", "filesystem", "warn",
            f"backend/.encryption_key permissions are {oct(mode)} (should be 0o600).",
            f"`chmod 600 {key_path.relative_to(REPO_ROOT)}`"
        )
    return CheckResult(
        "encryption_key", "filesystem", "pass",
        "backend/.encryption_key exists with 0o600 permissions."
    )


def check_db_file() -> CheckResult:
    db_path = BACKEND_DIR / "tuskledger.db"
    if not db_path.exists():
        return CheckResult(
            "db_file", "db", "warn",
            "backend/tuskledger.db not found — will be created on next start.",
            "Normal on a fresh install. After start, transactions sync into this file."
        )
    size_mb = db_path.stat().st_size / 1_000_000
    return CheckResult(
        "db_file", "db", "pass",
        f"backend/tuskledger.db exists ({size_mb:.1f} MB)."
    )


def check_db_schema() -> CheckResult:
    """
    Compare the alembic_version row in the DB against the highest
    revision file on disk. Mismatch = pending migration.
    """
    db_path = BACKEND_DIR / "tuskledger.db"
    if not db_path.exists():
        return CheckResult(
            "db_schema", "db", "warn",
            "Skipped (no DB file yet).",
            "See db_file check."
        )
    versions_dir = BACKEND_DIR / "alembic" / "versions"
    if not versions_dir.exists():
        return CheckResult(
            "db_schema", "db", "warn",
            "Migrations directory not found.",
            None
        )
    # Find the highest revision on disk by reading `revision = ` lines
    disk_revisions: set[str] = set()
    for f in versions_dir.glob("*.py"):
        for line in f.read_text().splitlines():
            line = line.strip()
            if line.startswith("revision ") and "=" in line:
                _, _, val = line.partition("=")
                disk_revisions.add(val.strip().strip('"').strip("'"))
                break
    # Read alembic_version from the DB
    try:
        conn = sqlite3.connect(db_path)
        cur = conn.execute("SELECT version_num FROM alembic_version")
        row = cur.fetchone()
        conn.close()
    except sqlite3.Error as e:
        return CheckResult(
            "db_schema", "db", "fail",
            f"Could not read alembic_version: {e}",
            "Run `cd backend && source venv/bin/activate && alembic upgrade head`."
        )
    if not row:
        return CheckResult(
            "db_schema", "db", "fail",
            "alembic_version table is empty.",
            "Run `cd backend && source venv/bin/activate && alembic upgrade head`."
        )
    db_rev = row[0]
    if db_rev in disk_revisions:
        return CheckResult(
            "db_schema", "db", "pass",
            f"DB at revision {db_rev} (matches a revision file on disk)."
        )
    return CheckResult(
        "db_schema", "db", "warn",
        f"DB at revision {db_rev} but no matching revision file. Possibly stale.",
        "Run `cd backend && source venv/bin/activate && alembic upgrade head`."
    )


def check_backups() -> CheckResult:
    backups_dir = BACKEND_DIR / "backups"
    if not backups_dir.exists():
        return CheckResult(
            "backups", "filesystem", "warn",
            "backend/backups/ doesn't exist yet.",
            "Created automatically on first start. No action needed."
        )
    snapshots = sorted(backups_dir.glob("tuskledger-*.db"))
    if not snapshots:
        return CheckResult(
            "backups", "filesystem", "warn",
            "No backup snapshots found in backend/backups/.",
            "Will be created on next start. Verify after that."
        )
    latest = snapshots[-1]
    return CheckResult(
        "backups", "filesystem", "pass",
        f"{len(snapshots)} backup snapshot(s); latest: {latest.name}."
    )


def check_disk_space() -> CheckResult:
    try:
        usage = shutil.disk_usage(REPO_ROOT)
    except OSError as e:
        return CheckResult(
            "disk_space", "filesystem", "warn",
            f"Could not read disk usage: {e}",
            None
        )
    free_gb = usage.free / 1_000_000_000
    if free_gb < 1:
        return CheckResult(
            "disk_space", "filesystem", "fail",
            f"Low disk space: {free_gb:.2f} GB free on the volume holding the repo.",
            "Free up space — backups will fail and Plaid syncs may corrupt the DB."
        )
    if free_gb < 5:
        return CheckResult(
            "disk_space", "filesystem", "warn",
            f"Low-ish disk space: {free_gb:.2f} GB free.",
            None
        )
    return CheckResult(
        "disk_space", "filesystem", "pass",
        f"{free_gb:.1f} GB free on the volume holding the repo."
    )


def _port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        try:
            s.bind((host, port))
            return False
        except OSError:
            return True


def check_backend_port() -> CheckResult:
    if _port_in_use(8000):
        return CheckResult(
            "backend_port", "runtime", "warn",
            "Port 8000 is in use — that's normal if Tusk Ledger is already running, "
            "and a problem if something else has it.",
            "Check `lsof -i :8000`. If it's another app, kill it before starting Tusk Ledger."
        )
    return CheckResult(
        "backend_port", "runtime", "pass",
        "Port 8000 is free (backend can start)."
    )


def check_frontend_port() -> CheckResult:
    if _port_in_use(3000):
        return CheckResult(
            "frontend_port", "runtime", "warn",
            "Port 3000 is in use — fine if Tusk Ledger is running, problematic if not.",
            "Check `lsof -i :3000`."
        )
    return CheckResult(
        "frontend_port", "runtime", "pass",
        "Port 3000 is free (frontend can start)."
    )


def check_node_modules() -> CheckResult:
    nm = FRONTEND_DIR / "node_modules"
    if not nm.exists():
        return CheckResult(
            "node_modules", "filesystem", "fail",
            "frontend/node_modules is missing.",
            "Run `cd frontend && npm install` (or just run `./start.sh`)."
        )
    return CheckResult(
        "node_modules", "filesystem", "pass",
        "frontend/node_modules exists."
    )


def check_venv() -> CheckResult:
    venv = BACKEND_DIR / "venv"
    if not venv.exists():
        return CheckResult(
            "venv", "filesystem", "fail",
            "backend/venv is missing.",
            "Run `./start.sh` (it creates the venv on first run) or set up manually."
        )
    return CheckResult(
        "venv", "filesystem", "pass",
        "backend/venv exists."
    )


# ── Runner ────────────────────────────────────────────────────────

ALL_CHECKS = [
    check_python_version,
    check_node_version,
    check_env_file,
    check_required_env_vars,
    check_encryption_key,
    check_db_file,
    check_db_schema,
    check_backups,
    check_disk_space,
    check_backend_port,
    check_frontend_port,
    check_node_modules,
    check_venv,
]


def run_all_checks() -> list[CheckResult]:
    """
    Execute every check, swallow exceptions on a per-check basis so one
    bad check can't hide the others.
    """
    results: list[CheckResult] = []
    for fn in ALL_CHECKS:
        try:
            results.append(fn())
        except Exception as e:  # pylint: disable=broad-except
            results.append(CheckResult(
                fn.__name__.removeprefix("check_"),
                "internal",
                "fail",
                f"Check raised an exception: {type(e).__name__}: {e}",
                "Likely a bug in the doctor command itself. File an issue."
            ))
    return results


def summarize(results: Iterable[CheckResult]) -> dict:
    counts = {"pass": 0, "warn": 0, "fail": 0}
    for r in results:
        counts[r.status] = counts.get(r.status, 0) + 1
    counts["total"] = sum(counts.values())
    return counts


# ── Output formatters ─────────────────────────────────────────────

# ANSI color codes — only emit them when stdout is a TTY so piping
# to a file or to an agent doesn't get garbled with escape sequences.
def _color(text: str, code: str) -> str:
    if not sys.stdout.isatty():
        return text
    return f"\033[{code}m{text}\033[0m"


def _status_glyph(status: str) -> str:
    return {
        "pass": _color("✓", "32"),  # green
        "warn": _color("⚠", "33"),  # yellow
        "fail": _color("✗", "31"),  # red
    }.get(status, "?")


def render_human(results: list[CheckResult]) -> str:
    lines = []
    summary = summarize(results)
    overall = "OK" if summary["fail"] == 0 else "PROBLEMS FOUND"
    overall_colored = _color(overall, "32" if summary["fail"] == 0 else "31")
    lines.append(f"Tusk Ledger doctor — {overall_colored}")
    lines.append(
        f"  {summary['pass']} pass · "
        f"{summary['warn']} warn · "
        f"{summary['fail']} fail"
    )
    lines.append("")
    by_category: dict[str, list[CheckResult]] = {}
    for r in results:
        by_category.setdefault(r.category, []).append(r)
    for cat in sorted(by_category):
        lines.append(_color(cat.upper(), "1"))
        for r in by_category[cat]:
            lines.append(f"  {_status_glyph(r.status)} {r.name}: {r.message}")
            if r.fix_hint and r.status != "pass":
                lines.append(f"      → {r.fix_hint}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def render_json(results: list[CheckResult]) -> str:
    summary = summarize(results)
    payload = {
        "ok": summary["fail"] == 0,
        "version": DOCTOR_SCHEMA_VERSION,
        "summary": summary,
        "checks": [asdict(r) for r in results],
    }
    return json.dumps(payload, indent=2) + "\n"


# ── argparse entry point ──────────────────────────────────────────

def cmd_doctor(args: argparse.Namespace) -> int:
    results = run_all_checks()
    if args.json:
        sys.stdout.write(render_json(results))
    else:
        sys.stdout.write(render_human(results))
    # Exit code: 0 if no failures (warns are OK), non-zero otherwise.
    # Agents and CI scripts can rely on this.
    return 0 if summarize(results)["fail"] == 0 else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="tuskledger",
        description="Tusk Ledger CLI. Run `tuskledger <command> --help` for details.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    doctor = sub.add_parser(
        "doctor",
        help="Run a structured health check of this install.",
        description=(
            "Inspects env vars, encryption key, DB schema, port availability, "
            "recent backups, and runtime versions. Designed to be pasted "
            "(in --json mode) into an AI assistant for diagnosis."
        ),
    )
    doctor.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON instead of human-readable text.",
    )
    doctor.set_defaults(func=cmd_doctor)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
