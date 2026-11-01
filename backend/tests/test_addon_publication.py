"""Inert publication-command fixtures; no Docker, GHCR or GitHub writes."""

import copy
import gzip
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import urllib.error
from pathlib import Path
from typing import Any

import pytest
from test_addon_image import Release, packed
from test_addon_image import release as release
from test_addon_promotion import annotate, release_data
from test_addon_promotion import approved as approved

from scripts import addon_registry, addon_runtime, publish_addon
from scripts.addon_image import OCI_MANIFEST
from scripts.addon_promotion import tag_approval


class FakeGitHub(publish_addon.GitHub):
    """In-memory synthetic release service; never calls gh or a remote API."""

    def __init__(self, release: Release, approval: dict[str, Any], inputs: Path, tag_object: str):
        self.value = release_data(release, approval)
        self.contents = {
            item["id"]: (inputs / item["name"]).read_bytes() for item in self.value["assets"]
        }
        self.tag_object = tag_object
        self.uploads: list[str] = []
        self.change_on_download = False

    def json(self, path: str) -> dict[str, Any]:
        if path.startswith("/git/ref/tags/"):
            return {"object": {"type": "tag", "sha": self.tag_object}}
        assert path == "/releases/123"
        return copy.deepcopy(self.value)

    def download(self, asset_id: int, output: Path, size: int) -> None:
        contents = self.contents[asset_id]
        assert len(contents) == size
        with output.open("xb") as stream:
            stream.write(contents)
        if self.change_on_download:
            self.tag_object = "0" * 40

    def upload(self, tag: str, files: list[Path]) -> None:
        assert tag == self.value["tag_name"]
        self.uploads.append(tag)
        for number, path in enumerate(files, 100):
            contents = path.read_bytes()
            self.contents[number] = contents
            self.value["assets"].append(
                {
                    "id": number,
                    "name": path.name,
                    "size": len(contents),
                    "digest": "sha256:" + hashlib.sha256(contents).hexdigest(),
                    "state": "uploaded",
                }
            )


class HttpBody(io.BytesIO):
    def __init__(self, raw: bytes, status: int = 200, headers: dict[str, str] | None = None):
        super().__init__(raw)
        self.status = status
        self.headers = headers or {}


