"""Synthetic committed sources and local build folders; no Docker, HA or publication."""

import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import urllib.request
from pathlib import Path

import pytest
import yaml

from scripts.package_addon import build, verify

ROOT = Path(__file__).resolve().parents[2]


def git(repository: Path, *args: str) -> str:
    return (
        subprocess.check_output(["git", "-C", str(repository), *args], stderr=subprocess.PIPE)
        .decode()
        .strip()
    )


@pytest.fixture
def source_repo(tmp_path: Path) -> Path:
    repository = tmp_path / "repository"
    repository.mkdir()
    for name in (
        "addon/local/config.json.template",
        "addon/local/Dockerfile.addon",
        "addon/local/translations/en.yaml",
    ):
        target = repository / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
    for name in (
        "Dockerfile",
        ".dockerignore",
        "LICENSE",
        "backend/LICENSE",
        "backend/pyproject.toml",
        "backend/uv.lock",
        "frontend/package.json",
        "frontend/package-lock.json",
        "frontend/index.html",
        "frontend/tsconfig.json",
        "frontend/vite.config.ts",
        "frontend/eslint.config.js",
        "frontend/playwright.config.ts",
        "frontend/playwright.fixture.config.ts",
        "frontend/playwright.ingress.config.ts",
    ):
        target = repository / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
    for name in (
        "backend/src/jukelet/addon.py",
        "frontend/src/main.tsx",
        "frontend/public/third-party-notices.txt",
        "frontend/fixtures/manager.ts",
        "frontend/e2e/ingress.spec.ts",
    ):
        target = repository / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("synthetic committed source\n")
    names = sorted(
        path.relative_to(repository).as_posix()
        for path in repository.rglob("*")
        if path.is_file() and not path.relative_to(repository).as_posix().startswith("addon/")
    )
    (repository / "addon/local/context-files.txt").write_text("\n".join(names) + "\n")
    git(repository, "init", "-q")
    git(repository, "add", ".")
    commit(repository)
    return repository


def commit(repository: Path) -> None:
    git(
        repository,
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@example.invalid",
        "commit",
        "-qm",
        "Synthetic package fixture",
    )


def test_local_package_reuses_complete_shared_recipe_and_committed_context(
    source_repo: Path, tmp_path: Path
) -> None:
    expected_recipe = (source_repo / "Dockerfile").read_bytes()
    expected_version = json.loads((source_repo / "addon/local/config.json.template").read_bytes())[
        "version"
    ]
    (source_repo / "Dockerfile").write_text("uncommitted recipe must be ignored")
    (source_repo / "frontend/src/main.tsx").write_text("uncommitted source must be ignored")
    (source_repo / "addon/local/config.json.template").write_text(
        "uncommitted configuration must be ignored"
    )
    output = tmp_path / "output"
    info = build(source_repo, "HEAD", output)
    folder = output / "jukelet"
    assert (folder / "Dockerfile").read_bytes() == expected_recipe + b"\n" + (
        ROOT / "addon/local/Dockerfile.addon"
    ).read_bytes()
    assert (folder / "frontend/src/main.tsx").read_bytes() == b"synthetic committed source\n"
    assert json.loads((folder / "config.json").read_bytes())["version"] == expected_version
    assert info["source_commit"] == git(source_repo, "rev-parse", "HEAD")


def test_generated_manifest_yields_one_canonical_supervisor_entry_slash(
    source_repo: Path, tmp_path: Path
) -> None:
    output = tmp_path / "output"
    build(source_repo, "HEAD", output)
    config = json.loads((output / "jukelet/config.json").read_bytes())
    # Supervisor 2026.10.5 App.ingress_url supplies the directory slash itself:
    # https://github.com/home-assistant/supervisor/blob/2026.10.5/supervisor/apps/app.py#L597
    token = "synthetic_installed_ingress_token"
    canonical = f"/api/hassio_ingress/{token}/"
    effective = canonical + config.get("ingress_entry", "")
    assert effective == canonical


@pytest.mark.parametrize(
    "name",
    [
        ".secrets/token",
        "frontend/.env",
        "frontend/operational.db",
        "frontend/src/credentials.json",
        "docs/agent-workflow-explained.md",
        "../escape",
        "/absolute",
        "frontend/../outside",
        "frontend/src/.hidden.ts",
    ],
)
def test_context_allowlist_cannot_include_private_or_escaping_paths(
    source_repo: Path, tmp_path: Path, name: str
) -> None:
    # Missing path cases must be rejected as unsafe paths, before any blob lookup/output.
    allowlist = source_repo / "addon/local/context-files.txt"
    if not name.startswith(("/", "..")) and ".." not in name.split("/"):
        target = source_repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("SYNTHETIC_PRIVATE_CANARY")
    allowlist.write_text(allowlist.read_text() + name + "\n")
    git(source_repo, "add", ".")
    commit(source_repo)
    output = tmp_path / "output"
    with pytest.raises(ValueError, match="context path"):
        build(source_repo, "HEAD", output)
    assert not output.exists()


