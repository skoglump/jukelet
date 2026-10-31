"""Exercise add-on release validation with synthetic metadata and no publication."""

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def addon_release_repo(tmp_path: Path) -> Path:
    for name in (
        "addon/local/config.json.template",
        "backend/pyproject.toml",
        "backend/uv.lock",
        "frontend/package.json",
        "frontend/package-lock.json",
        "companion/custom_components/jukelet_bridge/manifest.json",
    ):
        target = tmp_path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
    config = tmp_path / "addon/local/config.json.template"
    value = json.loads(config.read_text())
    value["version"] = "0.1.0-addon.6"
    config.write_text(json.dumps(value))
    return tmp_path


def validate(
    repository: Path, tag: str, *, prerelease: str = "true"
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/check_addon_release.py"),
            tag,
            "--prerelease",
            prerelease,
        ],
        cwd=repository,
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
    )


def test_addon_candidate_keeps_its_own_exact_image_and_shared_package_identity(
    addon_release_repo: Path,
) -> None:
    result = validate(addon_release_repo, "addon-v0.1.0-addon.6")
    assert result.returncode == 0, result.stderr
    plan: dict[str, Any] = json.loads(result.stdout)
    assert plan == {
        "addon_version": "0.1.0-addon.6",
        "app_version": "0.1.0-rc.3",
        "integration_source_version": "0.1.5",
        "release_tag": "addon-v0.1.0-addon.6",
        "prerelease": True,
        "image": "ghcr.io/skoglump/jukelet-addon",
        "image_reference": "ghcr.io/skoglump/jukelet-addon:0.1.0-addon.6",
        "architectures": ["amd64"],
        "platforms": ["linux/amd64"],
        "labels": {
            "io.hass.version": "0.1.0-addon.6",
            "io.hass.arch": "amd64",
            "io.hass.type": "app",
            "org.opencontainers.image.source": "https://github.com/skoglump/jukelet",
            "org.opencontainers.image.version": "0.1.0-addon.6",
            "io.jukelet.application.version": "0.1.0-rc.3",
        },
    }
    assert result.stderr == ""


@pytest.mark.parametrize(
    "tag",
    [
        "v0.1.0-rc.3",
        "integration-v0.1.5",
        "0.1.0-addon.6",
        "ADDON-v0.1.0-addon.6",
        "addon-v0.1.0-addon.0",
        "addon-v0.1.0-addon.06",
        "addon-v0.1.0-addon.-1",
        "addon-v1.0.0-addon.1",
        "addon-v0.1.0-rc.6",
        "addon-v01.2.3",
        "addon-v0.1",
        "addon-v0.1.0+build",
        "addon-v0.1.0-addon.6\n",
        "addon-v0.1.0-addon.6;echo bad",
        "addon-vlatest",
        "",
    ],
)
def test_cross_lane_and_noncanonical_tags_produce_no_release_plan(
    addon_release_repo: Path, tag: str
) -> None:
    result = validate(addon_release_repo, tag)
    assert result.returncode == 2
    assert result.stdout == ""
    assert "Add-on release tag must be" in result.stderr
    assert "Traceback" not in result.stderr


@pytest.mark.parametrize(("version", "flag"), [("0.1.0-addon.6", "false"), ("1.0.0", "true")])
def test_channel_and_github_flag_must_agree(
    addon_release_repo: Path, version: str, flag: str
) -> None:
    path = addon_release_repo / "addon/local/config.json.template"
    config = json.loads(path.read_text())
    config["version"] = version
    path.write_text(json.dumps(config))
    result = validate(addon_release_repo, f"addon-v{version}", prerelease=flag)
    assert result.returncode == 2
    assert result.stdout == ""
    assert "prerelease flag must match" in result.stderr


