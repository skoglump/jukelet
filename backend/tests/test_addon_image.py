"""Small synthetic image archives; no Docker build, daemon, HA or registry access."""

import gzip
import hashlib
import io
import json
import subprocess
import sys
import tarfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from scripts.addon_release import prepare, record_registry_receipt, seal_archive, verify_archive

ROOT = Path(__file__).resolve().parents[2]
OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
OCI_CONFIG = "application/vnd.oci.image.config.v1+json"
OCI_LAYER = "application/vnd.oci.image.layer.v1.tar"


def packed(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def sha(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


@dataclass
class Release:
    repository: Path
    prepared: Path
    source: str
    plan: dict[str, Any]


@pytest.fixture
def release(tmp_path: Path, request: pytest.FixtureRequest) -> Release:
    repository = tmp_path / "source"
    names = (ROOT / "addon/local/context-files.txt").read_text().splitlines() + [
        "addon/local/context-files.txt",
        "addon/local/config.json.template",
        "addon/local/Dockerfile.addon",
        "addon/local/translations/en.yaml",
        "companion/custom_components/jukelet_bridge/manifest.json",
    ]
    for name in names:
        target = repository / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
    selected = getattr(request, "param", None)
    if selected is not None:
        config_path = repository / "addon/local/config.json.template"
        config = json.loads(config_path.read_text())
        config["version"] = selected
        config_path.write_bytes(packed(config))
    subprocess.run(["git", "init", "-q", str(repository)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repository), "add", "."], check=True, capture_output=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(repository),
            "-c",
            "user.name=Synthetic",
            "-c",
            "user.email=synthetic@example.invalid",
            "commit",
            "-qm",
            "Synthetic archive source",
        ],
        check=True,
        capture_output=True,
    )
    source = subprocess.check_output(
        ["git", "-C", str(repository), "rev-parse", "HEAD"], text=True
    ).strip()
    version = json.loads((repository / "addon/local/config.json.template").read_text())["version"]
    folder = tmp_path / "prepared"
    plan = prepare(
        repository, source, f"addon-v{version}", prerelease="-addon." in version, output=folder
    )
    return Release(repository, folder, source, plan)


