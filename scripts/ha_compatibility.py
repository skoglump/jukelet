"""Discover, prepare and test owned isolated HA environments; never a deployed HA.

Package once, then supply that same archive to every run. Network use is limited to
public upstream metadata/packages; probes generate their own loopback HA and users.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

MINIMUM = "2026.10.3"
BASELINE = "2026.10.3"
IMMEDIATE = "2026.10.4"
STABLE = re.compile(r"([1-9][0-9]{3})\.([1-9]|1[0-2])\.(0|[1-9][0-9]*)")
BETA = re.compile(r"([1-9][0-9]{3})\.([1-9]|1[0-2])\.0b(0|[1-9][0-9]*)")
PROBES = (
    "compatibility",
    "distribution",
    "runtime",
    "dispatcher",
    "tag",
    "administration",
    "diagnostics",
    "playback",
    "timeout",
    "preservation",
    "publication",
    "standalone",
)


def encoded(value: object) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def fetch(url: str) -> dict[str, Any]:
    with urlopen(
        Request(url, headers={"User-Agent": "jukelet-ha-compatibility"}), timeout=60
    ) as response:
        result = json.load(response)
    if not isinstance(result, dict):
        raise ValueError("upstream metadata must be an object")
    return result


def select_releases(releases: dict[str, Any]) -> dict[str, Any]:
    available = {
        name: items
        for name, items in releases.items()
        if isinstance(items, list)
        and any(
            isinstance(item, dict)
            and not item.get("yanked", False)
            and item.get("packagetype") == "bdist_wheel"
            for item in items
        )
    }
    stable = [
        tuple(map(int, match.groups())) for name in available if (match := STABLE.fullmatch(name))
    ]
    if not stable:
        raise ValueError("no non-yanked stable Home Assistant wheel found")
    latest = max(stable)
    if latest < (2026, 10, 3):
        raise ValueError("latest stable is below the supported minimum")
    latest_name = ".".join(map(str, latest))
    upcoming = (latest[0] + (latest[1] == 12), latest[1] % 12 + 1)
    betas = [
        (int(match[3]), name)
        for name in available
        if (match := BETA.fullmatch(name)) and (int(match[1]), int(match[2])) == upcoming
    ]
    beta = max(betas)[1] if betas else None
    targets = list(
        dict.fromkeys([MINIMUM, BASELINE, IMMEDIATE, latest_name, *([beta] if beta else [])])
    )
    return {
        "stable": latest_name,
        "beta": beta,
        "beta_status": "available_early_warning" if beta else "not_available",
        "targets": targets,
    }


def discover() -> dict[str, Any]:
    metadata = fetch("https://pypi.org/pypi/homeassistant/json")
    return {
        "discovered_at": datetime.now(UTC).isoformat(),
        "source": "https://pypi.org/pypi/homeassistant/json",
        **select_releases(metadata["releases"]),
    }


def source_python(version: str) -> tuple[str, str]:
    """Resolve the upstream interpreter from an immutable Core source commit."""
    if not (STABLE.fullmatch(version) or BETA.fullmatch(version)):
        raise ValueError("only canonical stable/beta package versions may be prepared")
    tag = fetch(f"https://api.github.com/repos/home-assistant/core/git/ref/tags/{version}")
    commit = tag["object"]["sha"]
    if tag["object"]["type"] == "tag":
        commit = fetch(tag["object"]["url"])["object"]["sha"]
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("unexpected HA source identity")
    python_file = fetch(
        f"https://api.github.com/repos/home-assistant/core/contents/.python-version?ref={commit}"
    )
    python_version = base64.b64decode(python_file["content"]).decode().strip()
    if not re.fullmatch(r"3\.[0-9]+\.[0-9]+", python_version):
        raise ValueError("upstream .python-version is not an exact stable Python version")
    return commit, python_version


def prepare(version: str, root: Path, uv: str) -> dict[str, Any]:
    commit, python_version = source_python(version)
    root.mkdir(parents=True, exist_ok=False)
    metadata = fetch(f"https://pypi.org/pypi/homeassistant/{version}/json")
    requirement = root / "requirements.in"
    requirement.write_text(f"homeassistant=={version}\n")
    lock = root / "requirements.txt"
    environment = root / "venv"
    # No --override or --no-deps: retain every exact pin from the upstream wheel.
    subprocess.run([uv, "venv", "--python", python_version, str(environment)], check=True)
    python = environment / "bin/python"
    subprocess.run(
        [
            uv,
            "pip",
            "compile",
            "--python",
            str(python),
            str(requirement),
            "--output-file",
            str(lock),
        ],
        check=True,
    )
    subprocess.run([uv, "pip", "sync", "--python", str(python), str(lock)], check=True)
    subprocess.run([uv, "pip", "check", "--python", str(python)], check=True)
    result = {
        "core": version,
        "requires_python": metadata["info"]["requires_python"],
        "python": python_version,
        "source_commit": commit,
        "source_url": f"https://github.com/home-assistant/core/tree/{commit}",
        "wheel_files": [
            {"filename": f["filename"], "sha256": f["digests"]["sha256"]}
            for f in metadata["urls"]
            if not f.get("yanked")
        ],
        "upstream_requires_dist": metadata["info"]["requires_dist"],
        "lock_sha256": hashlib.sha256(lock.read_bytes()).hexdigest(),
        "prepared_at": datetime.now(UTC).isoformat(),
    }
    (root / "environment.json").write_text(encoded(result))
    return result


def run(
    python: Path, baseline_python: Path, archive: Path, output: Path, uv: str
) -> dict[str, Any]:
    from scripts.package_integration import verify

    output.mkdir(parents=True, exist_ok=False)
    manifest = verify(archive)
    environment = {
        **os.environ,
        "JUKELET_PROBE_ARCHIVE": str(archive.resolve()),
        "JUKELET_BASELINE_PYTHON": str(baseline_python.absolute()),
    }
    identity_code = (
        "import homeassistant,homeassistant.const,sys,json,importlib.metadata as m;"
        "print(json.dumps(dict(core=homeassistant.const.__version__,distribution=m.version('homeassistant'),"
        "python=sys.version,executable=sys.executable,module=homeassistant.__file__,"
        "dependencies=sorted((d.metadata['Name'],d.version) "
        "for d in m.distributions())),sort_keys=True))"
    )
    identity = json.loads(subprocess.check_output([str(python), "-c", identity_code], text=True))
    assert identity["core"] == identity["distribution"]
    dependencies = encoded(identity["dependencies"]).encode()
    (output / "dependencies.json").write_bytes(dependencies)
    result: dict[str, Any] = {
        "tested_at": datetime.now(UTC).isoformat(),
        "scope": "actual_isolated_HA_synthetic_credentials_inert_services",
        "identity": identity,
        "artifact": manifest,
        "dependencies_sha256": hashlib.sha256(dependencies).hexdigest(),
        "probes": [],
        "result": "FAIL",
    }
    check = subprocess.run(
        [uv, "pip", "check", "--python", str(python)], capture_output=True, text=True
    )
    (output / "dependency-check.log").write_text(check.stdout + check.stderr)
    result["dependency_check_exit"] = check.returncode
    result["probe_sources"] = {
        str(p): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in [
            Path(__file__),
            *sorted(Path("companion").glob("*probe.py")),
            Path("companion/probe_support.py"),
            Path("scripts/package_integration.py"),
        ]
    }
    (output / "result.json").write_text(encoded(result))
    if check.returncode:
        raise RuntimeError("upstream dependency consistency failed; see dependency-check.log")
    for probe in PROBES:
        command = [str(python), "-m", f"companion.{probe}_probe"]
        with (output / f"{probe}.log").open("w") as log:
            try:
                completed = subprocess.run(
                    command, env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=900
                )
                code = completed.returncode
            except subprocess.TimeoutExpired:
                code = 124
        result["probes"].append({"probe": probe, "command": command, "exit_code": code})
        (output / "result.json").write_text(encoded(result))
        print(f"{identity['core']} {probe}: {'PASS' if code == 0 else 'FAIL'} ({code})", flush=True)
        if code:
            raise RuntimeError(f"{probe} failed; see {output / (probe + '.log')}")
    verify(archive)
    result["result"] = "PASS"
    (output / "result.json").write_text(encoded(result))
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    discovery = sub.add_parser("discover")
    discovery.add_argument("--output", type=Path, required=True)
    interpreter = sub.add_parser("python-version")
    interpreter.add_argument("--version", required=True)
    setup = sub.add_parser("prepare")
    setup.add_argument("--version", required=True)
    setup.add_argument("--root", type=Path, required=True)
    setup.add_argument("--uv", default="uv")
    tests = sub.add_parser("run")
    tests.add_argument("--python", type=Path, required=True)
    tests.add_argument("--baseline-python", type=Path, required=True)
    tests.add_argument("--archive", type=Path, required=True)
    tests.add_argument("--output", type=Path, required=True)
    tests.add_argument("--uv", default="uv")
    args = parser.parse_args()
    if args.command == "discover":
        result = discover()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded(result))
        print(encoded(result))
    elif args.command == "python-version":
        print(source_python(args.version)[1])
    elif args.command == "prepare":
        print(encoded(prepare(args.version, args.root, args.uv)))
    else:
        print(encoded(run(args.python, args.baseline_python, args.archive, args.output, args.uv)))


if __name__ == "__main__":
    main()
