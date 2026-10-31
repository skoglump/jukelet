"""Validate an independently approved, build-once add-on promotion bundle."""

import hashlib
import re
from pathlib import Path
from typing import Any

from scripts.addon_image import MAX_ARCHIVE, decoded, object_value, read_metadata, regular_file
from scripts.addon_release import prepare, source_plan, verify_archive
from scripts.package_addon import git

INPUTS = {
    "jukelet-addon-image.tar": MAX_ARCHIVE,
    "jukelet-addon-image.artifact.json": 1024 * 1024,
    "jukelet-addon-verification.json": 1024 * 1024,
}
OUTPUTS = {
    "jukelet-addon-registry.json",
    "jukelet-addon-repository.zip",
    "jukelet-addon-output-sha256.txt",
}
GATES = {
    "isolated_haos_clean_install",
    "isolated_haos_same_channel_upgrade",
    "support_matrix",
    "release_readiness",
}


def _hex(value: Any, length: int = 64) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{" + str(length) + "}", value) is None:
        raise ValueError("Invalid independently approved digest")
    return value


def tag_approval(repository: Path, tag: str, source: str) -> dict[str, Any]:
    _hex(source, 40)
    if re.fullmatch(r"addon-v[0-9a-z.-]{1,128}", tag) is None:
        raise ValueError("Invalid add-on promotion tag")
    plan, _context, _snapshot = source_plan(repository, source, tag, prerelease="-addon." in tag)
    reference = "refs/tags/" + tag
    tag_object = _hex(git(repository, "rev-parse", "--verify", reference).decode().strip(), 40)
    if git(repository, "cat-file", "-t", tag_object) != b"tag\n":
        raise ValueError("Promotion requires an annotated tag")
    raw = git(repository, "cat-file", "tag", tag_object)
    if len(raw) > 64 * 1024:
        raise ValueError("Promotion annotation is too large")
    headers, message = raw.split(b"\n\n", 1)
    fields: dict[str, str] = {}
    for header in headers.decode("utf-8").splitlines():
        name, value = header.split(" ", 1)
        if name in fields:
            raise ValueError("Duplicate annotated-tag header")
        fields[name] = value
    if (
        set(fields) != {"object", "type", "tag", "tagger"}
        or fields["object"] != source
        or fields["type"] != "commit"
        or fields["tag"] != tag
    ):
        raise ValueError("Annotated tag does not select the independently expected source")
    approval = object_value(decoded(message))
    if (
        set(approval)
        != {
            "format_version",
            "artifact",
            "source_commit",
            "image_reference",
            "platform",
            "image_id",
            "assets",
        }
        or type(approval["format_version"]) is not int
        or approval["format_version"] != 1
        or approval["artifact"] != "jukelet-addon-promotion-approval"
        or approval["source_commit"] != source
        or approval["image_reference"] != plan["image_reference"]
        or approval["platform"] != "linux/amd64"
        or not isinstance(approval["image_id"], str)
        or not approval["image_id"].startswith("sha256:")
    ):
        raise ValueError("Promotion approval identity does not match committed metadata")
    _hex(approval["image_id"][7:])
    assets = object_value(approval["assets"])
    if set(assets) != set(INPUTS):
        raise ValueError("Promotion approval must bind exactly the three input assets")
    for name, maximum in INPUTS.items():
        item = object_value(assets[name])
        if (
            set(item) != {"sha256", "size"}
            or type(item["size"]) is not int
            or not 0 < item["size"] <= maximum
        ):
            raise ValueError("Invalid approved asset size or structure")
        _hex(item["sha256"])
    return {"tag_object": tag_object, "approval": approval, "plan": plan}