@pytest.fixture
def publisher(
    approved: tuple[Release, dict[str, Any], Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> dict[str, Any]:
    release, approval, inputs = approved
    annotate(release, approval, tmp_path)
    frozen = tag_approval(release.repository, release.plan["release_tag"], release.source)
    fake = FakeGitHub(release, approval, inputs, frozen["tag_object"])
    monkeypatch.setattr(publish_addon, "GitHub", lambda: fake)
    monkeypatch.setenv("ADDON_REGISTRY_TOKEN", "SYNTHETIC_PRIVATE_CANARY")
    monkeypatch.setenv("GITHUB_ACTOR", "synthetic-actor")
    archive = inputs / "jukelet-addon-image.tar"
    artifact = json.loads((inputs / "jukelet-addon-image.artifact.json").read_bytes())
    with tarfile.open(archive) as saved:
        blobs: dict[str, bytes] = {}
        for entry in saved.getmembers():
            stream = saved.extractfile(entry)
            assert stream is not None
            blobs[entry.name] = stream.read()
    config = json.loads(blobs["blobs/sha256/" + artifact["image_id"][7:]])
    manifest = blobs["blobs/sha256/" + artifact["exported_oci_manifest_digest"][7:]]
    state: dict[str, Any] = {
        "release": release,
        "approval": approval,
        "inputs": inputs,
        "frozen": frozen,
        "service": fake,
        "artifact": artifact,
        "commands": [],
        "http": [],
        "published": False,
        "id_kind": "config",
        "absence_status": 404,
        "absence_code": "MANIFEST_UNKNOWN",
        "corrupt_blob": False,
        "digest_header": True,
    }

    def docker(arguments: list[str], *, password: str | None = None) -> bytes:
        state["commands"].append(arguments)
        assert arguments[0] == "docker"
        assert "build" not in arguments and "tag" not in arguments
        if arguments[1:3] == ["image", "inspect"]:
            reference = arguments[-1]
            image_id = (
                artifact["image_id"]
                if state["id_kind"] == "config"
                else artifact["exported_oci_manifest_digest"]
            )
            return packed(
                {
                    "Id": image_id,
                    "Descriptor": {"digest": image_id},
                    "Architecture": "amd64",
                    "Os": "linux",
                    "Config": config["config"],
                    "RootFS": {"Type": "layers", "Layers": artifact["layer_diff_ids"]},
                    "RepoDigests": [reference] if "@" in reference else [],
                }
            )
        if arguments[1:3] == ["image", "save"]:
            shutil.copyfile(archive, arguments[4])
        elif arguments[1] == "login":
            assert password == "SYNTHETIC_PRIVATE_CANARY"
            assert any(item[1] == "run" for item in state["commands"])
        elif arguments[1:3] == ["image", "push"]:
            assert arguments[-1] == release.plan["image_reference"]
            state["published"] = True
        elif arguments[1:3] == ["image", "pull"]:
            assert arguments[-1] == release.plan["image"] + "@" + state.get(
                "top_digest", artifact["exported_oci_manifest_digest"]
            )
        elif arguments[1] == "run":
            assert arguments[arguments.index("--network") + 1] == "none"
            if state.get("change_tag_on_run"):
                fake.tag_object = "0" * 40
        else:
            assert arguments[1:3] == ["image", "load"]
        return b""

    def http(
        url: str, token: str, *, basic: bool = False, accept: str = addon_registry.ACCEPT
    ) -> HttpBody:
        state["http"].append(url)
        if state.get("network_error"):
            raise urllib.error.URLError("SYNTHETIC_PRIVATE_CANARY")
        assert url.startswith("https://ghcr.io/")
        if url.startswith("https://ghcr.io/token?"):
            assert basic and token
            assert accept == "application/json"
            return HttpBody(packed({"token": "synthetic-bearer"}))
        assert token == "synthetic-bearer"
        if "/manifests/" in url:
            if not state["published"]:
                return HttpBody(
                    packed({"errors": [{"code": state["absence_code"]}]}),
                    status=state["absence_status"],
                )
            body = manifest
            if state.get("gzip_layers") or state.get("wrong_filesystem"):
                modified = json.loads(manifest)
                original = modified["layers"][0]
                data = blobs["blobs/sha256/" + original["digest"][7:]]
                if state.get("wrong_filesystem"):
                    data = b"SYNTHETIC different filesystem bytes with valid blob digest"
                elif state.get("gzip_layers"):
                    data = gzip.compress(data, mtime=0)
                    original["mediaType"] += "+gzip"
                original["digest"] = "sha256:" + hashlib.sha256(data).hexdigest()
                original["size"] = len(data)
                blobs["blobs/sha256/" + original["digest"][7:]] = data
                body = packed(modified)
            state["top_digest"] = "sha256:" + hashlib.sha256(body).hexdigest()
            if state.get("index"):
                child_digest = state["top_digest"]
                index = packed(
                    {
                        "schemaVersion": 2,
                        "mediaType": "application/vnd.oci.image.index.v1+json",
                        "manifests": [
                            {
                                "mediaType": OCI_MANIFEST,
                                "digest": child_digest,
                                "size": len(body),
                                "platform": {"architecture": "amd64", "os": "linux"},
                            }
                        ],
                    }
                )
                state["top_digest"] = "sha256:" + hashlib.sha256(index).hexdigest()
                if not url.endswith(child_digest):
                    body = index
            return HttpBody(
                body,
                headers={
                    "Docker-Content-Digest": "sha256:" + hashlib.sha256(body).hexdigest()
                    if state["digest_header"]
                    else "sha256:" + "0" * 64
                },
            )
        assert "/blobs/sha256:" in url
        assert accept == "application/octet-stream"
        contents = blobs["blobs/sha256/" + url.rsplit(":", 1)[1]]
        if state["corrupt_blob"]:
            contents = contents[:-1] + b"x"
        return HttpBody(contents)

    monkeypatch.setattr(addon_runtime, "command", docker)
    monkeypatch.setattr(publish_addon, "command", docker)
    monkeypatch.setattr(addon_registry, "response", http)
    return state


def invoke(publisher: dict[str, Any], work: Path, phase: str = "publish") -> dict[str, Any]:
    release = publisher["release"]
    event = {
        "action": "published",
        "repository": {"full_name": "skoglump/jukelet"},
        "release": publisher["service"].value,
    }
    return publish_addon.execute(
        phase, release.repository, event, release.source, work, publisher["frozen"]["tag_object"]
    )


@pytest.mark.parametrize("id_kind", ["config", "manifest"])
def test_approved_archive_is_promoted_once_and_effective_bytes_and_outputs_are_read_back(
    publisher: dict[str, Any], tmp_path: Path, id_kind: str
) -> None:
    publisher["id_kind"] = id_kind
    result = invoke(publisher, tmp_path / "promote")
    assert (
        result["registry_manifest_digest"] == publisher["artifact"]["exported_oci_manifest_digest"]
    )
    assert len([item for item in publisher["commands"] if item[1:3] == ["image", "push"]]) == 1
    assert len(publisher["service"].uploads) == 1
    assert len(publisher["service"].value["assets"]) == 6
    receipt = json.loads((tmp_path / "promote/outputs/jukelet-addon-registry.json").read_bytes())
    assert receipt["image_id"] == publisher["artifact"]["image_id"]
    assert receipt["loaded_image"]["docker_inspect_id_kind"] == (
        "config-digest" if id_kind == "config" else "platform-manifest-digest"
    )
    assert "SYNTHETIC_PRIVATE_CANARY" not in json.dumps(receipt)
    with pytest.raises(ValueError, match="assets"):
        invoke(publisher, tmp_path / "retry")
    assert len(publisher["service"].uploads) == 1


@pytest.mark.parametrize(
    "failure",
    ["downloaded_bytes", "changed_tag", "existing_outputs", "immutable", "missing_immutable"],
)
def test_validation_failure_prevents_all_docker_credentials_and_publication(
    publisher: dict[str, Any], tmp_path: Path, failure: str
) -> None:
    service = publisher["service"]
    if failure == "downloaded_bytes":
        asset = service.value["assets"][0]
        original = service.contents[asset["id"]]
        service.contents[asset["id"]] = original[:-1] + b"x"
    elif failure == "changed_tag":
        service.change_on_download = True
    elif failure == "immutable":
        service.value["immutable"] = True
    elif failure == "missing_immutable":
        service.value.pop("immutable")
    else:
        service.value["assets"].append({"name": "jukelet-addon-registry.json"})
    with pytest.raises(ValueError):
        invoke(publisher, tmp_path / "failed")
    assert publisher["commands"] == []
    assert publisher["http"] == []
    assert service.uploads == []


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (401, "UNAUTHORIZED"),
        (403, "DENIED"),
        (404, "UNAUTHORIZED"),
        (404, "SYNTHETIC_UNKNOWN"),
        (429, "TOOMANYREQUESTS"),
        (500, "UNKNOWN"),
    ],
)
def test_ambiguous_or_denied_registry_absence_never_pushes(
    publisher: dict[str, Any], tmp_path: Path, status: int, code: str
) -> None:
    publisher["absence_status"] = status
    publisher["absence_code"] = code
    with pytest.raises(ValueError):
        invoke(publisher, tmp_path / "failed")
    assert not any(item[1:3] == ["image", "push"] for item in publisher["commands"])
    assert publisher["service"].uploads == []


