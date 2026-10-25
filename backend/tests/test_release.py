"""Exercise the release CLI against synthetic package metadata, without registry access."""

import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
import yaml


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


def run_release(
    root: Path, tag: str, *, prerelease: str | None = None
) -> subprocess.CompletedProcess[str]:
    script = Path(__file__).resolve().parents[2] / "scripts/check_release.py"
    return subprocess.run(
        [sys.executable, str(script), tag]
        + ([] if prerelease is None else ["--prerelease", prerelease]),
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )


def candidate_versions(root: Path) -> None:
    for path in ("backend/pyproject.toml", "backend/uv.lock"):
        target = root / path
        target.write_text(target.read_text().replace('"1.2.3"', '"1.2.3rc1"'))
    for path in ("frontend/package.json", "frontend/package-lock.json"):
        target = root / path
        target.write_text(target.read_text().replace('"1.2.3"', '"1.2.3-rc.1"'))


@pytest.mark.parametrize("tag", ["1.2.3-rc.1", "v1.2.3-rc.1"])
def test_release_accepts_reviewed_candidate_with_canonical_package_versions(
    release_repo: Path,
    tag: str,
) -> None:
    candidate_versions(release_repo)
    result = run_release(release_repo, tag, prerelease="true")
    assert result.returncode == 0, result.stderr
    assert result.stdout == "1.2.3-rc.1\n"
    assert result.stderr == ""


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
    [
        "",
        "latest",
        "1.2",
        "v01.2.3",
        "vv1.2.3",
        "1.2.3+build",
        "1.2.3\n",
        "1.2.3-beta.1",
        "1.2.3-rc",
        "1.2.3-rc.01",
        "1.2.3-rc.-1",
        "1.2.3-rc.1+build",
    ],
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


@pytest.mark.parametrize(
    ("tag", "flag"),
    [("v1.2.3", "true"), ("v1.2.3-rc.1", "false")],
)
def test_release_rejects_a_github_flag_that_disagrees_with_the_tag(
    release_repo: Path,
    tag: str,
    flag: str,
) -> None:
    result = run_release(release_repo, tag, prerelease=flag)
    assert result.returncode == 2
    assert result.stdout == ""
    assert "GitHub prerelease flag" in result.stderr


@pytest.mark.parametrize("flag", ["", "TRUE", "1", "yes"])
def test_release_rejects_invalid_prerelease_flags(release_repo: Path, flag: str) -> None:
    result = run_release(release_repo, "v1.2.3", prerelease=flag)
    assert result.returncode == 2
    assert result.stdout == ""
    assert "invalid choice" in result.stderr


@pytest.mark.parametrize(
    ("path", "wrong_version"),
    [
        ("backend/pyproject.toml", "1.2.3-rc.1"),
        ("backend/uv.lock", "1.2.3RC1"),
        ("frontend/package.json", "1.2.3rc1"),
        ("frontend/package-lock.json", "1.2.3"),
    ],
)
def test_candidate_rejects_noncanonical_or_stable_package_versions(
    release_repo: Path,
    path: str,
    wrong_version: str,
) -> None:
    candidate_versions(release_repo)
    target = release_repo / path
    original = "1.2.3rc1" if path.startswith("backend/") else "1.2.3-rc.1"
    target.write_text(target.read_text().replace(original, wrong_version))
    result = run_release(release_repo, "v1.2.3-rc.1", prerelease="true")
    assert result.returncode == 2
    assert result.stdout == ""
    assert path in result.stderr