def test_existing_destination_is_never_overwritten(source_repo: Path, tmp_path: Path) -> None:
    output = tmp_path / "output"
    build(source_repo, "HEAD", output)
    target = output / "jukelet/config.json"
    target.write_text("existing bytes must remain")
    with pytest.raises(ValueError, match="destination"):
        build(source_repo, "HEAD", output)
    assert target.read_text() == "existing bytes must remain"


def test_symlink_output_parent_is_rejected_without_writes(
    source_repo: Path, tmp_path: Path
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    output = tmp_path / "output"
    output.symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="destination"):
        build(source_repo, "HEAD", output)
    assert list(outside.iterdir()) == []


def test_bundle_is_reproducible_and_excludes_unlisted_private_inputs(
    source_repo: Path, tmp_path: Path
) -> None:
    private = b"SYNTHETIC_PRIVATE_CANARY"
    for name in (
        ".secrets/private",
        "frontend/.env",
        "frontend/private.db",
        "docs/agent-workflow-explained.md",
    ):
        target = source_repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(private)
    git(source_repo, "add", ".")
    commit(source_repo)
    (source_repo / "frontend/src/credentials.json").write_bytes(private)
    first_output, second_output = tmp_path / "first", tmp_path / "second"
    first = build(source_repo, "HEAD", first_output)
    second = build(source_repo, "HEAD", second_output)
    assert first == second
    first_files = {
        path.relative_to(first_output / "jukelet").as_posix(): path.read_bytes()
        for path in (first_output / "jukelet").rglob("*")
        if path.is_file()
    }
    second_files = {
        path.relative_to(second_output / "jukelet").as_posix(): path.read_bytes()
        for path in (second_output / "jukelet").rglob("*")
        if path.is_file()
    }
    assert first_files == second_files
    assert private not in b"".join(first_files.values())
    assert first["files"] == {
        name: hashlib.sha256(content).hexdigest() for name, content in first_files.items()
    }
    assert first["source_tree"] == git(source_repo, "rev-parse", "HEAD^{tree}")
    assert verify(source_repo, first_output / "jukelet") == first


@pytest.mark.parametrize("kind", ["changed", "extra", "missing", "symlink"])
def test_verification_rejects_tampered_mixed_or_nonregular_bundle(
    source_repo: Path, tmp_path: Path, kind: str
) -> None:
    output = tmp_path / "output"
    build(source_repo, "HEAD", output)
    target = output / "jukelet/frontend/src/main.tsx"
    if kind == "changed":
        target.write_text("changed candidate bytes")
    elif kind == "extra":
        (output / "jukelet/unexpected").write_text("mixed candidate")
    elif kind == "missing":
        target.unlink()
    else:
        target.unlink()
        target.symlink_to(source_repo / "frontend/src/main.tsx")
    with pytest.raises(ValueError, match="bundle"):
        verify(source_repo, output / "jukelet")


@pytest.mark.parametrize("kind", ["symlink", "executable", "oversized", "unlisted", "missing"])
def test_incomplete_or_nonregular_committed_build_inputs_are_rejected(
    source_repo: Path, tmp_path: Path, kind: str
) -> None:
    target = source_repo / "frontend/src/main.tsx"
    if kind == "symlink":
        target.unlink()
        target.symlink_to("../../private-outside-source")
    elif kind == "executable":
        target.chmod(0o755)
    elif kind == "oversized":
        target.write_bytes(b"x" * (4 * 1024 * 1024 + 1))
    elif kind == "unlisted":
        (source_repo / "frontend/src/unreviewed.ts").write_text("unreviewed build input")
    else:
        target.unlink()
    git(source_repo, "add", ".")
    commit(source_repo)
    output = tmp_path / "output"
    with pytest.raises(ValueError):
        build(source_repo, "HEAD", output)
    assert not output.exists()


@pytest.mark.parametrize(
    "version", ["0.1.0-dev.1", "0.1.0-rc.3", "0.1.0", "0.1.0-addon.0", "0.1.0-addon.01"]
)
def test_candidate_identity_rejects_other_or_noncanonical_version_lanes(
    source_repo: Path, tmp_path: Path, version: str
) -> None:
    target = source_repo / "addon/local/config.json.template"
    config = json.loads(target.read_bytes())
    config["version"] = version
    target.write_text(json.dumps(config))
    git(source_repo, "add", ".")
    commit(source_repo)
    with pytest.raises(ValueError, match="0.1.0-addon.N"):
        build(source_repo, "HEAD", tmp_path / "output")


@pytest.mark.parametrize("kind", ["ancestor", "source", "traversal", "leaf-symlink"])
def test_output_is_bounded_and_cannot_modify_sources_or_follow_leaf_link(
    source_repo: Path, tmp_path: Path, kind: str
) -> None:
    output = tmp_path / "output"
    if kind == "ancestor":
        output = source_repo.parent
    elif kind == "source":
        output = source_repo / "frontend/new-folder"
    elif kind == "traversal":
        output = tmp_path / "new-folder/../output"
    else:
        output.mkdir()
        (output / "jukelet").symlink_to(source_repo, target_is_directory=True)
    with pytest.raises(ValueError, match="destination"):
        build(source_repo, "HEAD", output)
    assert git(source_repo, "status", "--porcelain") == ""


