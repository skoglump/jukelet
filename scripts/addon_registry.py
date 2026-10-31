"""Fixed-namespace GHCR reads with authenticated, fail-closed observations."""

from __future__ import annotations

import base64
import gzip
import hashlib
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from scripts.addon_image import (
    DOCKER_MANIFEST,
    MAX_JSON,
    MAX_LAYER,
    OCI_MANIFEST,
    _verify_manifest,
    decoded,
    descriptor,
    digest,
    object_value,
    registry_observation,
)

BASE = "https://ghcr.io/v2/skoglump/jukelet-addon"
INDEX_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}
ACCEPT = ", ".join(sorted(INDEX_TYPES | {OCI_MANIFEST, DOCKER_MANIFEST}))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str
    ) -> None:
        return None


def response(url: str, token: str, *, basic: bool = False, accept: str = ACCEPT) -> Any:
    headers = {"Accept": accept}
    if token:
        headers["Authorization"] = ("Basic " if basic else "Bearer ") + token
    request = urllib.request.Request(url, headers=headers)
    try:
        return urllib.request.build_opener(NoRedirect()).open(request, timeout=20)
    except urllib.error.HTTPError as error:
        return error


class Registry:
    def __init__(self, token: str):
        if not token:
            raise ValueError("Registry authentication is required")
        self._token = token

    @classmethod
    def authenticate(cls, actor: str, password: str) -> Registry:
        if not actor or not password or ":" in actor or "\n" in actor:
            raise ValueError("Registry credentials are missing or malformed")
        basic = base64.b64encode((actor + ":" + password).encode()).decode()
        url = "https://ghcr.io/token?" + urllib.parse.urlencode(
            {"service": "ghcr.io", "scope": "repository:skoglump/jukelet-addon:pull,push"}
        )
        with response(url, basic, basic=True, accept="application/json") as result:
            raw = result.read(MAX_JSON + 1)
            if result.status != 200 or len(raw) > MAX_JSON:
                raise ValueError("Registry authentication failed")
        value = object_value(decoded(raw)).get("token")
        if not isinstance(value, str) or not value or len(value) > 64 * 1024:
            raise ValueError("Registry did not provide a bounded authentication token")
        return cls(value)

    def manifest(self, reference: str, *, allow_absent: bool = False) -> tuple[bytes, str] | None:
        with response(
            BASE + "/manifests/" + urllib.parse.quote(reference, safe=":"), self._token
        ) as result:
            raw = result.read(MAX_JSON + 1)
            if len(raw) > MAX_JSON:
                raise ValueError("Registry manifest response is too large")
            if result.status == 404 and allow_absent:
                errors = object_value(decoded(raw)).get("errors")
                if (
                    isinstance(errors, list)
                    and len(errors) == 1
                    and object_value(errors[0]).get("code") in {"MANIFEST_UNKNOWN", "NAME_UNKNOWN"}
                ):
                    return None
                raise ValueError("Registry absence was not established")
            if result.status != 200:
                raise ValueError("Registry manifest request failed; absence is not established")
            observed = result.headers.get("Docker-Content-Digest")
            if not isinstance(observed, str) or digest(raw) != observed:
                raise ValueError("Registry manifest body and digest header disagree")
            return raw, observed

    def require_absent(self, version: str) -> None:
        if self.manifest(version, allow_absent=True) is not None:
            raise ValueError("Existing add-on image tags are immutable; refuse replacement")

    def blob(self, item: dict[str, Any], output: Path) -> None:
        url = BASE + "/blobs/" + item["digest"]
        token = self._token
        for _attempt in range(3):
            with response(url, token, accept="application/octet-stream") as result:
                if result.status in {301, 302, 303, 307, 308}:
                    target = urllib.parse.urlsplit(result.headers.get("Location", ""))
                    if (
                        target.scheme != "https"
                        or target.hostname
                        not in {"ghcr.io", "pkg-containers.githubusercontent.com"}
                        or target.port not in {None, 443}
                        or target.username is not None
                        or target.password is not None
                    ):
                        raise ValueError("Unsupported registry blob redirect")
                    url = target.geturl()
                    # Signed blob downloads do not receive the registry bearer.
                    token = ""
                    continue
                if result.status != 200:
                    raise ValueError("Registry blob readback failed")
                total = 0
                sha = hashlib.sha256()
                with output.open("xb") as stream:
                    while chunk := result.read(1024 * 1024):
                        total += len(chunk)
                        if total > item["size"] or total > MAX_LAYER:
                            raise ValueError("Registry blob exceeds its approved descriptor")
                        sha.update(chunk)
                        stream.write(chunk)
                if total != item["size"] or "sha256:" + sha.hexdigest() != item["digest"]:
                    raise ValueError("Registry blob readback digest or size mismatch")
                return
        raise ValueError("Registry blob redirect limit exceeded")

    def readback(
        self, artifact: dict[str, Any], plan: dict[str, Any], directory: Path
    ) -> dict[str, Any]:
        tagged = self.manifest(plan["addon_version"])
        if tagged is None:
            raise ValueError("Published registry tag is absent")
        raw, top_digest = tagged
        if self.manifest(top_digest) != tagged:
            raise ValueError("Registry tag and digest readbacks disagree")
        top = object_value(decoded(raw))
        index_raw: bytes | None = None
        index_digest: str | None = None
        if top.get("mediaType") in INDEX_TYPES:
            entries = top.get("manifests")
            if not isinstance(entries, list) or len(entries) != 1:
                raise ValueError("Registry index must select exactly one tested image")
            selected = descriptor(entries[0], types={OCI_MANIFEST, DOCKER_MANIFEST})
            child = self.manifest(selected["digest"])
            if child is None or child[1] != selected["digest"] or len(child[0]) != selected["size"]:
                raise ValueError("Registry index child readback mismatch")
            index_raw, index_digest = raw, top_digest
            raw, platform_digest = child
        else:
            platform_digest = top_digest
        receipt = registry_observation(
            artifact,
            raw,
            platform_digest,
            observed_image=plan["image_reference"],
            fixture=False,
            index_bytes=index_raw,
            index_digest=index_digest,
        )
        manifest = object_value(decoded(raw))
        layers = _verify_manifest(
            manifest, artifact["image_id"], artifact["image_config_bytes"], None
        )
        config = descriptor(
            manifest["config"],
            types={
                "application/vnd.oci.image.config.v1+json",
                "application/vnd.docker.container.image.v1+json",
            },
        )
        if config["size"] > MAX_JSON:
            raise ValueError("Registry image config is too large")
        config_file = directory / "registry-config.json"
        self.blob(config, config_file)
        value = object_value(decoded(config_file.read_bytes()))
        if (
            value.get("architecture") != "amd64"
            or value.get("os") != "linux"
            or object_value(value.get("rootfs")).get("diff_ids") != artifact["layer_diff_ids"]
        ):
            raise ValueError("Registry config filesystem identity differs from tested archive")
        runtime = object_value(value.get("config"))
        labels = object_value(runtime.get("Labels"))
        if any(labels.get(key) != expected for key, expected in plan["labels"].items()):
            raise ValueError("Registry config labels differ from the reviewed source")
        for number, (item, expected_diff) in enumerate(
            zip(layers, artifact["layer_diff_ids"], strict=True)
        ):
            path = directory / f"registry-layer-{number}.blob"
            self.blob(item, path)
            with path.open("rb") as stream:
                content = gzip.GzipFile(fileobj=stream) if "gzip" in item["mediaType"] else stream
                try:
                    total = 0
                    sha = hashlib.sha256()
                    while chunk := content.read(1024 * 1024):
                        total += len(chunk)
                        if total > MAX_LAYER:
                            raise ValueError("Registry layer expands beyond the supported bound")
                        sha.update(chunk)
                    if "sha256:" + sha.hexdigest() != expected_diff:
                        raise ValueError("Registry layer filesystem diffID mismatch")
                finally:
                    if content is not stream:
                        content.close()
        (directory / "registry-manifest.json").write_bytes(raw)
        if index_raw is not None:
            (directory / "registry-index.json").write_bytes(index_raw)
        return {
            **receipt,
            "registry_tag_digest": top_digest,
            "network_readback": "tag/digest manifest, config and all layer bodies verified",
        }