@pytest.mark.parametrize("flag", ["", "TRUE", "1"])
def test_invalid_github_flags_fail_without_release_outputs(
    addon_release_repo: Path, flag: str
) -> None:
    result = validate(addon_release_repo, "addon-v0.1.0-addon.6", prerelease=flag)
    assert result.returncode == 2
    assert result.stdout == ""
    assert "invalid choice" in result.stderr


@pytest.mark.parametrize("version", ["0.1.0-addon." + "1" * 117, "1" * 125 + ".0.0"])
def test_packaging_versions_must_fit_an_actual_docker_tag(
    addon_release_repo: Path, version: str
) -> None:
    assert len(version) == 129
    path = addon_release_repo / "addon/local/config.json.template"
    config = json.loads(path.read_text())
    config["version"] = version
    path.write_text(json.dumps(config))
    result = validate(
        addon_release_repo,
        f"addon-v{version}",
        prerelease="true" if "-addon." in version else "false",
    )
    assert result.returncode == 2
    assert result.stdout == ""
    assert "128" in result.stderr


@pytest.mark.parametrize(
    ("field", "value", "reason"),
    [
        ("version", "0.1.0-addon.5", "packaging version"),
        ("slug", "standalone", "accepted Jukelet namespace"),
        ("image", "ghcr.io/skoglump/jukelet", "accepted Jukelet namespace"),
        ("image", "ghcr.io/skoglump/jukelet-addon:latest", "accepted Jukelet namespace"),
        ("image", "127.0.0.1:15059/skoglump/jukelet-addon", "accepted Jukelet namespace"),
        ("image", "ghcr.io/skoglump/jukelet-addon@sha256:bad", "accepted Jukelet namespace"),
        ("image", None, "accepted Jukelet namespace"),
        ("arch", ["amd64", "aarch64"], "tested amd64 architecture"),
        ("arch", ["aarch64"], "tested amd64 architecture"),
        ("arch", ["amd64", "amd64"], "tested amd64 architecture"),
        ("arch", "amd64", "tested amd64 architecture"),
        ("arch", [], "tested amd64 architecture"),
    ],
)
def test_wrong_packaging_namespace_or_architecture_cannot_be_published(
    addon_release_repo: Path, field: str, value: object, reason: str
) -> None:
    path = addon_release_repo / "addon/local/config.json.template"
    config = json.loads(path.read_text())
    config[field] = value
    path.write_text(json.dumps(config))
    result = validate(addon_release_repo, "addon-v0.1.0-addon.6")
    assert result.returncode == 2
    assert result.stdout == ""
    assert reason in result.stderr


@pytest.mark.parametrize("kind", ["leaf", "parent", "fifo", "oversized", "missing", "directory"])
def test_release_metadata_must_be_bounded_regular_files_without_symlink_traversal(
    addon_release_repo: Path, kind: str
) -> None:
    path = addon_release_repo / "addon/local/config.json.template"
    if kind == "parent":
        parent = addon_release_repo / "addon"
        outside = addon_release_repo / "synthetic-outside"
        parent.rename(outside)
        parent.symlink_to(outside, target_is_directory=True)
    elif kind == "leaf":
        outside = addon_release_repo / "synthetic-outside.json"
        path.rename(outside)
        path.symlink_to(outside)
    elif kind == "oversized":
        path.write_bytes(b" " * (1024 * 1024 + 1))
    else:
        path.unlink()
        if kind == "fifo":
            os.mkfifo(path)
        elif kind == "directory":
            path.mkdir()
    result = validate(addon_release_repo, "addon-v0.1.0-addon.6")
    assert result.returncode == 2
    assert result.stdout == ""
    assert "Traceback" not in result.stderr