def test_metadata_and_adapter_expose_only_the_explicit_local_ingress_contract() -> None:
    config = json.loads((ROOT / "addon/local/config.json.template").read_bytes())
    assert re.fullmatch(r"0\.1\.0-addon\.[1-9][0-9]*", config["version"])
    assert config["arch"] == ["amd64"]
    assert config["homeassistant"] == "2026.10.3"
    assert config["ingress"] is True and config["ingress_port"] == 8000
    assert config["panel_title"] == "Jukelet" and config["panel_icon"].startswith("mdi:")
    assert config["panel_admin"] is True
    assert config["homeassistant_api"] is True
    assert config["hassio_api"] is config["docker_api"] is config["host_network"] is False
    assert config["ports"] == {} and config["map"] == [] and config["privileged"] == []
    assert (
        not {"image", "hassio", "hassos", "environment", "devices", "full_access"} & config.keys()
    )
    choices = {"public_origin", "additional_origins", "mode", "spotifyplus_entity_id"}
    assert set(config["schema"]) == choices
    assert config["options"]["mode"] == "read_only"
    assert config["options"]["public_origin"] is None
    assert config["options"]["additional_origins"] == []
    assert config["options"]["spotifyplus_entity_id"] == ""
    assert config["schema"]["mode"] == "list(read_only|manage)"
    expression = config["schema"]["public_origin"].removeprefix("match(").removesuffix(")")
    assert re.fullmatch(expression, "https://ha.example:8123")
    for invalid in (
        "http://127.0.0.1",
        "https://ha.example/path",
        "https://user@ha.example",
        "https://ha.example?q=value",
    ):
        assert not re.fullmatch(expression, invalid)
    translation = yaml.safe_load((ROOT / "addon/local/translations/en.yaml").read_bytes())
    assert set(translation["configuration"]) == choices
    assert all(
        item.get("name") and item.get("description")
        for item in translation["configuration"].values()
    )
    adapter = (ROOT / "addon/local/Dockerfile.addon").read_text()
    assert "FROM runtime AS addon\nUSER 0:0\n" in adapter
    assert 'ENTRYPOINT ["python", "-m", "jukelet.addon"]\nCMD []\n' in adapter
    assert not any((ROOT / "addon").rglob("config.json"))
    assert not any((ROOT / "addon").rglob("config.yaml"))


def test_cli_reports_finite_error_and_does_not_create_output_for_invalid_source(
    source_repo: Path, tmp_path: Path
) -> None:
    output = tmp_path / "output"
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/package_addon.py"),
            "--ref",
            "missing-synthetic-ref",
            "--output",
            str(output),
        ],
        cwd=source_repo,
        env={**os.environ, "SYNTHETIC_PRIVATE_CANARY": "not-for-output"},
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert "Traceback" not in result.stderr and "not-for-output" not in result.stderr
    assert result.stdout == ""
    assert not output.exists()


def test_addon_liveness_probe_drops_identity_before_network_access(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    instructions = (ROOT / "addon/local/Dockerfile.addon").read_text().replace("\\\n", " ")
    healthcheck = next(
        (line for line in instructions.splitlines() if line.startswith("HEALTHCHECK ")), None
    )
    assert healthcheck is not None, "The inherited image-user root probe must be overridden"
    tokens = shlex.split(healthcheck)
    assert tokens[:8] == [
        "HEALTHCHECK",
        "--interval=5s",
        "--timeout=3s",
        "--start-period=10s",
        "--retries=6",
        "CMD",
        "python",
        "-c",
    ]
    assert len(tokens) == 9
    identity: dict[str, object] = {"uid": 0, "gid": 0, "groups": [0, 42]}
    requested: list[str] = []

    def set_groups(groups: list[int]) -> None:
        assert identity["uid"] == 0
        identity["groups"] = groups

    def set_gid(gid: int) -> None:
        assert identity["uid"] == 0
        identity["gid"] = gid

    def set_uid(uid: int) -> None:
        assert identity["gid"] == 10001 and identity["groups"] == []
        identity["uid"] = uid

    def probe(url: str, timeout: int) -> None:
        assert identity == {"uid": 10001, "gid": 10001, "groups": []}
        assert url == "http://127.0.0.1:8000/health/live" and timeout == 2
        requested.append(url)

    monkeypatch.setattr(os, "setgroups", set_groups)
    monkeypatch.setattr(os, "setgid", set_gid)
    monkeypatch.setattr(os, "setuid", set_uid)
    monkeypatch.setattr(urllib.request, "urlopen", probe)
    exec(compile(tokens[8], "<fixed-addon-healthcheck>", "exec"), {})
    assert len(requested) == 1