@pytest.mark.parametrize("failure", ["existing_tag", "corrupt_blob", "digest_header"])
def test_existing_tags_or_failed_effective_readback_never_attach_success(
    publisher: dict[str, Any], tmp_path: Path, failure: str
) -> None:
    if failure == "existing_tag":
        publisher["published"] = True
    elif failure == "corrupt_blob":
        publisher["corrupt_blob"] = True
    else:
        publisher["digest_header"] = False
    with pytest.raises(ValueError):
        invoke(publisher, tmp_path / "failed")
    pushes = [item for item in publisher["commands"] if item[1:3] == ["image", "push"]]
    assert len(pushes) == (0 if failure == "existing_tag" else 1)
    assert publisher["service"].uploads == []


def test_single_amd64_registry_index_is_verified_separately_from_config_identity(
    publisher: dict[str, Any], tmp_path: Path
) -> None:
    publisher["index"] = True
    result = invoke(publisher, tmp_path / "indexed")
    assert result["registry_index_digest"] == publisher["top_digest"]
    assert (
        result["registry_manifest_digest"] == publisher["artifact"]["exported_oci_manifest_digest"]
    )
    assert result["registry_index_digest"] != publisher["artifact"]["image_id"]


def test_registry_recompression_preserves_the_approved_config_and_uncompressed_layers(
    publisher: dict[str, Any], tmp_path: Path
) -> None:
    publisher["gzip_layers"] = True
    result = invoke(publisher, tmp_path / "compressed")
    assert result["registry_manifest_digest"] == publisher["top_digest"]
    assert (
        result["registry_manifest_digest"] != publisher["artifact"]["exported_oci_manifest_digest"]
    )