def image_archive(
    release: Release,
    path: Path,
    *,
    modern: bool,
    compressed: bool = False,
    mutation: str = "",
    repository_record: bool = False,
) -> tuple[bytes, bytes, str]:
    layer_buffer = io.BytesIO()
    provenance = (release.prepared / "context/jukelet/build-info.json").read_bytes()
    if mutation == "provenance":
        provenance = b"SYNTHETIC_PRIVATE_CANARY"
    with tarfile.open(fileobj=layer_buffer, mode="w") as layer:
        directory = tarfile.TarInfo("app")
        directory.type = tarfile.DIRTYPE
        if mutation == "provenance_parent":
            directory.type = tarfile.SYMTYPE
            directory.linkname = "/tmp"
        layer.addfile(directory)
        member = tarfile.TarInfo("app/addon-build-info.json")
        member.size = len(provenance)
        if mutation == "provenance_symlink":
            member.type = tarfile.SYMTYPE
            member.linkname = "elsewhere"
            member.size = 0
            layer.addfile(member)
        elif mutation != "missing_provenance":
            layer.addfile(member, io.BytesIO(provenance))
        if mutation == "provenance_hidden":
            layer.addfile(tarfile.TarInfo("app/.wh.addon-build-info.json"))
        elif mutation == "inner_traversal":
            layer.addfile(tarfile.TarInfo("../synthetic-escape"))
    uncompressed = layer_buffer.getvalue()
    data = gzip.compress(uncompressed, mtime=0) if compressed else uncompressed
    config: dict[str, Any] = {
        "architecture": "aarch64" if mutation == "architecture" else "amd64",
        "os": "linux",
        "config": {
            "User": "0:0",
            "Entrypoint": ["python", "-m", "jukelet.addon"],
            "Cmd": [],
            "Env": ["APP_MODE=read_only"],
            "Labels": dict(release.plan["labels"]),
        },
        "rootfs": {"type": "layers", "diff_ids": [sha(uncompressed)]},
    }
    if mutation == "labels":
        config["config"]["Labels"]["org.opencontainers.image.revision"] = "0" * 40
    elif mutation == "credentials":
        config["config"]["Env"] = ["SUPERVISOR_TOKEN=SYNTHETIC_PRIVATE_CANARY"]
    elif mutation == "extra_env":
        config["config"]["Env"].append("SYNTHETIC_EXTRA=changed")
    elif mutation == "entrypoint":
        config["config"]["Entrypoint"] = ["python", "-m", "uvicorn"]
    elif mutation == "diff_id":
        config["rootfs"]["diff_ids"] = ["sha256:" + "0" * 64]
    config_bytes = packed(config)
    config_digest = sha(config_bytes)
    config_name = "blobs/sha256/" + config_digest[7:] if modern else config_digest[7:] + ".json"
    if mutation == "config_path":
        config_name = "blobs/sha256/" + "0" * 64
    layer_name = "blobs/sha256/" + sha(data)[7:] if modern else "f" * 64 + "/layer.tar"
    layer_descriptor = {
        "mediaType": OCI_LAYER + ("+gzip" if compressed else ""),
        "digest": sha(data),
        "size": len(data),
    }
    exported_manifest = packed(
        {
            "schemaVersion": 2,
            "mediaType": OCI_MANIFEST,
            "config": {"mediaType": OCI_CONFIG, "digest": config_digest, "size": len(config_bytes)},
            "layers": [layer_descriptor],
        }
    )
    docker_manifest: dict[str, Any] = {
        "Config": config_name,
        "RepoTags": [release.plan["image_reference"]],
        "Layers": [layer_name],
    }
    if mutation == "tag":
        docker_manifest["RepoTags"] = ["ghcr.io/skoglump/jukelet:0.1.0-rc.3"]
    compatibility: dict[str, Any] = {
        "id": "f" * 64,
        "created": "2026-01-01T00:00:00Z",
        "container_config": {},
        "architecture": "amd64",
        "os": "linux",
        "config": config["config"],
    }
    members: dict[str, bytes] = {
        config_name: config_bytes,
        layer_name: data,
        "manifest.json": packed([docker_manifest]),
    }
    if modern:
        docker_manifest["LayerSources"] = {sha(uncompressed): layer_descriptor}
        index: dict[str, Any] = {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [
                {
                    "mediaType": OCI_MANIFEST,
                    "digest": sha(exported_manifest),
                    "size": len(exported_manifest),
                }
            ],
        }
        if repository_record:
            index["manifests"][0]["annotations"] = {
                "io.containerd.image.name": release.plan["image_reference"],
                "org.opencontainers.image.ref.name": release.plan["image_reference"].rsplit(":", 1)[
                    1
                ],
            }
        if mutation == "index_platform":
            index["manifests"][0]["platform"] = {"os": "linux", "architecture": "arm64"}
        elif mutation == "index_alias":
            index["manifests"][0]["annotations"] = {
                "io.containerd.image.name": "ghcr.io/skoglump/jukelet:latest"
            }
        elif mutation == "index_type":
            index["mediaType"] = "application/synthetic-unknown"
        elif mutation == "compatibility_extra":
            compatibility["unexpected"] = "SYNTHETIC_PRIVATE_CANARY"
        elif mutation == "compatibility_architecture":
            compatibility["architecture"] = "arm64"
        elif mutation == "compatibility_config":
            compatibility["config"] = {**config["config"], "Entrypoint": ["synthetic-other"]}
        members.update(
            {
                "manifest.json": packed([docker_manifest]),
                "index.json": packed(index),
                "oci-layout": packed({"imageLayoutVersion": "1.0.0"}),
                "blobs/sha256/" + sha(exported_manifest)[7:]: exported_manifest,
                "blobs/sha256/" + sha(packed(compatibility))[7:]: packed(compatibility),
            }
        )
    else:
        members["f" * 64 + "/json"] = packed(compatibility)
        members["f" * 64 + "/VERSION"] = b"1.0"
    if not modern or repository_record or mutation.startswith("repository_"):
        repository, version = release.plan["image_reference"].rsplit(":", 1)
        final_layer_id = sha(data)[7:] if modern else "f" * 64
        tags: dict[str, Any] = {version: final_layer_id}
        repositories: Any = {repository: tags}
        if mutation in {"legacy_tag", "repository_target"}:
            tags[version] = "0" * 64
        elif mutation == "repository_config":
            tags[version] = config_digest[7:]
        elif mutation == "repository_path":
            tags[version] = layer_name
        elif mutation == "repository_name":
            repositories = {"ghcr.io/skoglump/jukelet": tags}
        elif mutation == "repository_version":
            repositories = {repository: {"latest": final_layer_id}}
        elif mutation == "repository_alias":
            tags["latest"] = final_layer_id
        elif mutation == "repository_extra":
            repositories["ghcr.io/skoglump/jukelet"] = tags
        elif mutation == "repository_malformed":
            repositories = {repository: [version, final_layer_id]}
        members["repositories"] = packed(repositories)
    if mutation == "layer_bytes":
        members[layer_name] = data[:-1] + b"x"
    elif mutation == "extra":
        members["unexpected"] = b"SYNTHETIC_PRIVATE_CANARY"
    elif mutation == "multiple_images":
        members["manifest.json"] = packed([docker_manifest, docker_manifest])
    with tarfile.open(path, "w") as archive:
        for name, contents in members.items():
            member = tarfile.TarInfo(name)
            member.size = len(contents)
            archive.addfile(member, io.BytesIO(contents))
        if mutation == "outer_link":
            member = tarfile.TarInfo("synthetic-link")
            member.type = tarfile.SYMTYPE
            member.linkname = config_name
            archive.addfile(member)
        elif mutation == "outer_traversal":
            archive.addfile(tarfile.TarInfo("../synthetic-escape"))
        elif mutation == "empty_directory":
            member = tarfile.TarInfo("e" * 64)
            member.type = tarfile.DIRTYPE
            archive.addfile(member)
        elif mutation == "duplicate":
            member = tarfile.TarInfo(config_name)
            member.size = len(config_bytes)
            archive.addfile(member, io.BytesIO(config_bytes))
    return config_bytes, exported_manifest, sha(uncompressed)


