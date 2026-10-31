"""Offline, bounded Docker archive and registry-manifest validation for add-on releases."""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import stat
import tarfile
import zlib
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, cast

from scripts.check_addon_release import _reject_constant, _unique_object

DIGEST = r"sha256:[0-9a-f]{64}"
MAX_ARCHIVE = 2 * 1024**3
MAX_LAYER = 1024**3
MAX_JSON = 4 * 1024**2
OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json"
CONFIG_TYPES = {
    "application/vnd.oci.image.config.v1+json",
    "application/vnd.docker.container.image.v1+json",
}
LAYER_TYPES = {
    "application/vnd.oci.image.layer.v1.tar",
    "application/vnd.oci.image.layer.v1.tar+gzip",
    "application/vnd.docker.image.rootfs.diff.tar",
    "application/vnd.docker.image.rootfs.diff.tar.gzip",
}


def digest(contents: bytes) -> str:
    return "sha256:" + hashlib.sha256(contents).hexdigest()


def decoded(contents: bytes) -> Any:
    try:
        return json.loads(
            contents,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
        )
    except UnicodeError, ValueError:
        raise ValueError("Invalid archive or registry JSON metadata") from None


def object_value(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Invalid archive or registry object metadata")
    return value


def _sha(value: Any) -> str:
    if not isinstance(value, str) or re.fullmatch(DIGEST, value) is None:
        raise ValueError("Invalid image content digest")
    return value


def descriptor(value: Any, *, types: set[str]) -> dict[str, Any]:
    result = object_value(value)
    _sha(result.get("digest"))
    size = result.get("size")
    media_type = result.get("mediaType")
    if (
        type(size) is not int
        or not 0 < size <= MAX_LAYER
        or not isinstance(media_type, str)
        or media_type not in types
        or result.get("urls")
        or set(result) - {"mediaType", "digest", "size", "platform", "annotations", "urls"}
    ):
        raise ValueError("Invalid or foreign image descriptor")
    return result


@contextmanager
def regular_file(path: Path, limit: int) -> Iterator[BinaryIO]:
    if ".." in path.parts:
        raise ValueError("Artifact input paths must not traverse parent directories")
    directory = os.open(path.absolute().anchor, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.absolute().parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)
    with os.fdopen(fd, "rb") as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or not 0 < metadata.st_size <= limit:
            raise ValueError("Artifact inputs must be bounded nonempty regular files")
        yield stream


def _hash_stream(stream: BinaryIO, limit: int) -> tuple[str, int]:
    sha = hashlib.sha256()
    size = 0
    while chunk := stream.read(1024**2):
        size += len(chunk)
        if size > limit:
            raise ValueError("Artifact or image layer exceeds its size limit")
        sha.update(chunk)
    return "sha256:" + sha.hexdigest(), size


def read_metadata(path: Path) -> bytes:
    with regular_file(path, MAX_JSON) as stream:
        value = stream.read(MAX_JSON + 1)
    if len(value) > MAX_JSON:
        raise ValueError("Registry metadata exceeds its size limit")
    return value


def _safe_name(value: str, *, directory: bool = False) -> str:
    name = value.rstrip("/") if directory else value
    path = PurePosixPath(name)
    if (
        not name
        or path.is_absolute()
        or str(path) != name
        or any(part in {".", ".."} for part in path.parts)
    ):
        raise ValueError("Unsafe or ambiguous archive member path")
    return name


def _members(archive: tarfile.TarFile) -> dict[str, tarfile.TarInfo]:
    files: dict[str, tarfile.TarInfo] = {}
    seen: set[str] = set()
    directories: set[str] = set()
    last_end = 0
    for count, member in enumerate(archive):
        if count >= 1024:
            raise ValueError("Too many Docker archive members")
        name = _safe_name(member.name, directory=member.isdir())
        if name in seen or member.issparse() or not (member.isdir() or member.isfile()):
            raise ValueError("Duplicate or nonregular Docker archive member")
        seen.add(name)
        last_end = max(last_end, member.offset_data + ((member.size + 511) // 512) * 512)
        if member.isdir():
            if (
                name not in {"blobs", "blobs/sha256"}
                and re.fullmatch(r"[0-9a-f]{64}", name) is None
            ):
                raise ValueError("Unexpected Docker archive directory")
            directories.add(name)
        else:
            if member.size > MAX_LAYER:
                raise ValueError("Docker archive member is too large")
            files[name] = member
    if any(
        not any(name.startswith(directory + "/") for name in files) for directory in directories
    ):
        raise ValueError("Unexpected empty Docker archive directory")
    archive.fileobj.seek(last_end)
    padding = 0
    while chunk := archive.fileobj.read(1024**2):
        padding += len(chunk)
        if padding > MAX_ARCHIVE or chunk.count(0) != len(chunk):
            raise ValueError("Unexpected bytes after the Docker archive member set")
    if padding < 1024:
        raise ValueError("Docker archive is missing its complete end markers")
    return files


def _member(archive: tarfile.TarFile, files: dict[str, tarfile.TarInfo], name: str) -> BinaryIO:
    member = files.get(name)
    if member is None:
        raise ValueError("Docker archive member is missing")
    stream = archive.extractfile(member)
    if stream is None:
        raise ValueError("Unable to read regular Docker archive member")
    return cast(BinaryIO, stream)


def _small(archive: tarfile.TarFile, files: dict[str, tarfile.TarInfo], name: str) -> bytes:
    if name not in files or files[name].size > MAX_JSON:
        raise ValueError("Missing or oversized Docker archive metadata")
    with _member(archive, files, name) as stream:
        value = stream.read(MAX_JSON + 1)
    if len(value) != files[name].size:
        raise ValueError("Truncated Docker archive metadata")
    return value


@contextmanager
def _layer_stream(
    archive: tarfile.TarFile, files: dict[str, tarfile.TarInfo], name: str, compressed: bool
) -> Iterator[BinaryIO]:
    with _member(archive, files, name) as raw:
        if compressed:
            with gzip.GzipFile(fileobj=raw) as stream:
                yield cast(BinaryIO, stream)
        else:
            yield raw


def _provenance_in_layer(stream: BinaryIO, previous: str | None) -> str | None:
    found = previous
    with tarfile.open(fileobj=stream, mode="r|") as layer:
        for count, member in enumerate(layer):
            if count >= 200000 or member.size > MAX_LAYER or member.issparse():
                raise ValueError("Unsupported or oversized image filesystem layer")
            name = member.name
            while name.startswith("./"):
                name = name[2:]
            if name in {"", "."} and member.isdir():
                continue
            name = _safe_name(name, directory=member.isdir())
            if name == "app" and not member.isdir():
                raise ValueError("Unsafe application provenance parent")
            if name in {
                ".wh.app",
                ".wh..wh..opq",
                "app/.wh..wh..opq",
                "app/.wh.addon-build-info.json",
            }:
                if found is not None:
                    raise ValueError("Application provenance was removed or hidden")
            if name == "app/addon-build-info.json":
                if found is not None or not member.isfile() or member.size > MAX_JSON:
                    raise ValueError("Ambiguous or nonregular application provenance")
                value = layer.extractfile(member)
                if value is None:
                    raise ValueError("Application provenance cannot be read")
                with value:
                    contents = value.read(MAX_JSON + 1)
                if len(contents) != member.size:
                    raise ValueError("Truncated application provenance")
                found = digest(contents)
    return found


def _compatibility_records(
    archive: tarfile.TarFile,
    files: dict[str, tarfile.TarInfo],
    remaining: set[str],
    layer_names: list[str],
    runtime: dict[str, Any],
) -> None:
    allowed = {
        "id",
        "parent",
        "created",
        "container",
        "container_config",
        "config",
        "architecture",
        "os",
        "author",
        "comment",
        "docker_version",
        "throwaway",
        "Size",
    }
    records: list[dict[str, Any]] = []
    for name in remaining:
        if re.fullmatch(r"blobs/sha256/[0-9a-f]{64}", name):
            value = _small(archive, files, name)
            if digest(value) != "sha256:" + name.rsplit("/", 1)[1]:
                raise ValueError("Legacy compatibility blob digest mismatch")
            record = object_value(decoded(value))
            if (
                set(record) - allowed
                or not isinstance(record.get("container_config"), dict)
                or record.get("os", "linux") != "linux"
                or record.get("architecture", "amd64") != "amd64"
            ):
                raise ValueError("Unexpected unreferenced Docker archive blob")
            records.append(record)
        elif re.fullmatch(r"[0-9a-f]{64}/(?:json|VERSION)", name):
            parent, kind = name.split("/")
            if parent + "/layer.tar" not in layer_names:
                raise ValueError("Mixed or unreferenced legacy Docker layer")
            value = _small(archive, files, name)
            if kind == "VERSION":
                if value not in {b"1.0", b"1.0\n"}:
                    raise ValueError("Unsupported legacy Docker archive version")
            else:
                record = object_value(decoded(value))
                if (
                    set(record) - allowed
                    or record.get("id") != parent
                    or not isinstance(record.get("container_config"), dict)
                    or record.get("os", "linux") != "linux"
                    or record.get("architecture", "amd64") != "amd64"
                    or (
                        parent + "/layer.tar" == layer_names[-1] and record.get("config") != runtime
                    )
                ):
                    raise ValueError("Legacy layer identity does not match its path")
        else:
            raise ValueError("Unexpected Docker archive file")
    if records:
        parents_by_id: dict[str, str | None] = {}
        for record in records:
            identity = record.get("id")
            parent_identity = record.get("parent")
            if (
                not isinstance(identity, str)
                or re.fullmatch(r"[0-9a-f]{64}", identity) is None
                or identity in parents_by_id
                or (parent_identity is not None and not isinstance(parent_identity, str))
            ):
                raise ValueError("Invalid legacy compatibility image identity")
            parents_by_id[identity] = parent_identity
        if len(records) != len(layer_names):
            raise ValueError("Invalid legacy compatibility image chain")
        parents = list(parents_by_id.values())
        nonempty = [parent for parent in parents if parent]
        if (
            len(set(nonempty)) != len(nonempty)
            or sum(parent in {None, ""} for parent in parents) != 1
            or any(parent not in {None, ""} and parent not in parents_by_id for parent in parents)
        ):
            raise ValueError("Mixed legacy compatibility image chain")
        final_id = next(identity for identity in parents_by_id if identity not in nonempty)
        final_record = next(record for record in records if record["id"] == final_id)
        if final_record.get("config") != runtime:
            raise ValueError("Legacy compatibility config differs from the saved image")
        for identity in parents_by_id:
            visited: set[str] = set()
            current: str | None = identity
            while current:
                if current in visited:
                    raise ValueError("Cyclic legacy compatibility image chain")
                visited.add(current)
                current = parents_by_id[current]


def _image_annotations(value: Any, reference: str) -> None:
    if value is None:
        return
    annotations = object_value(value)
    if annotations.get("io.containerd.image.name", reference) != reference:
        raise ValueError("OCI image annotation selects another image reference")
    name = annotations.get("org.opencontainers.image.ref.name", reference)
    if name != reference and name != reference.rsplit(":", 1)[1]:
        raise ValueError("OCI image annotation selects another image tag")


def _inspect_archive(path: Path, plan: dict[str, Any]) -> dict[str, Any]:
    """Validate saved bytes; return hashes and expected identities, never raw config."""
    with regular_file(path, MAX_ARCHIVE) as stream:
        before = os.fstat(stream.fileno())
        archive_digest, archive_size = _hash_stream(stream, MAX_ARCHIVE)
        stream.seek(0)
        with tarfile.open(fileobj=stream, mode="r:") as archive:
            files = _members(archive)
            manifests = decoded(_small(archive, files, "manifest.json"))
            if not isinstance(manifests, list) or len(manifests) != 1:
                raise ValueError("Docker archive must contain exactly one image")
            manifest = object_value(manifests[0])
            if set(manifest) - {"Config", "RepoTags", "Layers", "LayerSources"}:
                raise ValueError("Unsupported Docker archive manifest fields")
            config_name = manifest.get("Config")
            layers = manifest.get("Layers")
            if not isinstance(config_name, str) or not isinstance(layers, list) or not layers:
                raise ValueError("Invalid Docker archive image references")
            if any(
                not isinstance(name, str)
                or re.fullmatch(r"(?:blobs/sha256/[0-9a-f]{64}|[0-9a-f]{64}/layer\.tar)", name)
                is None
                for name in layers
            ) or len(set(layers)) != len(layers):
                raise ValueError("Invalid or duplicate Docker archive layers")
            config_bytes = _small(archive, files, config_name)
            image_id = digest(config_bytes)
            if config_name not in {image_id[7:] + ".json", "blobs/sha256/" + image_id[7:]}:
                raise ValueError("Image config content does not match its digest path")
            config = object_value(decoded(config_bytes))
            runtime = object_value(config.get("config"))
            if config.get("os") != "linux" or config.get("architecture") != "amd64":
                raise ValueError("Image platform does not match tested linux/amd64")
            rootfs = object_value(config.get("rootfs"))
            diff_ids = rootfs.get("diff_ids")
            if (
                rootfs.get("type") != "layers"
                or not isinstance(diff_ids, list)
                or len(diff_ids) != len(layers)
            ):
                raise ValueError("Image filesystem does not match its declared layers")
            raw_descriptors: list[tuple[str, int, bool]] = []
            embedded: str | None = None
            uncompressed_bytes = 0
            for name, expected_diff in zip(layers, diff_ids, strict=True):
                _sha(expected_diff)
                with _member(archive, files, name) as layer:
                    magic = layer.read(2)
                    layer.seek(0)
                    raw_digest, size = _hash_stream(layer, MAX_LAYER)
                compressed = magic == b"\x1f\x8b"
                if name.startswith("blobs/") and name != "blobs/sha256/" + raw_digest[7:]:
                    raise ValueError("Image layer content does not match its blob path")
                with _layer_stream(archive, files, name, compressed) as layer:
                    actual_diff, unpacked_size = _hash_stream(layer, MAX_LAYER)
                uncompressed_bytes += unpacked_size
                if actual_diff != expected_diff or uncompressed_bytes > 4 * MAX_LAYER:
                    raise ValueError("Image layer does not match its filesystem diffID")
                with _layer_stream(archive, files, name, compressed) as layer:
                    embedded = _provenance_in_layer(layer, embedded)
                raw_descriptors.append((raw_digest, size, compressed))
            used = {"manifest.json", config_name, *layers}
            export_manifest: str | None = None
            export_index: str | None = None
            if "index.json" in files or "oci-layout" in files:
                layout = decoded(_small(archive, files, "oci-layout"))
                if layout != {"imageLayoutVersion": "1.0.0"}:
                    raise ValueError("Unsupported OCI archive layout")
                index_bytes = _small(archive, files, "index.json")
                index = object_value(decoded(index_bytes))
                entries = index.get("manifests")
                if (
                    index.get("schemaVersion") != 2
                    or index.get("mediaType") != "application/vnd.oci.image.index.v1+json"
                    or set(index) - {"schemaVersion", "mediaType", "manifests", "annotations"}
                    or not isinstance(entries, list)
                    or len(entries) != 1
                ):
                    raise ValueError("Mixed or invalid OCI image index")
                entry = descriptor(entries[0], types={OCI_MANIFEST, DOCKER_MANIFEST})
                if entry.get("platform") not in (None, {"architecture": "amd64", "os": "linux"}):
                    raise ValueError("Exported OCI index selects an untested image platform")
                _image_annotations(index.get("annotations"), plan["image_reference"])
                _image_annotations(entry.get("annotations"), plan["image_reference"])
                export_manifest = entry["digest"]
                manifest_path = "blobs/sha256/" + export_manifest[7:]
                raw = _small(archive, files, manifest_path)
                if digest(raw) != export_manifest or len(raw) != entry["size"]:
                    raise ValueError("Exported OCI manifest digest mismatch")
                exported = object_value(decoded(raw))
                _image_annotations(exported.get("annotations"), plan["image_reference"])
                _verify_manifest(exported, image_id, len(config_bytes), raw_descriptors)
                export_index = digest(index_bytes)
                used |= {"index.json", "oci-layout", manifest_path}
            if "LayerSources" in manifest:
                sources = object_value(manifest["LayerSources"])
                if set(sources) != set(diff_ids):
                    raise ValueError("Docker layer sources do not match filesystem identity")
                for expected_diff, layer_descriptor in zip(diff_ids, raw_descriptors, strict=True):
                    item = descriptor(sources[expected_diff], types=LAYER_TYPES)
                    if (
                        item["digest"] != layer_descriptor[0]
                        or item["size"] != layer_descriptor[1]
                        or ("gzip" in item["mediaType"]) != layer_descriptor[2]
                    ):
                        raise ValueError("Docker layer-source descriptor mismatch")
            if "repositories" in files:
                repository, version = plan["image_reference"].rsplit(":", 1)
                tagged = object_value(decoded(_small(archive, files, "repositories")))
                if set(tagged) != {repository} or set(object_value(tagged[repository])) != {
                    version
                }:
                    raise ValueError("Legacy archive has unexpected image tags")
                # Classic saves use a legacy layer directory ID; Docker29 also
                # emits this record for blob layouts, using the final blob SHA.
                # Both path forms and every blob's content were validated above.
                final_layer_id = (
                    layers[-1].removeprefix("blobs/sha256/")
                    if layers[-1].startswith("blobs/sha256/")
                    else layers[-1].removesuffix("/layer.tar")
                )
                if tagged[repository][version] != final_layer_id:
                    raise ValueError("Legacy repository tag does not match the saved image")
                used.add("repositories")
            _compatibility_records(archive, files, set(files) - used, layers, runtime)
            if manifest.get("RepoTags") != [plan["image_reference"]]:
                raise ValueError("Archive image tag does not match the release plan")
            labels = object_value(runtime.get("Labels"))
            if any(labels.get(key) != value for key, value in plan["labels"].items()):
                raise ValueError("Archive image identity labels do not match the release plan")
            if (
                runtime.get("Entrypoint") != ["python", "-m", "jukelet.addon"]
                or runtime.get("Cmd") not in (None, [])
                or runtime.get("User") != "0:0"
            ):
                raise ValueError("Archive does not select the expected add-on startup adapter")
            environment = runtime.get("Env", [])
            if not isinstance(environment, list) or any(
                not isinstance(item, str) for item in environment
            ):
                raise ValueError("Invalid image environment metadata")
            if any(
                item.partition("=")[2]
                for item in environment
                if item.partition("=")[0]
                in {"SUPERVISOR_TOKEN", "HASSIO_TOKEN", "HA_TOKEN", "APP_AUTH_TOKEN"}
            ):
                raise ValueError("Runtime credentials must not be embedded in an image")
            if embedded != "sha256:" + plan["embedded_build_info_sha256"]:
                raise ValueError("Archive embedded provenance does not match committed source")
        stream.seek(0)
        after_digest, after_size = _hash_stream(stream, MAX_ARCHIVE)
        after = os.fstat(stream.fileno())
        if (
            after_digest != archive_digest
            or after_size != archive_size
            or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns)
        ):
            raise ValueError("Image archive changed during verification")
    return {
        "archive_sha256": archive_digest[7:],
        "archive_bytes": archive_size,
        "image_id": image_id,
        "image_config_bytes": len(config_bytes),
        "layer_diff_ids": diff_ids,
        "platform": "linux/amd64",
        "exported_oci_manifest_digest": export_manifest,
        "exported_oci_index_digest": export_index,
        "embedded_build_info_sha256": plan["embedded_build_info_sha256"],
    }


def inspect_archive(path: Path, plan: dict[str, Any]) -> dict[str, Any]:
    """Normalize corrupt archive/codec failures without exposing their contents."""
    try:
        return _inspect_archive(path, plan)
    except tarfile.TarError, EOFError, zlib.error, OSError:
        raise ValueError("Unable to read a complete bounded Docker image archive") from None


def _verify_manifest(
    value: Any, image_id: str, config_size: int, raw_layers: list[tuple[str, int, bool]] | None
) -> list[dict[str, Any]]:
    manifest = object_value(value)
    layers = manifest.get("layers")
    if (
        manifest.get("schemaVersion") != 2
        or not isinstance(manifest.get("mediaType"), str)
        or manifest["mediaType"] not in {OCI_MANIFEST, DOCKER_MANIFEST}
        or set(manifest) - {"schemaVersion", "mediaType", "config", "layers", "annotations"}
        or not isinstance(layers, list)
        or not layers
    ):
        raise ValueError("Invalid platform image manifest")
    config = descriptor(manifest.get("config"), types=CONFIG_TYPES)
    if config["digest"] != image_id or config["size"] != config_size:
        raise ValueError("Registry or exported manifest points to another image config")
    result = [descriptor(item, types=LAYER_TYPES) for item in layers]
    if raw_layers is not None:
        if len(result) != len(raw_layers):
            raise ValueError("Exported manifest layer count mismatch")
        for item, (sha, size, compressed) in zip(result, raw_layers, strict=True):
            if (
                item["digest"] != sha
                or item["size"] != size
                or (("gzip" in item["mediaType"]) != compressed)
            ):
                raise ValueError("Exported manifest does not match saved layer bytes")
    return result


def registry_observation(
    artifact: dict[str, Any],
    manifest_bytes: bytes,
    manifest_digest: str,
    *,
    observed_image: str,
    fixture: bool,
    index_bytes: bytes | None = None,
    index_digest: str | None = None,
) -> dict[str, Any]:
    if digest(manifest_bytes) != _sha(manifest_digest):
        raise ValueError("Observed registry platform-manifest digest mismatch")
    layers = _verify_manifest(
        decoded(manifest_bytes), artifact["image_id"], artifact["image_config_bytes"], None
    )
    if len(layers) != len(artifact["layer_diff_ids"]):
        raise ValueError("Observed registry layer count differs from sealed image")
    production = artifact["image_reference"]
    if fixture:
        suffix = production.split("/", 1)[1]
        match = re.fullmatch(
            r"127\.0\.0\.1:(?P<port>[1-9][0-9]{0,4})/" + re.escape(suffix), observed_image
        )
        if match is None or int(match["port"]) > 65535:
            raise ValueError("Fixture observation must retain image path/version on guest loopback")
    elif observed_image != production:
        raise ValueError("Production observation must use the accepted exact image reference")
    if index_bytes is not None:
        if index_digest is None or digest(index_bytes) != _sha(index_digest):
            raise ValueError("Observed registry index digest mismatch")
        index = object_value(decoded(index_bytes))
        entries = index.get("manifests")
        if (
            index.get("schemaVersion") != 2
            or not isinstance(index.get("mediaType"), str)
            or index["mediaType"]
            not in {
                "application/vnd.oci.image.index.v1+json",
                "application/vnd.docker.distribution.manifest.list.v2+json",
            }
            or not isinstance(entries, list)
            or len(entries) != 1
        ):
            raise ValueError("Registry index must contain only the tested platform image")
        entry = descriptor(entries[0], types={OCI_MANIFEST, DOCKER_MANIFEST})
        if (
            entry["digest"] != manifest_digest
            or entry["size"] != len(manifest_bytes)
            or entry.get("platform") != {"architecture": "amd64", "os": "linux"}
        ):
            raise ValueError("Registry index does not match the sealed amd64 image")
    elif index_digest is not None:
        raise ValueError("An index digest requires its observed index bytes")
    return {
        "observed_image_reference": observed_image,
        "production_image_reference": production,
        "scope": "disposable-loopback-registry" if fixture else "production-ghcr-observation",
        "registry_manifest_digest": manifest_digest,
        "registry_index_digest": index_digest,
        "image_id": artifact["image_id"],
        "source_commit": artifact["source_commit"],
        "context_sha256": artifact["context_sha256"],
        "archive_sha256": artifact["archive_sha256"],
        "network_readback": "must be established separately by the operator",
    }