def test_valid_registry_blob_hash_cannot_hide_another_filesystem(
    publisher: dict[str, Any], tmp_path: Path
) -> None:
    publisher["wrong_filesystem"] = True
    with pytest.raises(ValueError, match="diffID"):
        invoke(publisher, tmp_path / "wrong-filesystem")
    assert publisher["service"].uploads == []


def test_changed_input_identity_after_image_probe_prevents_credentials(
    publisher: dict[str, Any], tmp_path: Path
) -> None:
    publisher["change_tag_on_run"] = True
    with pytest.raises(ValueError, match="tag changed"):
        invoke(publisher, tmp_path / "changed")
    assert publisher["http"] == []
    assert not any(item[1] == "login" for item in publisher["commands"])
    assert publisher["service"].uploads == []


def test_registry_transport_errors_never_become_absence(
    publisher: dict[str, Any], tmp_path: Path
) -> None:
    publisher["network_error"] = True
    with pytest.raises(urllib.error.URLError):
        invoke(publisher, tmp_path / "network-error")
    assert not any(item[1:3] == ["image", "push"] for item in publisher["commands"])
    assert publisher["service"].uploads == []


@pytest.mark.parametrize("release", ["1.0.0"], indirect=True)
def test_future_approved_stable_promotes_only_its_exact_addon_tag(
    publisher: dict[str, Any], tmp_path: Path
) -> None:
    result = invoke(publisher, tmp_path / "stable")
    assert result["image_reference"] == "ghcr.io/skoglump/jukelet-addon:1.0.0"
    pushes = [item for item in publisher["commands"] if item[1:3] == ["image", "push"]]
    assert pushes == [["docker", "image", "push", "ghcr.io/skoglump/jukelet-addon:1.0.0"]]


@pytest.mark.parametrize("size", [4, 128, len(b"SYNTHETIC_PRIVATE_CANARY")])
def test_asset_download_command_is_bounded_and_exclusive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, size: int
) -> None:
    executable = tmp_path / "gh"
    executable.write_text(
        f"#!{sys.executable}\nimport sys\nsys.stdout.buffer.write(b'SYNTHETIC_PRIVATE_CANARY')\n"
    )
    executable.chmod(0o700)
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ["PATH"])
    output = tmp_path / "download"
    if size == len(b"SYNTHETIC_PRIVATE_CANARY"):
        publish_addon.GitHub().download(123, output, size)
        assert output.read_bytes() == b"SYNTHETIC_PRIVATE_CANARY"
        with pytest.raises(FileExistsError):
            publish_addon.GitHub().download(123, output, size)
    else:
        with pytest.raises(ValueError, match="exceeds|incomplete"):
            publish_addon.GitHub().download(123, output, size)


def test_workflow_command_rejects_wrong_repository_without_gh_or_credential_output(
    tmp_path: Path,
) -> None:
    root = Path(__file__).resolve().parents[2]
    lines = (root / ".github/workflows/publish-addon.yml").read_text().splitlines()
    commands = [
        line.split("run: ", 1)[1]
        for line in lines
        if "run: python -m scripts.publish_addon validate " in line
    ]
    assert len(commands) == 1
    event = tmp_path / "event.json"
    event.write_text(
        json.dumps(
            {
                "action": "published",
                "repository": {"full_name": "synthetic/wrong"},
                "release": {
                    "id": 123,
                    "tag_name": "addon-v0.1.0-addon.7",
                    "draft": False,
                    "prerelease": True,
                },
            }
        )
    )
    spy = tmp_path / "gh"
    marker = tmp_path / "unexpected-gh-call"
    spy.write_text(
        f"#!{sys.executable}\nfrom pathlib import Path\n"
        f"Path({str(marker)!r}).write_text('unexpected')\nraise SystemExit(1)\n"
    )
    spy.chmod(0o700)
    result = subprocess.run(
        ["bash", "-e", "-c", commands[0]],
        cwd=root,
        env=os.environ
        | {
            "GITHUB_EVENT_PATH": str(event),
            "GITHUB_SHA": "0" * 40,
            "RUNNER_TEMP": str(tmp_path),
            "GH_TOKEN": "SYNTHETIC_PRIVATE_CANARY",
            "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"],
        },
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert result.stdout == ""
    assert "SYNTHETIC_PRIVATE_CANARY" not in result.stderr
    assert "promotion failed" in result.stderr
    assert not marker.exists()
    assert not (tmp_path / "addon-validate").exists()