@pytest.mark.parametrize(("modern", "compressed"), [(False, False), (True, False), (True, True)])
def test_sealed_classic_and_oci_blob_archives_bind_expected_source_and_image_bytes(
    release: Release, tmp_path: Path, modern: bool, compressed: bool
) -> None:
    archive = tmp_path / "candidate.tar"
    config, exported, diff_id = image_archive(
        release, archive, modern=modern, compressed=compressed
    )
    output = tmp_path / "artifact.json"
    artifact = seal_archive(release.repository, release.prepared, release.source, archive, output)
    assert artifact["source_commit"] == release.source
    assert artifact["archive_sha256"] == hashlib.sha256(archive.read_bytes()).hexdigest()
    assert artifact["image_id"] == sha(config)
    assert artifact["layer_diff_ids"] == [diff_id]
    assert artifact["image_reference"] == release.plan["image_reference"]
    assert artifact["exported_oci_manifest_digest"] == (sha(exported) if modern else None)
    assert artifact["platform"] == "linux/amd64"
    assert "registry_manifest_digest" not in artifact
    assert "Env" not in json.dumps(artifact) and "Labels" not in json.dumps(artifact)
    assert (
        verify_archive(
            release.repository,
            release.prepared,
            release.source,
            archive,
            output,
            expected_archive_sha256=artifact["archive_sha256"],
        )
        == artifact
    )


@pytest.mark.parametrize("compressed", [False, True])
def test_tagged_oci_blob_exports_bind_repository_record_to_final_layer(
    release: Release, tmp_path: Path, compressed: bool
) -> None:
    archive = tmp_path / "tagged.tar"
    config, _exported, _diff = image_archive(
        release, archive, modern=True, compressed=compressed, repository_record=True
    )
    output = tmp_path / "tagged.json"
    artifact = seal_archive(release.repository, release.prepared, release.source, archive, output)
    assert artifact["image_id"] == sha(config)
    assert artifact["image_reference"] == release.plan["image_reference"]
    assert (
        verify_archive(
            release.repository,
            release.prepared,
            release.source,
            archive,
            output,
            expected_archive_sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),
        )
        == artifact
    )


