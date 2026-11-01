"""Synthetic annotated tags and inert release transports; no external publication."""

import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any

import pytest
from test_addon_image import Release, image_archive, packed
from test_addon_image import release as release

from scripts.addon_promotion import release_inventory, tag_approval, verify_bundle
from scripts.addon_release import seal_archive


@pytest.fixture
def approved(release: Release, tmp_path: Path) -> tuple[Release, dict[str, Any], Path]:
    inputs = tmp_path / "inputs"
    inputs.mkdir()
    archive = inputs / "jukelet-addon-image.tar"
    image_archive(release, archive, modern=True, repository_record=True)
    artifact = seal_archive(
        release.repository,
        release.prepared,
        release.source,
        archive,
        inputs / "jukelet-addon-image.artifact.json",
    )
    verification = {
        "format_version": 1,
        "artifact": "jukelet-addon-verification",
        "source_commit": release.source,
        "archive_sha256": artifact["archive_sha256"],
        "image_id": artifact["image_id"],
        "addon_version": artifact["addon_version"],
        "platform": "linux/amd64",
        "result": "PASS",
        "reviewer": "APPROVED",
        "gates": {
            name: {"result": "PASS", "evidence": "SYNTHETIC fixture evidence"}
            for name in (
                "isolated_haos_clean_install",
                "isolated_haos_same_channel_upgrade",
                "support_matrix",
                "release_readiness",
            )
        },
        "limitations": ["Synthetic fixture, not actual HA OS evidence"],
    }
    (inputs / "jukelet-addon-verification.json").write_bytes(packed(verification))
    approval = {
        "format_version": 1,
        "artifact": "jukelet-addon-promotion-approval",
        "source_commit": release.source,
        "image_reference": release.plan["image_reference"],
        "platform": "linux/amd64",
        "image_id": artifact["image_id"],
        "assets": {
            path.name: {
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "size": path.stat().st_size,
            }
            for path in inputs.iterdir()
        },
    }
    return release, approval, inputs


def annotate(release: Release, approval: dict[str, Any], tmp_path: Path) -> None:
    message = tmp_path / "approval.json"
    message.write_bytes(packed(approval))
    subprocess.run(
        [
            "git",
            "-C",
            str(release.repository),
            "-c",
            "user.name=Synthetic",
            "-c",
            "user.email=synthetic@example.invalid",
            "tag",
            "-a",
            release.plan["release_tag"],
            "-F",
            str(message),
            release.source,
        ],
        check=True,
        capture_output=True,
    )


def test_annotated_tag_binds_independently_approved_source_and_input_bytes(
    approved: tuple[Release, dict[str, Any], Path], tmp_path: Path
) -> None:
    release, expected, _inputs = approved
    annotate(release, expected, tmp_path)
    result = tag_approval(release.repository, release.plan["release_tag"], release.source)
    assert result["approval"] == expected
    assert result["tag_object"] != release.source
    assert len(result["tag_object"]) == 40


@pytest.mark.parametrize(
    "mutation",
    [
        "source",
        "image",
        "architecture",
        "checksum",
        "size",
        "extra_asset",
        "extra_field",
        "config_id",
    ],
)
def test_invalid_approval_cannot_authorize_downloaded_sidecars(
    approved: tuple[Release, dict[str, Any], Path], tmp_path: Path, mutation: str
) -> None:
    release, approval, _inputs = approved
    if mutation == "source":
        approval["source_commit"] = "0" * 40
    elif mutation == "image":
        approval["image_reference"] = "ghcr.io/skoglump/jukelet:latest"
    elif mutation == "architecture":
        approval["platform"] = "linux/arm64"
    elif mutation == "checksum":
        approval["assets"]["jukelet-addon-image.tar"]["sha256"] = "A" * 64
    elif mutation == "size":
        approval["assets"]["jukelet-addon-image.tar"]["size"] = True
    elif mutation == "extra_asset":
        approval["assets"]["arbitrary.sh"] = {"sha256": "0" * 64, "size": 1}
    elif mutation == "extra_field":
        approval["skip_checks"] = True
    else:
        approval["image_id"] = "sha256:bad"
    annotate(release, approval, tmp_path)
    with pytest.raises(ValueError):
        tag_approval(release.repository, release.plan["release_tag"], release.source)


def test_lightweight_tag_is_not_an_approved_promotion(
    approved: tuple[Release, dict[str, Any], Path],
) -> None:
    release, _approval, _inputs = approved
    subprocess.run(
        ["git", "-C", str(release.repository), "tag", release.plan["release_tag"], release.source],
        check=True,
    )
    with pytest.raises(ValueError, match="annotated"):
        tag_approval(release.repository, release.plan["release_tag"], release.source)


def test_downloaded_bundle_is_rechecked_against_frozen_tag_and_real_archive(
    approved: tuple[Release, dict[str, Any], Path], tmp_path: Path
) -> None:
    release, approval, inputs = approved
    annotate(release, approval, tmp_path)
    frozen = tag_approval(release.repository, release.plan["release_tag"], release.source)
    checked = verify_bundle(
        release.repository,
        inputs,
        tmp_path / "reprepared",
        release.plan["release_tag"],
        release.source,
        frozen["tag_object"],
    )
    assert (
        checked["artifact"]["archive_sha256"]
        == approval["assets"]["jukelet-addon-image.tar"]["sha256"]
    )
    with pytest.raises(ValueError, match="tag changed"):
        verify_bundle(
            release.repository,
            inputs,
            tmp_path / "changed",
            release.plan["release_tag"],
            release.source,
            "0" * 40,
        )
    archive = inputs / "jukelet-addon-image.tar"
    archive.write_bytes(archive.read_bytes() + b"changed")
    with pytest.raises(ValueError, match="independently approved"):
        verify_bundle(
            release.repository,
            inputs,
            tmp_path / "replacement",
            release.plan["release_tag"],
            release.source,
            frozen["tag_object"],
        )
    assert not (tmp_path / "replacement").exists()


