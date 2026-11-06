"""Fixed native security request plans and redacted assessments; no transport or I/O."""

import hashlib
import json
import re
from typing import Any

_DENIED = {"detail": "Ingress access denied"}
_PATHS = {
    "root": "/",
    "session": "/api/v1/session",
    "tags": "/api/v1/tags",
    "asset": "/assets/synthetic-security.js",
}


def _prefix(value: str) -> None:
    if (
        type(value) is not str
        or re.fullmatch(r"/api/hassio_ingress/[A-Za-z0-9_-]{1,256}/", value) is None
    ):
        raise ValueError("unsafe_security_vector")


def security_vectors(prefix: str) -> list[dict[str, Any]]:
    """Return private fixed GET/HEAD plans; the coordinator owns all transport."""
    _prefix(prefix)
    host = [("Host", "127.0.0.1:18223")]
    identity = [
        ("X-Ingress-Path", prefix[:-1]),
        ("X-Remote-User-Id", "f" * 32),
        ("X-Remote-User-Groups", "system-admin"),
    ]
    forwarded = [
        ("Forwarded", "for=172.30.32.2;proto=https"),
        ("X-Forwarded-For", "172.30.32.2"),
        ("X-Real-IP", "172.30.32.2"),
    ]
    plans = []

    def add(label: str, source: str, path: str, headers: list[tuple[str, str]]) -> None:
        for method in ("GET", "HEAD"):
            plans.append(
                {
                    "case": label + "_" + method,
                    "source": source,
                    "method": method,
                    "path": path,
                    "headers": [*host, *headers],
                }
            )

    for label, path in _PATHS.items():
        add("loopback_" + label, "app_loopback", path, [*identity, *forwarded])
    for label, path in (
        ("health", "/health/live"),
        ("health_slash", "/health/live/"),
        ("health_child", "/health/live/private"),
    ):
        add("loopback_" + label, "app_loopback", path, [])
    for index, label in enumerate(("missing_path", "missing_user", "missing_groups")):
        add(
            label,
            "supervisor_namespace",
            "/api/v1/session",
            [value for i, value in enumerate(identity) if i != index],
        )
    for index, label, malformed in (
        (0, "malformed_path", prefix),
        (1, "malformed_user", "SYNTHETIC_NOT_A_USER"),
        (2, "malformed_groups", "system-admin,"),
        (2, "nonadmin_groups", "system-users"),
    ):
        changed = list(identity)
        changed[index] = (identity[index][0], malformed)
        add(label, "supervisor_namespace", "/api/v1/session", changed)
    add(
        "inert_bearer_no_identity",
        "supervisor_namespace",
        "/api/v1/session",
        [("Authorization", "Bearer SYNTHETIC_INERT_NOT_A_CREDENTIAL")],
    )
    return plans


def _complete_administrator(headers: list[tuple[str, str]]) -> bool:
    def single(name: str) -> str | None:
        found = [value for key, value in headers if key.lower() == name]
        return found[0] if len(found) == 1 else None

    path, user, groups = (
        single("x-ingress-path"),
        single("x-remote-user-id"),
        single("x-remote-user-groups"),
    )
    if path is None or user is None or groups is None:
        return False
    values = groups.split(",")
    return bool(
        re.fullmatch(r"/api/hassio_ingress/[A-Za-z0-9_-]{1,256}", path)
        and re.fullmatch(r"[a-f0-9]{32}", user)
        and all(re.fullmatch(r"[A-Za-z0-9_-]{1,64}", group) for group in values)
        and len(set(values)) == len(values)
        and "system-admin" in values
    )


def assert_safe_vector(vector: dict[str, Any], prefix: str) -> None:
    """Refuse any trusted-source complete synthetic administrator identity."""
    _prefix(prefix)
    if type(vector) is not dict or set(vector) != {"case", "source", "method", "path", "headers"}:
        raise ValueError("unsafe_security_vector")
    headers = vector["headers"]
    if (
        type(headers) is not list
        or len(headers) > 8
        or any(
            type(value) not in (tuple, list)
            or len(value) != 2
            or any(type(part) is not str or "\r" in part or "\n" in part for part in value)
            for value in headers
        )
    ):
        raise ValueError("unsafe_security_vector")
    if vector["source"] == "supervisor_namespace" and _complete_administrator(headers):
        raise ValueError("unsafe_security_vector")
    # Fixed plans also refuse unreviewed methods, paths, cookies and credentials.
    normalized = {**vector, "headers": [tuple(value) for value in headers]}
    if normalized not in security_vectors(prefix):
        raise ValueError("unsafe_security_vector")


def assert_packet_source(vector: dict[str, Any], source_peer: str, uid: int) -> None:
    """Operator calls after connect/before HTTP headers, using actual socket/UID."""
    if type(uid) is not int or uid < 0:
        raise ValueError("unverified_security_source")
    if vector["source"] == "app_loopback":
        if source_peer != "127.0.0.1" or uid != 10001:
            raise ValueError("unverified_security_source")
    elif vector["source"] == "supervisor_namespace":
        if source_peer != "172.30.32.2" or _complete_administrator(vector["headers"]):
            raise ValueError("unverified_security_source")
    else:
        raise ValueError("unverified_security_source")


def assess_packet(
    vector: dict[str, Any], prefix: str, observation: dict[str, Any]
) -> dict[str, Any]:
    """Assess one real response; source/container provenance is separate root evidence."""
    assert_safe_vector(vector, prefix)
    if set(observation) != {
        "case",
        "source",
        "status",
        "body",
        "set_cookie",
        "requests",
        "redirects",
        "source_peer",
        "uid",
    }:
        raise ValueError("invalid_security_observation")
    if (
        observation["case"] != vector["case"]
        or observation["source"] != vector["source"]
        or observation["set_cookie"] is not False
        or type(observation["requests"]) is not int
        or observation["requests"] != 1
        or type(observation["redirects"]) is not int
        or observation["redirects"] != 0
    ):
        raise ValueError("invalid_security_observation")
    assert_packet_source(vector, observation["source_peer"], observation["uid"])
    body = observation["body"]
    if type(body) is not bytes or len(body) > 4096 or type(observation["status"]) is not int:
        raise ValueError("invalid_security_observation")
    health = vector["path"] == "/health/live"
    expected = (200 if vector["method"] == "GET" else 404) if health else 403
    if observation["status"] != expected:
        raise ValueError("unexpected_security_status")
    if vector["method"] == "HEAD":
        if body != b"":
            raise ValueError("unexpected_security_body")
    else:
        try:
            actual = json.loads(body)
        except ValueError, UnicodeError:
            raise ValueError("unexpected_security_body") from None
        if actual != ({"status": "ok"} if health else _DENIED):
            raise ValueError("unexpected_security_body")
    return {
        "case": vector["case"],
        "source": vector["source"],
        "method": vector["method"],
        "status": expected,
        "body_bytes": len(body),
        "body_sha256": hashlib.sha256(body).hexdigest(),
        "no_set_cookie": True,
        "requests": 1,
        "redirects": 0,
        "privileged_access": False,
        "operator_socket_source_verified": True,
        "actor_uid": observation["uid"],
    }
