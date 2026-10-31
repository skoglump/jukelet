"""Synthetic Supervisor metadata; these tests do not certify actual HA OS behavior."""

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from jukelet.config import Settings
from jukelet.main import create_app

ADMIN_ID = "a" * 32
INGRESS_PATH = "/api/hassio_ingress/synthetic-token_A"
TRUSTED_PEER = ("172.30.32.2", 43210)
HEADERS = {
    "X-Ingress-Path": INGRESS_PATH,
    "X-Remote-User-Id": ADMIN_ID,
    "X-Remote-User-Groups": "system-admin,system-users",
}


def ingress_settings(settings: Settings) -> Settings:
    return replace(settings, runtime="ingress", ingress_origins=("https://remote.example",))


def test_only_actual_supervisor_peer_can_reach_app(settings: Settings) -> None:
    configured = ingress_settings(settings)
    for peer in [("127.0.0.1", 80), ("172.30.32.3", 80), ("::ffff:172.30.32.2", 80)]:
        with TestClient(
            create_app(configured), base_url=configured.public_origin, client=peer
        ) as client:
            for path in ["/api/v1/session", "/api/v1/tags", "/", "/assets/private.js"]:
                response = client.get(
                    path,
                    headers=HEADERS
                    | {
                        "X-Forwarded-For": "172.30.32.2",
                        "X-Real-IP": "172.30.32.2",
                        "Forwarded": "for=172.30.32.2;host=jukelet.example;proto=https",
                    },
                )
                assert response.status_code == 403
                assert response.json() == {"detail": "Ingress access denied"}
                assert "set-cookie" not in response.headers


@pytest.mark.parametrize(
    "overrides",
    [
        {"X-Ingress-Path": ""},
        {"X-Ingress-Path": "/api/hassio_ingress/synthetic/"},
        {"X-Ingress-Path": "//attacker.example/path"},
        {"X-Ingress-Path": "/api/hassio_ingress/a%2Fb"},
        {"X-Ingress-Path": "/api/hassio_ingress/../other"},
        {"X-Ingress-Path": "/api/hassio_ingress/a?query"},
        {"X-Ingress-Path": "/api/hassio_ingress/a#fragment"},
        {"X-Ingress-Path": "/api/hassio_ingress/" + "a" * 257},
        {"X-Remote-User-Id": ""},
        {"X-Remote-User-Id": "unknown"},
        {"X-Remote-User-Id": "a" * 33},
        {"X-Remote-User-Groups": ""},
        {"X-Remote-User-Groups": "system-users"},
        {"X-Remote-User-Groups": "unknown-admin"},
        {"X-Remote-User-Groups": "system-admin-other"},
        {"X-Remote-User-Groups": "system-admin,system-admin"},
        {"X-Remote-User-Groups": "system-admin, system-users"},
    ],
)
def test_identity_and_path_fail_closed(settings: Settings, overrides: dict[str, str]) -> None:
    configured = ingress_settings(settings)
    with TestClient(
        create_app(configured), base_url=configured.public_origin, client=TRUSTED_PEER
    ) as client:
        response = client.get("/api/v1/session", headers=HEADERS | overrides)
        assert response.status_code == 403
        assert "set-cookie" not in response.headers
        assert ADMIN_ID not in response.text


@pytest.mark.parametrize("missing", list(HEADERS))
def test_missing_identity_is_not_replaced_by_service_credential(
    settings: Settings, missing: str
) -> None:
    configured = ingress_settings(settings)
    with TestClient(
        create_app(configured), base_url=configured.public_origin, client=TRUSTED_PEER
    ) as client:
        headers = {key: value for key, value in HEADERS.items() if key != missing}
        headers |= {
            "Authorization": "Bearer synthetic-service-token",
            "X-Remote-User-Name": "owner",
        }
        response = client.get("/api/v1/session", headers=headers)
        assert response.status_code == 403
        assert "synthetic-service-token" not in response.text
        assert "set-cookie" not in response.headers


@pytest.mark.parametrize("duplicate", [*HEADERS, "Host"])
def test_duplicate_trust_headers_are_rejected(settings: Settings, duplicate: str) -> None:
    configured = ingress_settings(settings)
    with TestClient(
        create_app(configured), base_url=configured.public_origin, client=TRUSTED_PEER
    ) as client:
        headers = list(HEADERS.items())
        headers += [(duplicate, HEADERS.get(duplicate, "jukelet.example"))] * (
            2 if duplicate == "Host" else 1
        )
        assert client.get("/api/v1/session", headers=headers).status_code in {400, 403}


def test_liveness_only_exemption_has_no_session_or_private_state(settings: Settings) -> None:
    configured = ingress_settings(settings)
    with TestClient(create_app(configured)) as client:
        response = client.get("/health/live", headers={"Host": "untrusted.example"})
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
        assert "set-cookie" not in response.headers
        for path in ["/health/live/", "/health/live/private", "/api/v1/status"]:
            assert client.get(path).status_code == 403
        assert client.post("/health/live").status_code == 403


def test_explicit_origins_allow_embedding_without_forwarded_host_trust(settings: Settings) -> None:
    configured = ingress_settings(settings)
    assets = configured.static_dir
    assets.mkdir()
    (assets / "index.html").write_text("<p>synthetic app</p>")
    with TestClient(
        create_app(configured), base_url=configured.public_origin, client=TRUSTED_PEER
    ) as client:
        for origin in configured.allowed_origins:
            response = client.get(origin + "/", headers=HEADERS)
            assert response.status_code == 200
            assert "frame-ancestors 'self'" in response.headers["content-security-policy"]
            assert "base-uri 'none'" in response.headers["content-security-policy"]
            assert response.headers["cache-control"] == "no-store"
            assert response.headers["x-content-type-options"] == "nosniff"
            # Still requires a session; a trusted origin does not bypass endpoint auth.
            denied = client.put(
                origin + "/api/v1/tags/synthetic/assignment",
                json={},
                headers=HEADERS | {"Origin": origin},
            )
            assert denied.status_code == 401
        assert (
            client.get(
                "/",
                headers=HEADERS
                | {"Host": "attacker.example", "X-Forwarded-Host": "jukelet.example"},
            ).status_code
            == 400
        )
        for origin in ["https://attacker.example", "null", "https://remote.example"]:
            response = client.post("/api/v1/session", json={}, headers=HEADERS | {"Origin": origin})
            assert response.status_code == 403
        duplicates = list(HEADERS.items()) + [("Origin", configured.public_origin)] * 2
        assert client.post("/api/v1/session", json={}, headers=duplicates).status_code == 403


def test_request_metadata_cannot_select_ingress_runtime(settings: Settings) -> None:
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        response = client.get("/api/v1/session", headers=HEADERS)
        assert response.status_code == 401
        assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
        login = client.post(
            "/api/v1/session",
            json={"secret": settings.auth_secret.decode()},
            headers=HEADERS | {"Origin": settings.public_origin},
        )
        assert login.status_code == 200