@pytest.mark.parametrize(
    ("name", "contents"),
    [
        ("addon/local/config.json.template", "null"),
        (
            "addon/local/config.json.template",
            "DUPLICATE_VERSION",
        ),
        ("addon/local/config.json.template", "NONFINITE_VALUE"),
        ("frontend/package.json", '{"version":"SYNTHETIC_PRIVATE_CANARY"'),
        ("frontend/package-lock.json", '{"version":"0.1.0-rc.3","packages":{}}'),
        ("backend/pyproject.toml", "not = valid = toml"),
        ("backend/uv.lock", '[[package]]\nname="other"\nversion="0.1.0rc3"\n'),
        (
            "backend/uv.lock",
            '[[package]]\nname="jukelet"\nversion="0.1.0rc3"\n'
            '[[package]]\nname="jukelet"\nversion="0.1.0rc3"\n',
        ),
        (
            "companion/custom_components/jukelet_bridge/manifest.json",
            '{"domain":"jukelet_bridge","version":"0.1.5rc1"}',
        ),
    ],
)
def test_malformed_ambiguous_or_unrelated_metadata_fails_cleanly(
    addon_release_repo: Path, name: str, contents: str
) -> None:
    path = addon_release_repo / name
    if contents == "DUPLICATE_VERSION":
        contents = path.read_text()[:-1] + ',"version":"0.1.0-addon.6"}'
    elif contents == "NONFINITE_VALUE":
        contents = path.read_text()[:-1] + ',"unexpected":NaN}'
    path.write_text(contents)
    result = validate(addon_release_repo, "addon-v0.1.0-addon.6")
    assert result.returncode == 2
    assert result.stdout == ""
    assert "Traceback" not in result.stderr
    assert "SYNTHETIC_PRIVATE_CANARY" not in result.stderr


@pytest.mark.parametrize(
    ("name", "original", "stale"),
    [
        ("backend/pyproject.toml", 'version = "0.1.0rc3"', 'version = "0.1.0rc2"'),
        ("backend/uv.lock", 'version = "0.1.0rc3"', 'version = "0.1.0rc2"'),
        ("frontend/package.json", '"version": "0.1.0-rc.3"', '"version": "0.1.0-rc.2"'),
        ("frontend/package-lock.json", '"version": "0.1.0-rc.3"', '"version": "0.1.0-rc.2"'),
    ],
)
def test_shared_package_versions_stay_consistent_without_becoming_the_addon_version(
    addon_release_repo: Path, name: str, original: str, stale: str
) -> None:
    path = addon_release_repo / name
    assert original in path.read_text()
    path.write_text(path.read_text().replace(original, stale, 1))
    result = validate(addon_release_repo, "addon-v0.1.0-addon.6")
    assert result.returncode == 2
    assert result.stdout == ""
    assert "shared application version" in result.stderr


@pytest.mark.parametrize("version", ["0.1.0", "1.2.3"])
def test_future_stable_packaging_has_an_exact_separate_identity(
    addon_release_repo: Path, version: str
) -> None:
    path = addon_release_repo / "addon/local/config.json.template"
    config = json.loads(path.read_text())
    config["version"] = version
    path.write_text(json.dumps(config))
    before = {
        p.relative_to(addon_release_repo): p.read_bytes()
        for p in addon_release_repo.rglob("*")
        if p.is_file()
    }
    result = validate(addon_release_repo, f"addon-v{version}", prerelease="false")
    assert result.returncode == 0, result.stderr
    plan = json.loads(result.stdout)
    assert plan["addon_version"] == version
    assert plan["image_reference"] == f"ghcr.io/skoglump/jukelet-addon:{version}"
    assert plan["release_tag"] == f"addon-v{version}"
    assert plan["prerelease"] is False
    assert plan["app_version"] == "0.1.0-rc.3"
    assert plan["integration_source_version"] == "0.1.5"
    assert plan["labels"]["io.hass.version"] == version
    assert plan["labels"]["org.opencontainers.image.version"] == version
    assert {
        p.relative_to(addon_release_repo): p.read_bytes()
        for p in addon_release_repo.rglob("*")
        if p.is_file()
    } == before
    assert result.stderr == ""