def verification_record(value: Any, artifact: dict[str, Any], *, stable: bool) -> None:
    record = object_value(value)
    if (
        set(record)
        != {
            "format_version",
            "artifact",
            "source_commit",
            "archive_sha256",
            "image_id",
            "addon_version",
            "platform",
            "result",
            "reviewer",
            "gates",
            "limitations",
        }
        or type(record["format_version"]) is not int
        or record["format_version"] != 1
        or record["artifact"] != "jukelet-addon-verification"
        or record["result"] != "PASS"
        or record["reviewer"] != "APPROVED"
        or any(
            record[key] != artifact[key]
            for key in ("source_commit", "archive_sha256", "image_id", "addon_version", "platform")
        )
    ):
        raise ValueError("Verification attestation does not bind the approved artifact")
    gates = object_value(record["gates"])
    if set(gates) != GATES:
        raise ValueError("Verification attestation has an incomplete gate set")
    for name, value in gates.items():
        gate = object_value(value)
        required = stable or name.startswith("isolated_haos_")
        if (
            set(gate) != {"result", "evidence"}
            or gate["result"] not in ("PASS", "PENDING")
            or (required and gate["result"] != "PASS")
            or not isinstance(gate["evidence"], str)
            or not 1 <= len(gate["evidence"].strip()) <= 2048
        ):
            raise ValueError("Required actual verification evidence is missing")
    limitations = record["limitations"]
    if (
        not isinstance(limitations, list)
        or len(limitations) > 32
        or any(not isinstance(item, str) or not 1 <= len(item) <= 2048 for item in limitations)
    ):
        raise ValueError("Invalid verification limitations")


def verify_bundle(
    repository: Path, inputs: Path, prepared: Path, tag: str, source: str, expected_tag: str
) -> dict[str, Any]:
    approved = tag_approval(repository, tag, source)
    if approved["tag_object"] != _hex(expected_tag, 40):
        raise ValueError("Promotion tag changed after initial validation")
    verify_input_bytes(inputs, approved)
    plan = prepare(
        repository, source, tag, prerelease=approved["plan"]["prerelease"], output=prepared
    )
    artifact = verify_archive(
        repository,
        prepared,
        source,
        inputs / "jukelet-addon-image.tar",
        inputs / "jukelet-addon-image.artifact.json",
        expected_archive_sha256=approved["approval"]["assets"]["jukelet-addon-image.tar"]["sha256"],
    )
    if artifact["image_id"] != approved["approval"]["image_id"]:
        raise ValueError("Image config does not match promotion approval")
    verification_record(
        decoded(read_metadata(inputs / "jukelet-addon-verification.json")),
        artifact,
        stable=not plan["prerelease"],
    )
    return {**approved, "artifact": artifact}


def verify_input_bytes(inputs: Path, approved: dict[str, Any]) -> None:
    if set(path.name for path in inputs.iterdir()) != set(INPUTS):
        raise ValueError("Unexpected promotion input files")
    for name, maximum in INPUTS.items():
        expected = approved["approval"]["assets"][name]
        with regular_file(inputs / name, maximum) as stream:
            sha = hashlib.sha256()
            size = 0
            while chunk := stream.read(1024 * 1024):
                size += len(chunk)
                if size > maximum:
                    raise ValueError("Promotion input exceeds the supported bound")
                sha.update(chunk)
        if sha.hexdigest() != expected["sha256"] or size != expected["size"]:
            raise ValueError("Input bytes do not match the independently approved asset")


def release_inventory(
    release: Any, release_id: int, tag: str, approved: dict[str, Any]
) -> dict[str, Any]:
    value = object_value(release)
    if (
        type(value.get("id")) is not int
        or value["id"] != release_id
        or value.get("tag_name") != tag
        or value.get("draft") is not False
        or type(value.get("prerelease")) is not bool
        or value["prerelease"] != approved["plan"]["prerelease"]
        or value.get("immutable") is not False
    ):
        raise ValueError("Release identity changed or is not published")
    assets = value.get("assets")
    if not isinstance(assets, list) or len(assets) != len(INPUTS):
        raise ValueError("Existing or unexpected assets prevent immutable publication")
    result: dict[str, Any] = {}
    ids: set[int] = set()
    for raw in assets:
        item = object_value(raw)
        name = item.get("name")
        if (
            not isinstance(name, str)
            or name not in INPUTS
            or name in result
            or type(item.get("id")) is not int
            or item["id"] <= 0
            or item["id"] in ids
        ):
            raise ValueError("Invalid or duplicate release asset identity")
        expected = approved["approval"]["assets"][name]
        if (
            item.get("state") != "uploaded"
            or type(item.get("size")) is not int
            or item["size"] != expected["size"]
            or item.get("digest") != "sha256:" + expected["sha256"]
        ):
            raise ValueError("Release asset metadata differs from approved bytes")
        result[name] = {key: item[key] for key in ("id", "name", "size", "digest", "state")}
        ids.add(item["id"])
    return result
