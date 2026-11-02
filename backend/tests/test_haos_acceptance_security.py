"""Pure request-plan controls; never connect to HA or an app listener."""

import copy
import json

import pytest

from scripts.haos_acceptance.security_vectors import (
    assert_packet_source,
    assert_safe_vector,
    assess_packet,
    security_vectors,
)

PREFIX = "/api/hassio_ingress/SYNTHETIC_PREFIX/"


def test_trusted_source_complete_fake_admin_tuple_is_refused() -> None:
    prefix = "/api/hassio_ingress/SYNTHETIC_PREFIX/"
    vector = {
        "case": "missing_user_GET",
        "source": "supervisor_namespace",
        "method": "GET",
        "path": "/api/v1/session",
        "headers": [
            ("Host", "127.0.0.1:18223"),
            ("X-Ingress-Path", prefix[:-1]),
            ("X-Remote-User-Id", "f" * 32),
            ("X-Remote-User-Groups", "system-admin"),
        ],
    }
    with pytest.raises(ValueError, match="unsafe_security_vector"):
        assert_safe_vector(vector, prefix)


def test_all_fixed_plans_are_read_only_safe_and_json_round_trip_preserves_headers() -> None:
    vectors = security_vectors(PREFIX)
    assert len(vectors) == 30
    assert len({vector["case"] for vector in vectors}) == 30
    for vector in vectors:
        assert vector["method"] in {"GET", "HEAD"}
        assert_safe_vector(vector, PREFIX)
        assert_safe_vector(json.loads(json.dumps(vector)), PREFIX)
    assert not any(vector["case"].startswith("duplicate_") for vector in vectors)


def test_complete_trusted_admin_identity_is_refused_for_any_casing_or_valid_prefix() -> None:
    value = next(v for v in security_vectors(PREFIX) if v["case"] == "missing_groups_GET")
    value["headers"].append(("x-ReMoTe-UsEr-GrOuPs", "system-users,system-admin"))
    with pytest.raises(ValueError, match="unsafe_security_vector"):
        assert_safe_vector(value, PREFIX)
    value["headers"][1] = ("X-Ingress-Path", "/api/hassio_ingress/ANOTHER_VALID_PREFIX")
    with pytest.raises(ValueError, match="unsafe_security_vector"):
        assert_safe_vector(value, PREFIX)


def test_fixed_plans_refuse_cookie_credentials_methods_arbitrary_targets_and_header_injection() -> (
    None
):
    original = security_vectors(PREFIX)[0]
    for key, bad in (
        ("method", "POST"),
        ("path", "http://example.invalid"),
        ("source", "household"),
        ("headers", [("Cookie", "SECRET")]),
        ("headers", [("Host", "bad\r\nX: bad")]),
    ):
        value = copy.deepcopy(original)
        value[key] = bad
        with pytest.raises(ValueError, match="unsafe_security_vector"):
            assert_safe_vector(value, PREFIX)
    for prefix in (
        "/",
        PREFIX + "?query",
        "/api/hassio_ingress/../wrong/",
        "https://example.invalid/",
    ):
        with pytest.raises(ValueError, match="unsafe_security_vector"):
            security_vectors(prefix)


def test_actual_packaged_health_control_and_every_protected_denial_have_redacted_assessments() -> (
    None
):
    for vector in security_vectors(PREFIX):
        health = vector["path"] == "/health/live"
        status = (200 if vector["method"] == "GET" else 404) if health else 403
        body = (
            b""
            if vector["method"] == "HEAD"
            else json.dumps(
                {"status": "ok"} if health else {"detail": "Ingress access denied"}
            ).encode()
        )
        observed = {
            "case": vector["case"],
            "source": vector["source"],
            "status": status,
            "body": body,
            "set_cookie": False,
            "requests": 1,
            "redirects": 0,
            "source_peer": "127.0.0.1" if vector["source"] == "app_loopback" else "172.30.32.2",
            "uid": 10001 if vector["source"] == "app_loopback" else 0,
        }
        result = assess_packet(vector, PREFIX, observed)
        assert result["status"] == status and result["privileged_access"] is False
        assert "headers" not in result and "path" not in result and "body" not in result
        if health and vector["method"] == "HEAD":
            assert result["status"] == 404 and result["body_bytes"] == 0
        for key, bad in (
            ("status", 200 if status != 200 else 403),
            ("set_cookie", True),
            ("body", b"SECRET"),
            ("requests", 2),
            ("requests", True),
            ("redirects", 1),
            ("source_peer", "192.0.2.1"),
            ("uid", True),
        ):
            value = {**observed, key: bad}
            with pytest.raises(ValueError):
                assess_packet(vector, PREFIX, value)


def test_wrong_namespace_cannot_send_loopback_forged_admin_tuple_from_trusted_source() -> None:
    vector = security_vectors(PREFIX)[0]
    with pytest.raises(ValueError, match="unverified_security_source"):
        assert_packet_source(vector, "172.30.32.2", 0)
    with pytest.raises(ValueError, match="unverified_security_source"):
        assert_packet_source(vector, "127.0.0.1", 0)
    assert_packet_source(vector, "127.0.0.1", 10001)
