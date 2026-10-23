"""Exercise the release CLI against synthetic package metadata, without registry access."""

import subprocess
import sys
from pathlib import Path

import pytest


@pytest.fixture
def release_repo(tmp_path: Path) -> Path:
    backend, frontend = tmp_path / "backend", tmp_path / "frontend"
    backend.mkdir()
    frontend.mkdir()
    (backend / "pyproject.toml").write_text('[project]\nname = "jukelet"\nversion = "1.2.3"\n')
    (backend / "uv.lock").write_text(
        '[[package]]\nname = "unrelated"\nversion = "9.9.9"\n'
        '[[package]]\nname = "jukelet"\nversion = "1.2.3"\nsource = { editable = "." }\n'
    )
    (frontend / "package.json").write_text('{"version":"1.2.3"}')
    (frontend / "package-lock.json").write_text(
        '{"version":"1.2.3","packages":{"":{"version":"1.2.3"}}}'
    )
    return tmp_path


def run_release(root: Path, tag: str) -> subprocess.CompletedProcess[str]:
    script = Path(__file__).resolve().parents[2] / "scripts/check_release.py"
    return subprocess.run(
        [sys.executable, str(script), tag],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )


def test_release_rejects_a_tag_that_differs_from_the_application(release_repo: Path) -> None:
    result = run_release(release_repo, "v1.2.4")
    assert result.returncode == 2
    assert result.stdout == ""
    assert "backend/pyproject.toml" in result.stderr


@pytest.mark.parametrize("tag", ["1.2.3", "v1.2.3"])
def test_release_accepts_matching_stable_versions(release_repo: Path, tag: str) -> None:
    result = run_release(release_repo, tag)
    assert result.returncode == 0, result.stderr
    assert result.stdout == "1.2.3\n"
    assert result.stderr == ""


@pytest.mark.parametrize(
    "tag",
    ["", "latest", "1.2", "v01.2.3", "vv1.2.3", "1.2.3-rc.1", "1.2.3+build", "1.2.3\n"],
)
def test_release_rejects_unsupported_tags(release_repo: Path, tag: str) -> None:
    result = run_release(release_repo, tag)
    assert result.returncode == 2
    assert result.stdout == ""
    assert "release tag must be" in result.stderr


@pytest.mark.parametrize(
    ("path", "content"),
    [
        ("backend/uv.lock", '[[package]]\nname = "jukelet"\nversion = "1.2.4"\n'),
        ("frontend/package.json", '{"version":"1.2.4"}'),
        (
            "frontend/package-lock.json",
            '{"version":"1.2.4","packages":{"":{"version":"1.2.3"}}}',
        ),
        (
            "frontend/package-lock.json",
            '{"version":"1.2.3","packages":{"":{"version":"1.2.4"}}}',
        ),
    ],
)
def test_release_rejects_each_stale_package_version(
    release_repo: Path, path: str, content: str
) -> None:
    (release_repo / path).write_text(content)
    result = run_release(release_repo, "v1.2.3")
    assert result.returncode == 2
    assert result.stdout == ""
    assert path in result.stderr


@pytest.mark.parametrize(
    ("path", "content"),
    [
        ("backend/uv.lock", '[[package]]\nname = "another-project"\nversion = "1.2.3"\n'),
        (
            "backend/uv.lock",
            '[[package]]\nname = "jukelet"\nversion = "1.2.3"\n'
            '[[package]]\nname = "jukelet"\nversion = "1.2.3"\n',
        ),
        ("backend/uv.lock", "not valid toml"),
        ("frontend/package.json", "not valid json"),
        ("frontend/package.json", "null"),
        ("frontend/package-lock.json", '{"version":"1.2.3","packages":{}}'),
    ],
)
def test_release_fails_cleanly_on_malformed_metadata(
    release_repo: Path, path: str, content: str
) -> None:
    (release_repo / path).write_text(content)
    result = run_release(release_repo, "1.2.3")
    assert result.returncode == 2
    assert result.stdout == ""
    assert "Traceback" not in result.stderr


def test_release_fails_cleanly_when_metadata_is_missing(release_repo: Path) -> None:
    (release_repo / "backend/uv.lock").unlink()
    result = run_release(release_repo, "1.2.3")
    assert result.returncode == 2
    assert result.stdout == ""
    assert "Traceback" not in result.stderr