@pytest.mark.parametrize("modern", [False, True])
@pytest.mark.parametrize(
    "mutation",
    [
        "repository_target",
        "repository_config",
        "repository_path",
        "repository_name",
        "repository_version",
        "repository_alias",
        "repository_extra",
        "repository_malformed",
    ],
)
def test_repository_records_cannot_select_other_layers_images_or_aliases(
    release: Release, tmp_path: Path, modern: bool, mutation: str
) -> None:
    archive = tmp_path / "wrong-repository.tar"
    image_archive(release, archive, modern=modern, compressed=modern, mutation=mutation)
    output = tmp_path / "wrong-repository.json"
    with pytest.raises(ValueError, match="repository tag|unexpected image tags|object metadata"):
        seal_archive(release.repository, release.prepared, release.source, archive, output)
    assert not output.exists()


@pytest.mark.parametrize(
    "mutation",
    [
        "index_platform",
        "index_alias",
        "index_type",
        "compatibility_extra",
        "compatibility_architecture",
        "compatibility_config",
    ],
)
def test_alternate_oci_identity_or_unknown_compatibility_records_cannot_be_sealed(
    release: Release, tmp_path: Path, mutation: str
) -> None:
    archive = tmp_path / "unsafe.tar"
    image_archive(release, archive, modern=True, mutation=mutation)
    output = tmp_path / "unsafe.json"
    with pytest.raises(ValueError):
        seal_archive(release.repository, release.prepared, release.source, archive, output)
    assert not output.exists()


@pytest.mark.parametrize(
    "mutation",
    [
        "labels",
        "architecture",
        "credentials",
        "entrypoint",
        "diff_id",
        "provenance",
        "missing_provenance",
        "provenance_symlink",
        "provenance_parent",
        "provenance_hidden",
        "inner_traversal",
        "config_path",
        "layer_bytes",
        "extra",
        "multiple_images",
        "tag",
        "outer_link",
        "outer_traversal",
        "empty_directory",
        "duplicate",
    ],
)
def test_unsafe_mixed_or_unbound_archives_fail_before_creating_an_artifact(
    release: Release, tmp_path: Path, mutation: str
) -> None:
    archive = tmp_path / "unsafe.tar"
    image_archive(release, archive, modern=True, mutation=mutation)
    output = tmp_path / "unsafe.json"
    with pytest.raises(ValueError) as failure:
        seal_archive(release.repository, release.prepared, release.source, archive, output)
    assert "SYNTHETIC_PRIVATE_CANARY" not in str(failure.value)
    assert not output.exists()


def test_legacy_repository_tags_cannot_point_to_another_saved_image(
    release: Release, tmp_path: Path
) -> None:
    archive = tmp_path / "legacy.tar"
    image_archive(release, archive, modern=False, mutation="legacy_tag")
    with pytest.raises(ValueError, match="repository tag"):
        seal_archive(
            release.repository, release.prepared, release.source, archive, tmp_path / "bad.json"
        )


def test_sealing_and_verification_require_independent_source_and_never_replace_outputs(
    release: Release, tmp_path: Path
) -> None:
    archive = tmp_path / "candidate.tar"
    image_archive(release, archive, modern=True)
    output = tmp_path / "artifact.json"
    with pytest.raises(ValueError, match="expected source"):
        seal_archive(release.repository, release.prepared, "0" * 40, archive, output)
    assert not output.exists()
    seal_archive(release.repository, release.prepared, release.source, archive, output)
    original = output.read_bytes()
    with pytest.raises(OSError):
        seal_archive(release.repository, release.prepared, release.source, archive, output)
    assert output.read_bytes() == original
    altered = json.loads(original)
    altered["archive_sha256"] = "0" * 64
    output.write_bytes(packed(altered))
    with pytest.raises(ValueError, match="independently expected artifact"):
        verify_archive(
            release.repository,
            release.prepared,
            release.source,
            archive,
            output,
            expected_archive_sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),
        )