def release_data(release: Release, approval: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": 123,
        "tag_name": release.plan["release_tag"],
        "draft": False,
        "prerelease": release.plan["prerelease"],
        "immutable": False,
        "assets": [
            {
                "id": index,
                "name": name,
                "state": "uploaded",
                "size": item["size"],
                "digest": "sha256:" + item["sha256"],
            }
            for index, (name, item) in enumerate(approval["assets"].items(), 1)
        ],
    }


@pytest.mark.parametrize(
    "mutation",
    [
        "none",
        "draft",
        "channel",
        "immutable",
        "missing_immutable",
        "extra",
        "duplicate",
        "partial",
        "digest",
        "id",
    ],
)
def test_release_inventory_is_exact_and_never_replaces_existing_outputs(
    approved: tuple[Release, dict[str, Any], Path], tmp_path: Path, mutation: str
) -> None:
    release, approval, _inputs = approved
    annotate(release, approval, tmp_path)
    frozen = tag_approval(release.repository, release.plan["release_tag"], release.source)
    value = release_data(release, approval)
    if mutation == "draft":
        value["draft"] = True
    elif mutation == "channel":
        value["prerelease"] = not value["prerelease"]
    elif mutation == "immutable":
        value["immutable"] = True
    elif mutation == "missing_immutable":
        value.pop("immutable")
    elif mutation == "extra":
        value["assets"].append({"name": "jukelet-addon-registry.json"})
    elif mutation == "duplicate":
        value["assets"][1] = value["assets"][0]
    elif mutation == "partial":
        value["assets"][0]["state"] = "starter"
    elif mutation == "digest":
        value["assets"][0]["digest"] = "sha256:" + "0" * 64
    elif mutation == "id":
        value["id"] = 124
    if mutation == "none":
        assert len(release_inventory(value, 123, release.plan["release_tag"], frozen)) == 3
    else:
        with pytest.raises(ValueError):
            release_inventory(value, 123, release.plan["release_tag"], frozen)


@pytest.mark.parametrize(
    "mutation", ["result", "reviewer", "source", "missing_gate", "pending_install", "extra_field"]
)
def test_approved_hashes_cannot_turn_partial_or_unbound_verification_into_a_pass(
    approved: tuple[Release, dict[str, Any], Path], tmp_path: Path, mutation: str
) -> None:
    release, approval, inputs = approved
    path = inputs / "jukelet-addon-verification.json"
    value = json.loads(path.read_bytes())
    if mutation == "result":
        value["result"] = "PARTIAL"
    elif mutation == "reviewer":
        value["reviewer"] = "CHANGES_REQUESTED"
    elif mutation == "source":
        value["source_commit"] = "0" * 40
    elif mutation == "missing_gate":
        value["gates"].pop("support_matrix")
    elif mutation == "pending_install":
        value["gates"]["isolated_haos_clean_install"]["result"] = "PENDING"
    else:
        value["skip_verification"] = True
    path.write_bytes(packed(value))
    approval["assets"][path.name] = {
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "size": path.stat().st_size,
    }
    annotate(release, approval, tmp_path)
    frozen = tag_approval(release.repository, release.plan["release_tag"], release.source)
    with pytest.raises(ValueError, match="attestation|verification"):
        verify_bundle(
            release.repository,
            inputs,
            tmp_path / "reprepared",
            release.plan["release_tag"],
            release.source,
            frozen["tag_object"],
        )


@pytest.mark.parametrize("release", ["0.1.0-addon.7", "1.0.0"], indirect=True)
def test_future_stable_requires_matrix_and_readiness_while_candidate_records_pending_limits(
    approved: tuple[Release, dict[str, Any], Path], tmp_path: Path
) -> None:
    release, approval, inputs = approved
    path = inputs / "jukelet-addon-verification.json"
    value = json.loads(path.read_bytes())
    value["gates"]["support_matrix"]["result"] = "PENDING"
    value["gates"]["release_readiness"]["result"] = "PENDING"
    path.write_bytes(packed(value))
    approval["assets"][path.name] = {
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "size": path.stat().st_size,
    }
    annotate(release, approval, tmp_path)
    frozen = tag_approval(release.repository, release.plan["release_tag"], release.source)
    if release.plan["prerelease"]:
        assert (
            verify_bundle(
                release.repository,
                inputs,
                tmp_path / "reprepared",
                release.plan["release_tag"],
                release.source,
                frozen["tag_object"],
            )["artifact"]["addon_version"]
            == "0.1.0-addon.7"
        )
    else:
        with pytest.raises(ValueError, match="verification"):
            verify_bundle(
                release.repository,
                inputs,
                tmp_path / "reprepared",
                release.plan["release_tag"],
                release.source,
                frozen["tag_object"],
            )
