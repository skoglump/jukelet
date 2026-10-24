"""Opt-in BuildKit regression using generated files, never a real app context.

Run with `python3 scripts/probe_build_context.py` and Docker Buildx available.
Only the repository's .dockerignore is copied; all other inputs are synthetic.
No target, source directory, secrets or configuration arguments are accepted.
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    if len(sys.argv) != 1:
        raise SystemExit("This synthetic probe accepts no target or configuration arguments")
    excluded = [
        prefix + name
        for prefix in ("", "frontend/", "backend/", "nested/deeper/")
        for name in (
            ".env",
            ".env.production",
            ".env.local",
            ".secrets/token",
            ".workflow/evidence",
            "operational.db",
            "operational.db-wal",
            "operational.sqlite3",
        )
    ]
    included = [
        "frontend/src/synthetic.tsx",
        "backend/src/jukelet/synthetic.py",
        "frontend/package.json",
        "backend/pyproject.toml",
        "LICENSE",
    ]
    with tempfile.TemporaryDirectory(prefix="jukelet-build-context-") as temporary:
        directory = Path(temporary)
        context, exported = directory / "context", directory / "exported"
        context.mkdir()
        (context / ".dockerignore").write_bytes((ROOT / ".dockerignore").read_bytes())
        (context / "Dockerfile").write_text("FROM scratch\nCOPY . /context\n")
        for name in excluded + included:
            target = context / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("Synthetic build-context fixture: " + name + "\n")
        subprocess.run(
            [
                "docker",
                "buildx",
                "build",
                "--network=none",
                "--no-cache",
                "--progress=plain",
                "--output",
                f"type=local,dest={exported}",
                str(context),
            ],
            check=True,
        )
        leaked = [name for name in excluded if (exported / "context" / name).exists()]
        missing = [name for name in included if not (exported / "context" / name).is_file()]
        if leaked or missing:
            raise AssertionError(
                json.dumps({"excluded_but_present": leaked, "source_missing": missing})
            )
        print(
            f"PASS BuildKit synthetic context: {len(excluded)} root/nested private paths excluded; "
            f"{len(included)} source files retained; no repository secrets read or copied"
        )


if __name__ == "__main__":
    main()