def test_replacing_both_archive_and_sidecar_cannot_replace_the_approved_bytes(
    release: Release, tmp_path: Path
) -> None:
    archive = tmp_path / "candidate.tar"
    image_archive(release, archive, modern=True)
    output = tmp_path / "original.json"
    approved = seal_archive(release.repository, release.prepared, release.source, archive, output)
    image_archive(release, archive, modern=True, mutation="extra_env")
    altered = tmp_path / "altered.json"
    replacement = seal_archive(
        release.repository, release.prepared, release.source, archive, altered
    )
    assert replacement["archive_sha256"] != approved["archive_sha256"]
    output.write_bytes(altered.read_bytes())
    with pytest.raises(ValueError, match="expected archive"):
        verify_archive(
            release.repository,
            release.prepared,
            release.source,
            archive,
            output,
            expected_archive_sha256=approved["archive_sha256"],
        )


@pytest.mark.parametrize("checksum", ["", "A" * 64, "a" * 63, "sha256:" + "a" * 64])
def test_archive_verification_requires_a_canonical_independent_checksum(
    release: Release, tmp_path: Path, checksum: str
) -> None:
    archive = tmp_path / "candidate.tar"
    image_archive(release, archive, modern=True)
    artifact = tmp_path / "artifact.json"
    seal_archive(release.repository, release.prepared, release.source, archive, artifact)
    with pytest.raises(ValueError, match="expected archive"):
        verify_archive(
            release.repository,
            release.prepared,
            release.source,
            archive,
            artifact,
            expected_archive_sha256=checksum,
        )


@pytest.mark.parametrize("release", ["1.0.0"], indirect=True)
def test_future_stable_packaging_runs_through_archive_and_receipt_verification(
    release: Release, tmp_path: Path
) -> None:
    archive = tmp_path / "stable.tar"
    _config, raw, _diff = image_archive(release, archive, modern=True, compressed=True)
    path = tmp_path / "stable.json"
    artifact = seal_archive(release.repository, release.prepared, release.source, archive, path)
    assert artifact["addon_version"] == "1.0.0"
    assert artifact["app_version"] == "0.1.0-rc.3"
    assert artifact["image_reference"] == "ghcr.io/skoglump/jukelet-addon:1.0.0"
    manifest = tmp_path / "registry.json"
    manifest.write_bytes(raw)
    receipt = record_registry_receipt(
        release.repository,
        release.prepared,
        release.source,
        archive,
        path,
        manifest,
        sha(raw),
        tmp_path / "receipt.json",
        expected_archive_sha256=artifact["archive_sha256"],
    )
    assert receipt["production_image_reference"] == artifact["image_reference"]


@pytest.mark.parametrize("kind", ["truncated", "symlink", "oversized"])
def test_archive_inputs_are_complete_bounded_regular_files(
    release: Release, tmp_path: Path, kind: str
) -> None:
    archive = tmp_path / "candidate.tar"
    image_archive(release, archive, modern=True)
    if kind == "truncated":
        archive.write_bytes(archive.read_bytes()[:1024])
    elif kind == "symlink":
        target = tmp_path / "real.tar"
        archive.rename(target)
        archive.symlink_to(target)
    else:
        with archive.open("wb") as stream:
            stream.truncate(2 * 1024**3 + 1)
    output = tmp_path / "bad.json"
    with pytest.raises(ValueError):
        seal_archive(release.repository, release.prepared, release.source, archive, output)
    assert not output.exists()


