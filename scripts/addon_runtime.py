"""Load and probe the approved image without rebuilding it or contacting HA."""

import json
import subprocess
from pathlib import Path
from typing import Any

from scripts.addon_image import inspect_archive, object_value


def command(arguments: list[str], *, password: str | None = None) -> bytes:
    result = subprocess.run(
        arguments,
        input=(password + "\n").encode() if password is not None else None,
        capture_output=True,
        check=False,
        timeout=300,
    )
    if result.returncode:
        # Neither Docker/gh stderr nor image configuration may enter reports.
        raise ValueError("Add-on promotion command failed")
    return result.stdout


def inspect_loaded(
    reference: str, bundle: dict[str, Any], *, registry: dict[str, Any] | None = None
) -> dict[str, Any]:
    artifact = bundle["artifact"]
    plan = bundle["plan"]
    raw = command(["docker", "image", "inspect", "--format", "{{json .}}", reference])
    if len(raw) > 4 * 1024 * 1024:
        raise ValueError("Loaded image metadata exceeds its supported bound")
    value = object_value(json.loads(raw))
    runtime = object_value(value.get("Config"))
    labels = object_value(runtime.get("Labels"))
    rootfs = object_value(value.get("RootFS"))
    manifests = {
        artifact.get("exported_oci_manifest_digest"),
        artifact.get("exported_oci_index_digest"),
    }
    if registry is not None:
        manifests |= {registry["registry_manifest_digest"], registry["registry_tag_digest"]}
    manifests.discard(None)
    image_id = value.get("Id")
    if image_id != artifact["image_id"]:
        descriptor = object_value(value.get("Descriptor"))
        if image_id not in manifests or descriptor.get("digest") != image_id:
            raise ValueError(
                "Loaded image identity is neither approved config nor observed manifest"
            )
        identity_kind = (
            "index-digest"
            if image_id == artifact.get("exported_oci_index_digest")
            or (registry is not None and image_id == registry.get("registry_index_digest"))
            else "platform-manifest-digest"
        )
    else:
        identity_kind = "config-digest"
    if (
        value.get("Architecture") != "amd64"
        or value.get("Os") != "linux"
        or rootfs.get("Type") != "layers"
        or rootfs.get("Layers") != artifact["layer_diff_ids"]
        or any(labels.get(key) != expected for key, expected in plan["labels"].items())
        or runtime.get("User") != "0:0"
        or runtime.get("Entrypoint") != ["python", "-m", "jukelet.addon"]
        or runtime.get("Cmd") not in (None, [])
    ):
        raise ValueError("Loaded image runtime/source/filesystem differs from approved archive")
    if registry is not None and reference not in value.get("RepoDigests", []):
        raise ValueError("Pulled image does not retain the requested registry digest")
    return {
        "docker_inspect_id": image_id,
        "docker_inspect_id_kind": identity_kind,
        "approved_config_digest": artifact["image_id"],
        "ordered_layer_diff_ids": artifact["layer_diff_ids"],
    }


PROBE = """import hashlib, importlib.metadata, json, pathlib, sqlite3, ssl, sys
import fastapi, pydantic, uvicorn, jukelet.addon
assert importlib.metadata.version('jukelet') == sys.argv[1]
provenance = pathlib.Path('/app/addon-build-info.json').read_bytes()
assert hashlib.sha256(provenance).hexdigest() == sys.argv[2]
assert sqlite3.sqlite_version and ssl.OPENSSL_VERSION
"""


def verify_image(bundle: dict[str, Any], archive: Path, directory: Path) -> dict[str, Any]:
    command(["docker", "image", "load", "--input", str(archive)])
    reference = bundle["plan"]["image_reference"]
    loaded = inspect_loaded(reference, bundle)
    saved = directory / "loaded-image.tar"
    command(["docker", "image", "save", "--output", str(saved), reference])
    # A containerd store may expose the manifest digest in inspect.Id. Re-export
    # the loaded object and hash its real config instead of assuming ID semantics.
    observed = inspect_archive(saved, bundle["plan"])
    if (
        observed["image_id"] != bundle["artifact"]["image_id"]
        or observed["layer_diff_ids"] != bundle["artifact"]["layer_diff_ids"]
    ):
        raise ValueError("Loaded image re-export contains another config or filesystem")
    version = bundle["plan"]["app_version"].replace("-rc.", "rc")
    command(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--entrypoint",
            "python",
            reference,
            "-c",
            PROBE,
            version,
            bundle["plan"]["embedded_build_info_sha256"],
        ]
    )
    return {
        **loaded,
        "config_identity": "independently verified from loaded-image re-export",
        "dependency_probe": "PASS; network disabled; not HA OS installation evidence",
    }