def workflow_validation(root: Path, tag: str, flag: str) -> subprocess.CompletedProcess[str]:
    repository = Path(__file__).resolve().parents[2]
    workflow = yaml.safe_load((repository / ".github/workflows/publish-docker.yml").read_text())
    steps = workflow["jobs"]["validate"]["steps"]
    validation = next(step for step in steps if step.get("id") == "version")
    (root / "scripts").mkdir()
    (root / "scripts/check_release.py").write_text(
        (repository / "scripts/check_release.py").read_text()
    )
    return subprocess.run(
        ["bash", "-e", "-o", "pipefail"],
        input=validation["run"],
        cwd=root,
        env={
            "PATH": str(Path(sys.executable).parent) + os.pathsep + os.defpath,
            "RELEASE_TAG": tag,
            "RELEASE_PRERELEASE": flag,
            "GITHUB_REPOSITORY": "synthetic/jukelet",
            "GITHUB_OUTPUT": str(root / "output"),
        },
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize("candidate", [False, True])
def test_release_workflow_produces_only_the_allowed_image_tags(
    release_repo: Path,
    candidate: bool,
) -> None:
    if candidate:
        candidate_versions(release_repo)
    result = workflow_validation(
        release_repo, "v1.2.3-rc.1" if candidate else "v1.2.3", "true" if candidate else "false"
    )
    assert result.returncode == 0, result.stderr
    output = (release_repo / "output").read_text()
    images = re.search(r"^tags<<([^\n]+)\n(.*?)\n\1$", output, re.MULTILINE | re.DOTALL)
    assert images is not None, output
    assert images[2].splitlines() == (
        ["ghcr.io/synthetic/jukelet:1.2.3-rc.1"]
        if candidate
        else [
            "ghcr.io/synthetic/jukelet:1.2.3",
            "ghcr.io/synthetic/jukelet:1.2",
            "ghcr.io/synthetic/jukelet:latest",
        ]
    )


@pytest.mark.parametrize(("tag", "flag"), [("v1.2.3", "true"), ("v1.2.3-rc.1", "false")])
def test_release_workflow_produces_no_image_outputs_for_mismatched_flags(
    release_repo: Path,
    tag: str,
    flag: str,
) -> None:
    result = workflow_validation(release_repo, tag, flag)
    assert result.returncode != 0
    assert not (release_repo / "output").exists()


def test_release_workflow_gates_package_writes_on_validation_and_complete_ci() -> None:
    repository = Path(__file__).resolve().parents[2]
    workflow = yaml.safe_load((repository / ".github/workflows/publish-docker.yml").read_text())
    jobs = workflow["jobs"]
    # Interpret this deliberately narrow gate, rather than allowing a condition
    # that also skips app RCs/stable releases or permits an integration image push.
    condition = jobs["validate"]["if"]
    gate = re.fullmatch(
        r"\$\{\{ !startsWith\(github\.event\.release\.tag_name, '([^']+)'\) \}\}",
        condition,
    )
    assert gate is not None, condition
    for tag, must_validate in (
        ("v1.2.3", True),
        ("1.2.3", True),
        ("v1.2.3-rc.1", True),
        ("1.2.3-rc.1", True),
        ("integration-v0.1.1", False),
    ):
        assert (not tag.casefold().startswith(gate[1].casefold())) is must_validate, tag
    assert "if" not in jobs["verify"] and "if" not in jobs["publish"]
    assert jobs["verify"]["needs"] == "validate"
    assert jobs["verify"]["uses"] == "./.github/workflows/ci.yml"
    assert set(jobs["publish"]["needs"]) == {"validate", "verify"}
    assert workflow["permissions"] == {"contents": "read"}
    assert workflow["concurrency"]["queue"] == "max"
    assert workflow["concurrency"]["cancel-in-progress"] is False
    assert jobs["publish"]["permissions"] == {"contents": "read", "packages": "write"}
    assert "permissions" not in jobs["validate"] and "permissions" not in jobs["verify"]
    validation = next(step for step in jobs["validate"]["steps"] if step.get("id") == "version")
    assert (
        validation["env"]["RELEASE_PRERELEASE"] == "${{ toJSON(github.event.release.prerelease) }}"
    )
    image = next(step for step in jobs["publish"]["steps"] if step.get("id") == "image")
    assert image["with"]["tags"] == "${{ needs.validate.outputs.tags }}"
    assert image["with"]["platforms"] == "linux/amd64"