@pytest.mark.parametrize("kind", ["after_eof", "missing_eof"])
def test_docker_archive_footer_cannot_hide_extra_bytes_or_an_incomplete_export(
    release: Release, tmp_path: Path, kind: str
) -> None:
    archive = tmp_path / "candidate.tar"
    image_archive(release, archive, modern=True)
    if kind == "after_eof":
        with archive.open("ab") as stream:
            stream.write(b"SYNTHETIC_PRIVATE_CANARY")
    else:
        with tarfile.open(archive) as members:
            end = max(member.offset_data + ((member.size + 511) // 512) * 512 for member in members)
        archive.write_bytes(archive.read_bytes()[:end])
    output = tmp_path / "bad.json"
    with pytest.raises(ValueError):
        seal_archive(release.repository, release.prepared, release.source, archive, output)
    assert not output.exists()


@pytest.fixture
def sealed(release: Release, tmp_path: Path) -> tuple[Path, Path, dict[str, Any], bytes]:
    archive = tmp_path / "candidate.tar"
    _config, manifest, _diff = image_archive(release, archive, modern=True, compressed=True)
    path = tmp_path / "sealed.json"
    artifact = seal_archive(release.repository, release.prepared, release.source, archive, path)
    return archive, path, artifact, manifest


@pytest.mark.parametrize("fixture", [False, True])
def test_registry_receipts_bind_supplied_manifests_without_claiming_network_or_publication(
    release: Release,
    sealed: tuple[Path, Path, dict[str, Any], bytes],
    tmp_path: Path,
    fixture: bool,
) -> None:
    archive, artifact_path, artifact, raw = sealed
    manifest = tmp_path / "registry-manifest.json"
    manifest.write_bytes(raw)
    reference = "127.0.0.1:15059/" + release.plan["image_reference"].split("/", 1)[1]
    output = tmp_path / "receipt.json"
    receipt = record_registry_receipt(
        release.repository,
        release.prepared,
        release.source,
        archive,
        artifact_path,
        manifest,
        sha(raw),
        output,
        expected_archive_sha256=artifact["archive_sha256"],
        fixture_image=reference if fixture else None,
    )
    assert receipt["registry_manifest_digest"] == sha(raw)
    assert receipt["registry_index_digest"] is None
    assert receipt["image_id"] == artifact["image_id"]
    assert receipt["archive_sha256"] == artifact["archive_sha256"]
    assert receipt["source_commit"] == release.source
    assert receipt["production_image_reference"] == release.plan["image_reference"]
    assert receipt["observed_image_reference"] == (
        reference if fixture else release.plan["image_reference"]
    )
    assert receipt["scope"] == (
        "disposable-loopback-registry" if fixture else "production-ghcr-observation"
    )
    assert receipt["network_readback"] == "must be established separately by the operator"
    assert "Env" not in json.dumps(receipt)
    before = output.read_bytes()
    with pytest.raises(OSError):
        record_registry_receipt(
            release.repository,
            release.prepared,
            release.source,
            archive,
            artifact_path,
            manifest,
            sha(raw),
            output,
            expected_archive_sha256=artifact["archive_sha256"],
            fixture_image=reference if fixture else None,
        )
    assert output.read_bytes() == before


def registry_index(raw: bytes) -> dict[str, Any]:
    return {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": [
            {
                "mediaType": OCI_MANIFEST,
                "digest": sha(raw),
                "size": len(raw),
                "platform": {"architecture": "amd64", "os": "linux"},
            }
        ],
    }


def test_registry_index_identity_remains_distinct_from_saved_archive_representation(
    release: Release, sealed: tuple[Path, Path, dict[str, Any], bytes], tmp_path: Path
) -> None:
    archive, artifact, saved, raw = sealed
    manifest = tmp_path / "manifest.json"
    manifest.write_bytes(raw)
    index = tmp_path / "index.json"
    index.write_bytes(packed(registry_index(raw)))
    receipt = record_registry_receipt(
        release.repository,
        release.prepared,
        release.source,
        archive,
        artifact,
        manifest,
        sha(raw),
        tmp_path / "receipt.json",
        expected_archive_sha256=saved["archive_sha256"],
        index=index,
        index_digest=sha(index.read_bytes()),
    )
    assert receipt["registry_index_digest"] == sha(index.read_bytes())
    assert receipt["registry_manifest_digest"] == sha(raw)
    assert receipt["registry_index_digest"] != saved["exported_oci_index_digest"]


@pytest.mark.parametrize(
    "mutation",
    [
        "config",
        "config_size",
        "digest",
        "foreign_layer",
        "layer_count",
        "media_type",
        "index_platform",
        "index_digest",
        "index_count",
    ],
)
def test_invalid_or_mixed_registry_observations_cannot_create_receipts(
    release: Release,
    sealed: tuple[Path, Path, dict[str, Any], bytes],
    tmp_path: Path,
    mutation: str,
) -> None:
    archive, artifact, _saved, original = sealed
    value = json.loads(original)
    if mutation == "config":
        value["config"]["digest"] = "sha256:" + "0" * 64
    elif mutation == "config_size":
        value["config"]["size"] += 1
    elif mutation == "foreign_layer":
        value["layers"][0]["urls"] = ["https://synthetic.invalid/private"]
    elif mutation == "layer_count":
        value["layers"].append(value["layers"][0])
    elif mutation == "media_type":
        value["mediaType"] = ["not-a-media-type"]
    raw = packed(value)
    manifest = tmp_path / "manifest.json"
    manifest.write_bytes(raw)
    supplied = "sha256:" + "0" * 64 if mutation == "digest" else sha(raw)
    index_path: Path | None = None
    index_digest: str | None = None
    if mutation.startswith("index_"):
        entry = registry_index(raw)
        if mutation == "index_platform":
            entry["manifests"][0]["platform"]["architecture"] = "arm64"
        elif mutation == "index_count":
            entry["manifests"].append(entry["manifests"][0])
        index_path = tmp_path / "index.json"
        index_path.write_bytes(packed(entry))
        index_digest = (
            "sha256:" + "0" * 64 if mutation == "index_digest" else sha(index_path.read_bytes())
        )
    output = tmp_path / "bad-receipt.json"
    with pytest.raises(ValueError):
        record_registry_receipt(
            release.repository,
            release.prepared,
            release.source,
            archive,
            artifact,
            manifest,
            supplied,
            output,
            expected_archive_sha256=_saved["archive_sha256"],
            index=index_path,
            index_digest=index_digest,
        )
    assert not output.exists()


@pytest.mark.parametrize(
    "reference",
    [
        "192.0.2.1:15059/skoglump/jukelet-addon:VERSION",
        "127.0.0.1:15059/skoglump/jukelet:VERSION",
        "127.0.0.1:15059/skoglump/jukelet-addon:latest",
    ],
)
def test_fixture_receipts_cannot_change_the_repository_version_or_contact_scope(
    release: Release,
    sealed: tuple[Path, Path, dict[str, Any], bytes],
    tmp_path: Path,
    reference: str,
) -> None:
    archive, artifact, _saved, raw = sealed
    manifest = tmp_path / "manifest.json"
    manifest.write_bytes(raw)
    with pytest.raises(ValueError, match="Fixture observation"):
        record_registry_receipt(
            release.repository,
            release.prepared,
            release.source,
            archive,
            artifact,
            manifest,
            sha(raw),
            tmp_path / "bad.json",
            expected_archive_sha256=_saved["archive_sha256"],
            fixture_image=reference.replace("VERSION", release.plan["addon_version"]),
        )


def test_archive_cli_roundtrip_and_failures_are_finite_and_redacted(
    release: Release, tmp_path: Path
) -> None:
    archive = tmp_path / "candidate.tar"
    _config, raw, _diff = image_archive(release, archive, modern=True)
    artifact = tmp_path / "artifact.json"
    prefix = [
        sys.executable,
        "-m",
        "scripts.addon_release",
        "--repository",
        str(release.repository),
    ]
    common = [
        "--prepared",
        str(release.prepared),
        "--expected-source",
        release.source,
        "--archive",
        str(archive),
    ]
    verified_common = common + [
        "--expected-archive-sha256",
        hashlib.sha256(archive.read_bytes()).hexdigest(),
    ]
    for command in (
        ["seal", *common, "--output", str(artifact)],
        ["verify-archive", *verified_common, "--artifact", str(artifact)],
    ):
        result = subprocess.run(
            prefix + command, cwd=ROOT, capture_output=True, text=True, check=False, timeout=20
        )
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout)["image_reference"] == release.plan["image_reference"]
    manifest = tmp_path / "manifest.json"
    manifest.write_bytes(raw)
    command = [
        "receipt",
        *verified_common,
        "--artifact",
        str(artifact),
        "--manifest",
        str(manifest),
        "--manifest-digest",
        sha(raw),
        "--output",
        str(tmp_path / "receipt.json"),
    ]
    result = subprocess.run(
        prefix + command, cwd=ROOT, capture_output=True, text=True, check=False, timeout=20
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["registry_manifest_digest"] == sha(raw)
    image_archive(release, archive, modern=True, mutation="credentials")
    result = subprocess.run(
        prefix + ["seal", *common, "--output", str(tmp_path / "private.json")],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
        timeout=20,
    )
    assert result.returncode == 2 and result.stdout == ""
    assert "Traceback" not in result.stderr and "SYNTHETIC_PRIVATE_CANARY" not in result.stderr
    assert not (tmp_path / "private.json").exists()