def test_validation_cli_downloads_real_fixture_bytes_through_inert_gh_executable(
    approved: tuple[Release, dict[str, Any], Path], tmp_path: Path
) -> None:
    release, approval, inputs = approved
    annotate(release, approval, tmp_path)
    frozen = tag_approval(release.repository, release.plan["release_tag"], release.source)
    metadata = tmp_path / "release.json"
    value = release_data(release, approval)
    metadata.write_bytes(packed(value))
    mapping = {str(item["id"]): str(inputs / item["name"]) for item in value["assets"]}
    event = tmp_path / "event.json"
    event.write_bytes(
        packed(
            {
                "action": "published",
                "repository": {"full_name": "skoglump/jukelet"},
                "release": value,
            }
        )
    )
    binary = tmp_path / "gh"
    tag_json = json.dumps({"object": {"type": "tag", "sha": frozen["tag_object"]}})
    binary.write_text(
        f"#!{sys.executable}\nimport json, sys\nfrom pathlib import Path\n"
        "target = sys.argv[-1]\n"
        "if '/git/ref/tags/' in target:\n"
        f"    print({tag_json!r})\n"
        "elif target.endswith('/releases/123'):\n"
        f"    sys.stdout.buffer.write(Path({str(metadata)!r}).read_bytes())\n"
        "elif '/releases/assets/' in target:\n"
        f"    files = {mapping!r}\n"
        "    sys.stdout.buffer.write(Path(files[target.rsplit('/', 1)[1]]).read_bytes())\n"
        "else:\n    raise SystemExit(10)\n"
    )
    binary.chmod(0o700)
    output = tmp_path / "github-output"
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "scripts.publish_addon",
            "validate",
            "--repository",
            str(release.repository),
            "--event",
            str(event),
            "--source",
            release.source,
            "--work",
            str(tmp_path / "validated"),
        ],
        cwd=root,
        env=os.environ
        | {
            "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"],
            "GH_TOKEN": "SYNTHETIC_PRIVATE_CANARY",
            "GITHUB_OUTPUT": str(output),
        },
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert (
        json.loads(result.stdout)["archive_sha256"]
        == approval["assets"]["jukelet-addon-image.tar"]["sha256"]
    )
    assert output.read_text() == "tag_object=" + frozen["tag_object"] + "\n"
    assert "SYNTHETIC_PRIVATE_CANARY" not in result.stdout + result.stderr


@pytest.mark.parametrize(
    "location",
    [
        "http://pkg-containers.githubusercontent.com/blob",
        "https://synthetic.invalid/blob",
        "https://user@ghcr.io/blob",
        "https://ghcr.io:8443/blob",
    ],
)
def test_registry_blob_redirects_cannot_send_credentials_outside_the_supported_boundary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, location: str
) -> None:
    calls: list[tuple[str, str]] = []

    def http(
        url: str, token: str, *, basic: bool = False, accept: str = addon_registry.ACCEPT
    ) -> HttpBody:
        calls.append((url, token))
        return HttpBody(b"", status=307, headers={"Location": location})

    monkeypatch.setattr(addon_registry, "response", http)
    with pytest.raises(ValueError, match="redirect"):
        addon_registry.Registry("SYNTHETIC_PRIVATE_CANARY").blob(
            {"digest": "sha256:" + "0" * 64, "size": 1}, tmp_path / "blob"
        )
    assert len(calls) == 1


def test_supported_blob_cdn_redirect_drops_bearer_and_checks_actual_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    contents = b"SYNTHETIC blob"
    calls: list[tuple[str, str]] = []

    def http(
        url: str, token: str, *, basic: bool = False, accept: str = addon_registry.ACCEPT
    ) -> HttpBody:
        calls.append((url, token))
        assert accept == "application/octet-stream"
        if len(calls) == 1:
            return HttpBody(
                b"",
                status=307,
                headers={
                    "Location": "https://pkg-containers.githubusercontent.com/blob?synthetic=signed"
                },
            )
        return HttpBody(contents)

    monkeypatch.setattr(addon_registry, "response", http)
    path = tmp_path / "blob"
    addon_registry.Registry("SYNTHETIC_PRIVATE_CANARY").blob(
        {"digest": "sha256:" + hashlib.sha256(contents).hexdigest(), "size": len(contents)}, path
    )
    assert path.read_bytes() == contents
    assert calls[0][1] == "SYNTHETIC_PRIVATE_CANARY"
    assert calls[1][1] == ""
