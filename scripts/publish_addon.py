"""Release-event promotion of exact approved add-on bytes; never rebuild an image."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import selectors
import subprocess
import time
import urllib.error
import zipfile
from pathlib import Path
from typing import Any

from scripts.addon_image import decoded, object_value, read_metadata
from scripts.addon_promotion import (
    INPUTS,
    OUTPUTS,
    release_inventory,
    tag_approval,
    verify_bundle,
    verify_input_bytes,
)
from scripts.addon_registry import Registry
from scripts.addon_release import _exclusive_directory_files
from scripts.addon_runtime import command, inspect_loaded, verify_image
from scripts.check_addon_release import _read
from scripts.package_addon import encoded

REPOSITORY = "skoglump/jukelet"
API = "repos/" + REPOSITORY


class GitHub:
    def json(self, path: str) -> dict[str, Any]:
        return object_value(
            decoded(
                command(
                    [
                        "gh",
                        "api",
                        "--hostname",
                        "github.com",
                        "-H",
                        "X-GitHub-Api-Version: 2026-03-10",
                        API + path,
                    ]
                )
            )
        )

    def download(self, asset_id: int, output: Path, size: int) -> None:
        arguments = [
            "gh",
            "api",
            "--hostname",
            "github.com",
            "-H",
            "Accept: application/octet-stream",
            "-H",
            "X-GitHub-Api-Version: 2026-03-10",
            API + "/releases/assets/" + str(asset_id),
        ]
        with (
            output.open("xb") as stream,
            subprocess.Popen(
                arguments, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
            ) as process,
        ):
            assert process.stdout is not None
            total = 0
            deadline = time.monotonic() + 120
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    while True:
                        if time.monotonic() > deadline:
                            raise ValueError("Release asset download timed out")
                        if not selector.select(timeout=1):
                            continue
                        chunk = os.read(process.stdout.fileno(), 1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > size:
                            raise ValueError("Release asset exceeds its approved size")
                        stream.write(chunk)
                if process.wait(timeout=5) or total != size:
                    raise ValueError("Release asset download failed or was incomplete")
            except BaseException:
                process.kill()
                process.wait()
                raise

    def upload(self, tag: str, files: list[Path]) -> None:
        command(
            [
                "gh",
                "release",
                "upload",
                tag,
                "--repo",
                "https://github.com/" + REPOSITORY,
                *[str(path) for path in files],
            ]
        )


def event_identity(event: Any, source: str) -> tuple[int, str]:
    value = object_value(event)
    release = object_value(value.get("release"))
    if (
        value.get("action") != "published"
        or object_value(value.get("repository")).get("full_name") != REPOSITORY
        or release.get("draft") is not False
        or type(release.get("prerelease")) is not bool
        or type(release.get("id")) is not int
        or release["id"] <= 0
        or not isinstance(release.get("tag_name"), str)
        or len(source) != 40
    ):
        raise ValueError("Only a published release in the accepted repository may promote")
    return release["id"], release["tag_name"]


def remote_tag(service: GitHub, tag: str, expected: str) -> None:
    value = object_value(service.json("/git/ref/tags/" + tag).get("object"))
    if value.get("type") != "tag" or value.get("sha") != expected:
        raise ValueError("Remote annotated tag changed after approval")


def recheck(
    service: GitHub,
    release_id: int,
    tag: str,
    bundle: dict[str, Any],
    inventory: dict[str, Any],
    inputs: Path,
) -> None:
    remote_tag(service, tag, bundle["tag_object"])
    if (
        release_inventory(service.json("/releases/" + str(release_id)), release_id, tag, bundle)
        != inventory
    ):
        raise ValueError("Release inputs changed after validation")
    verify_input_bytes(inputs, bundle)


def output_assets(work: Path, bundle: dict[str, Any], receipt: dict[str, Any]) -> list[Path]:
    output = work / "outputs"
    output.mkdir()
    (output / "jukelet-addon-registry.json").write_bytes(
        encoded({"format_version": 1, "artifact": "jukelet-addon-publication-receipt", **receipt})
    )
    with zipfile.ZipFile(
        output / "jukelet-addon-repository.zip", "x", compression=zipfile.ZIP_STORED
    ) as archive:
        for name in sorted(bundle["plan"]["repository_files"]):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.external_attr = 0o100644 << 16
            contents = _read(work / "prepared/repository", name).encode()
            if hashlib.sha256(contents).hexdigest() != bundle["plan"]["repository_files"][name]:
                raise ValueError("Repository snapshot changed before attachment")
            archive.writestr(entry, contents)
    checksums = "".join(
        hashlib.sha256(path.read_bytes()).hexdigest() + "  " + path.name + "\n"
        for path in sorted(output.iterdir())
    )
    (output / "jukelet-addon-output-sha256.txt").write_text(checksums)
    return sorted(output.iterdir())


def verify_outputs(
    service: GitHub,
    release_id: int,
    tag: str,
    bundle: dict[str, Any],
    inventory: dict[str, Any],
    files: list[Path],
    work: Path,
) -> None:
    release = service.json("/releases/" + str(release_id))
    all_assets = release.get("assets")
    if not isinstance(all_assets, list) or len(all_assets) != len(INPUTS) + len(OUTPUTS):
        raise ValueError("Published asset inventory is incomplete or unexpected")
    old = [item for item in all_assets if object_value(item).get("name") in INPUTS]
    if release_inventory({**release, "assets": old}, release_id, tag, bundle) != inventory:
        raise ValueError("Input assets changed during publication")
    new = [object_value(item) for item in all_assets if object_value(item).get("name") in OUTPUTS]
    if len(new) != len(OUTPUTS) or {item.get("name") for item in new} != OUTPUTS:
        raise ValueError("Output asset names are not exclusive")
    known_ids = {item["id"] for item in inventory.values()}
    observed_ids: set[int] = set()
    readback = work / "output-readback"
    readback.mkdir()
    expected = {
        path.name: (path.stat().st_size, hashlib.sha256(path.read_bytes()).hexdigest())
        for path in files
    }
    for item in new:
        size, sha = expected[item["name"]]
        if (
            type(item.get("id")) is not int
            or item["id"] <= 0
            or item["id"] in known_ids | observed_ids
            or item.get("state") != "uploaded"
            or item.get("size") != size
            or item.get("digest") != "sha256:" + sha
        ):
            raise ValueError("Uploaded output identity or digest differs from prepared bytes")
        observed_ids.add(item["id"])
        path = readback / item["name"]
        service.download(item["id"], path, size)
        if path.stat().st_size != size or hashlib.sha256(path.read_bytes()).hexdigest() != sha:
            raise ValueError("Uploaded output readback does not match prepared bytes")


def execute(
    phase: str,
    repository: Path,
    event: dict[str, Any],
    source: str,
    work: Path,
    expected_tag: str | None,
) -> dict[str, Any]:
    if phase not in {"validate", "verify-image", "publish"} or (
        phase != "validate" and expected_tag is None
    ):
        raise ValueError("Promotion requires a known phase and frozen tag identity")
    release_id, tag = event_identity(event, source)
    approved = tag_approval(repository, tag, source)
    if expected_tag is not None and expected_tag != approved["tag_object"]:
        raise ValueError("Tag changed between workflow jobs")
    if event["release"]["prerelease"] != approved["plan"]["prerelease"]:
        raise ValueError("Release event channel differs from approved source")
    service = GitHub()
    remote_tag(service, tag, approved["tag_object"])
    inventory = release_inventory(
        service.json("/releases/" + str(release_id)), release_id, tag, approved
    )
    _exclusive_directory_files(repository, work, {})
    inputs = work / "inputs"
    inputs.mkdir()
    for name, item in sorted(inventory.items()):
        service.download(item["id"], inputs / name, item["size"])
    bundle = verify_bundle(
        repository, inputs, work / "prepared", tag, source, approved["tag_object"]
    )
    recheck(service, release_id, tag, bundle, inventory, inputs)
    result = {
        "phase": phase,
        "source_commit": source,
        "tag_object": bundle["tag_object"],
        "image_reference": bundle["plan"]["image_reference"],
        "archive_sha256": bundle["artifact"]["archive_sha256"],
    }
    if phase == "validate":
        return result
    loaded = verify_image(bundle, inputs / "jukelet-addon-image.tar", work)
    if phase == "verify-image":
        return {**result, "loaded_image": loaded}
    # The workflow starts this job only after full CI and image verification.
    # No registry credentials are used until this job revalidates the same bytes.
    recheck(service, release_id, tag, bundle, inventory, inputs)
    password = os.environ.get("ADDON_REGISTRY_TOKEN", "")
    actor = os.environ.get("GITHUB_ACTOR", "")
    registry = Registry.authenticate(actor, password)
    command(
        ["docker", "login", "ghcr.io", "--username", actor, "--password-stdin"], password=password
    )
    recheck(service, release_id, tag, bundle, inventory, inputs)
    inspect_loaded(bundle["plan"]["image_reference"], bundle)
    registry.require_absent(bundle["plan"]["addon_version"])
    # A single exact push; never rebuild, force, retry or move a rolling alias.
    # OCI lacks an atomic create-only tag operation: exclude external writers.
    command(["docker", "image", "push", bundle["plan"]["image_reference"]])
    observation = work / "registry-readback"
    observation.mkdir()
    receipt = registry.readback(bundle["artifact"], bundle["plan"], observation)
    pull_ref = bundle["plan"]["image"] + "@" + receipt["registry_tag_digest"]
    command(["docker", "image", "pull", "--platform", "linux/amd64", pull_ref])
    pulled = inspect_loaded(pull_ref, bundle, registry=receipt)
    current = registry.manifest(bundle["plan"]["addon_version"])
    if current is None or current[1] != receipt["registry_tag_digest"]:
        raise ValueError("Published tag changed during effective-state verification")
    recheck(service, release_id, tag, bundle, inventory, inputs)
    files = output_assets(
        work,
        bundle,
        {
            **receipt,
            "tag_object": bundle["tag_object"],
            "release_id": release_id,
            "loaded_image": loaded,
            "digest_pulled_image": pulled,
            "archive_promotion": "exact approved saved bytes; no rebuild",
        },
    )
    service.upload(tag, files)
    remote_tag(service, tag, bundle["tag_object"])
    verify_outputs(service, release_id, tag, bundle, inventory, files, work)
    final = registry.manifest(bundle["plan"]["addon_version"])
    if final is None or final[1] != receipt["registry_tag_digest"]:
        raise ValueError("Published tag changed before completion")
    return {
        **result,
        "registry_manifest_digest": receipt["registry_manifest_digest"],
        "registry_index_digest": receipt["registry_index_digest"],
        "publication": "effective registry and uploaded asset readbacks verified",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("validate", "verify-image", "publish"))
    parser.add_argument("--repository", type=Path, default=Path.cwd())
    parser.add_argument("--event", type=Path, required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--expected-tag-object")
    args = parser.parse_args()
    try:
        result = execute(
            args.phase,
            args.repository,
            object_value(decoded(read_metadata(args.event))),
            args.source,
            args.work,
            args.expected_tag_object,
        )
    except (
        ValueError,
        OSError,
        KeyError,
        TypeError,
        EOFError,
        subprocess.SubprocessError,
        urllib.error.URLError,
    ):
        parser.error(
            "Add-on promotion failed. If a push began, reconcile immutable "
            "registry/release state before any retry."
        )
    if args.phase == "validate" and os.environ.get("GITHUB_OUTPUT"):
        with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
            output.write("tag_object=" + result["tag_object"] + "\n")
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
