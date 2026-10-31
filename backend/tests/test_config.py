from pathlib import Path

import pytest

from jukelet.config import Settings


def environment(tmp_path: Path) -> dict[str, str]:
    secret = tmp_path / "secret"
    secret.write_text("synthetic-configuration-secret-at-least-32-bytes\n")
    return {"APP_PUBLIC_ORIGIN": "https://jukelet.example", "APP_AUTH_TOKEN_FILE": str(secret)}


def test_secure_defaults_and_secret_repr(tmp_path: Path) -> None:
    settings = Settings.load(environment(tmp_path))
    assert settings.secure_cookie
    assert "synthetic-configuration-secret" not in repr(settings)


def test_https_scheme_case_cannot_remove_secure_cookie(tmp_path: Path) -> None:
    configured = Settings.load(
        environment(tmp_path) | {"APP_PUBLIC_ORIGIN": "HTTPS://jukelet.example"}
    )
    assert configured.secure_cookie


def test_local_http_requires_explicit_opt_in(tmp_path: Path) -> None:
    env = environment(tmp_path) | {"APP_PUBLIC_ORIGIN": "http://localhost:8000"}
    with pytest.raises(ValueError, match="HTTP requires"):
        Settings.load(env)
    settings = Settings.load(env | {"APP_ALLOW_INSECURE_HTTP": "true"})
    assert not settings.secure_cookie


@pytest.mark.parametrize(
    "overrides",
    [
        {"APP_MODE": "anything"},
        {"APP_PUBLIC_ORIGIN": ""},
        {"APP_PUBLIC_ORIGIN": "https://name:password@example.com"},
        {"APP_PUBLIC_ORIGIN": "https://example.com/path"},
        {"APP_PUBLIC_ORIGIN": "https://example.com?query=value"},
        {"APP_PUBLIC_ORIGIN": "https://example.com:invalid"},
        {"APP_PUBLIC_ORIGIN": "https://*.example"},
        {"APP_PUBLIC_ORIGIN": "http://example.com", "APP_ALLOW_INSECURE_HTTP": "true"},
        {"APP_ALLOW_INSECURE_HTTP": "yes"},
        {"APP_AUTH_TOKEN_FILE": "/nonexistent-synthetic-secret"},
    ],
)
def test_rejects_invalid_configuration(tmp_path: Path, overrides: dict[str, str]) -> None:
    with pytest.raises(ValueError):
        Settings.load(environment(tmp_path) | overrides)


@pytest.mark.parametrize("secret", ["", "short", "s" * 129])
def test_invalid_secret_is_not_disclosed(tmp_path: Path, secret: str) -> None:
    env = environment(tmp_path)
    Path(env["APP_AUTH_TOKEN_FILE"]).write_text(secret)
    with pytest.raises(ValueError, match="APP_AUTH_TOKEN_FILE") as error:
        Settings.load(env)
    if secret:
        assert secret not in str(error.value)


def test_ha_config_optional_paired_and_redacted(tmp_path: Path) -> None:
    secret = tmp_path / "secret"
    secret.write_text("synthetic-secret-value-at-least-32-bytes")
    env = {"APP_PUBLIC_ORIGIN": "https://jukelet.example", "APP_AUTH_TOKEN_FILE": str(secret)}
    assert Settings.load(env).ha_url is None
    valid = Settings.load(
        env | {"HA_URL": "https://ha.example:8123", "HA_TOKEN": "synthetic-ha-token"}
    )
    assert valid.ha_url == "https://ha.example:8123"
    assert "synthetic-ha-token" not in repr(valid)
    for values in (
        {"HA_URL": "https://ha.example"},
        {"HA_TOKEN": "synthetic-ha-token"},
        {"HA_URL": "https://user:password@ha.example"},
        {"HA_URL": "https://ha.example/path"},
        {"HA_URL": "https://ha.example/"},
        {"HA_URL": "https://ha.example?secret"},
        {"HA_URL": "https://ha.example#secret"},
        {"HA_URL": "https://ha.example:bad"},
        {"HA_TOKEN": "invalid\nsecret"},
    ):
        invalid = {"HA_URL": "https://ha.example", "HA_TOKEN": "synthetic-ha-token"} | values
        if values.keys() == {"HA_URL"} and values["HA_URL"] == "https://ha.example":
            invalid.pop("HA_TOKEN")
        if values.keys() == {"HA_TOKEN"} and values["HA_TOKEN"] == "synthetic-ha-token":
            invalid.pop("HA_URL")
        with pytest.raises(ValueError) as error:
            Settings.load(env | invalid)
        assert "synthetic-ha-token" not in str(error.value)
        assert "password" not in str(error.value)


@pytest.mark.parametrize("mode", ["", "auto", "SUPERVISOR", "from-request"])
def test_ha_transport_rejects_unknown_modes(tmp_path: Path, mode: str) -> None:
    with pytest.raises(ValueError, match="HA_TRANSPORT") as error:
        Settings.load(environment(tmp_path) | {"HA_TRANSPORT": mode})
    if mode:
        assert mode not in str(error.value)


@pytest.mark.parametrize(
    "token", [None, "", "private\nvalue", "private\x00value", "private\x7fvalue", "prívate"]
)
def test_supervisor_requires_its_own_valid_credential(tmp_path: Path, token: str | None) -> None:
    env = environment(tmp_path) | {"HA_TRANSPORT": "supervisor"}
    if token is not None:
        env["SUPERVISOR_TOKEN"] = token
    with pytest.raises(ValueError, match="SUPERVISOR_TOKEN") as error:
        Settings.load(env)
    assert "private" not in str(error.value)
    if token:
        assert token not in str(error.value)


@pytest.mark.parametrize("runtime", ["standalone", "ingress"])
@pytest.mark.parametrize("token", ["synthetic-supervisor-private", "invalid\nprivate"])
def test_direct_transport_stays_optional_and_ignores_supervisor_credential(
    tmp_path: Path, runtime: str, token: str
) -> None:
    env = environment(tmp_path) | {"SUPERVISOR_TOKEN": token, "APP_RUNTIME": runtime}
    unconfigured = Settings.load(env)
    assert unconfigured.ha_transport == "direct"
    assert unconfigured.ha_connection is None
    assert unconfigured.supervisor_token is None
    for transport in ({}, {"HA_TRANSPORT": "direct"}):
        configured = Settings.load(
            env
            | transport
            | {"HA_URL": "https://ha.example:8123", "HA_TOKEN": "synthetic-direct-private"}
        )
        connection = configured.ha_connection
        assert connection is not None
        assert connection.rest_api_url == "https://ha.example:8123/api/"
        assert connection.websocket_url == "wss://ha.example:8123/api/websocket"
        assert connection.token == "synthetic-direct-private"
        assert configured.supervisor_token is None
        assert "private" not in repr(configured)
        assert "private" not in repr(connection)


@pytest.mark.parametrize("origin", ["http://localhost:8123", "http://[::1]:18123"])
def test_direct_transport_keeps_http_and_ipv6_endpoints(tmp_path: Path, origin: str) -> None:
    configured = Settings.load(
        environment(tmp_path) | {"HA_URL": origin, "HA_TOKEN": "synthetic-direct-private"}
    )
    connection = configured.ha_connection
    assert connection is not None
    assert connection.rest_api_url == f"{origin}/api/"
    assert connection.websocket_url == f"ws{origin[4:]}/api/websocket"


@pytest.mark.parametrize("runtime", ["standalone", "ingress"])
@pytest.mark.parametrize("mode", ["read_only", "manage"])
def test_supervisor_resolves_only_fixed_backend_endpoints(
    tmp_path: Path, runtime: str, mode: str
) -> None:
    configured = Settings.load(
        environment(tmp_path)
        | {
            "HA_TRANSPORT": "supervisor",
            "SUPERVISOR_TOKEN": "synthetic-supervisor-private",
            "APP_RUNTIME": runtime,
            "APP_MODE": mode,
        }
    )
    assert configured.ha_transport == "supervisor"
    assert configured.runtime == runtime
    assert configured.mode == mode
    assert configured.ha_url is None
    assert configured.ha_token is None
    connection = configured.ha_connection
    assert connection is not None
    assert connection.rest_api_url == "http://supervisor/core/api/"
    assert connection.websocket_url == "ws://supervisor/core/websocket"
    assert connection.token == "synthetic-supervisor-private"
    assert "private" not in repr(configured)
    assert "private" not in repr(connection)
    assert "supervisor" not in configured.allowed_origins


@pytest.mark.parametrize(
    "direct",
    [
        {"HA_URL": "http://different.example"},
        {"HA_TOKEN": "synthetic-direct-private"},
        {"HA_URL": "http://different.example", "HA_TOKEN": "synthetic-direct-private"},
    ],
)
def test_supervisor_rejects_ambiguous_direct_configuration(
    tmp_path: Path, direct: dict[str, str]
) -> None:
    with pytest.raises(ValueError, match="must be unset") as error:
        Settings.load(
            environment(tmp_path)
            | {
                "HA_TRANSPORT": "supervisor",
                "SUPERVISOR_TOKEN": "synthetic-supervisor-private",
            }
            | direct
        )
    assert "private" not in str(error.value)
    assert "different.example" not in str(error.value)


def test_spotify_entity_is_optional_bounded_and_redacted(tmp_path: Path) -> None:
    env = environment(tmp_path)
    assert Settings.load(env).spotifyplus_entity_id is None
    configured = Settings.load(env | {"SPOTIFYPLUS_ENTITY_ID": "media_player.synthetic"})
    assert configured.spotifyplus_entity_id == "media_player.synthetic"
    assert "media_player.synthetic" not in repr(configured)
    for value in ("spotify.synthetic", "media_player.a/b", "media_player." + "x" * 129):
        with pytest.raises(ValueError) as error:
            Settings.load(env | {"SPOTIFYPLUS_ENTITY_ID": value})
        assert value not in str(error.value)


def test_local_manage_mode_is_explicit(tmp_path: Path) -> None:
    env = environment(tmp_path)
    assert Settings.load(env).mode == "read_only"
    assert Settings.load(env | {"APP_MODE": "manage"}).mode == "manage"


def test_runtime_selection_rejects_unknown_modes(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="APP_RUNTIME"):
        Settings.load(environment(tmp_path) | {"APP_RUNTIME": "from-request"})


def test_ingress_runtime_is_explicit_and_separate_from_mutation_mode(tmp_path: Path) -> None:
    env = environment(tmp_path)
    assert Settings.load(env).runtime == "standalone"
    configured = Settings.load(
        env
        | {
            "APP_RUNTIME": "ingress",
            "APP_INGRESS_ORIGINS": "https://ha.example:8123, https://remote.example",
        }
    )
    assert configured.runtime == "ingress"
    assert configured.mode == "read_only"
    assert configured.allowed_origins == (
        "https://jukelet.example",
        "https://ha.example:8123",
        "https://remote.example",
    )
    assert Settings.load(env | {"APP_MODE": "manage"}).runtime == "standalone"
    assert Settings.load(env | {"APP_RUNTIME": "ingress", "APP_MODE": "manage"}).mode == "manage"


@pytest.mark.parametrize(
    "extra",
    [
        "",
        "*",
        "https://*.example",
        "null",
        "https://jukelet.example",
        "https://remote.example,https://remote.example",
        "https://user:private@remote.example",
        "https://remote.example/path",
        "https://remote.example?private",
        "https://remote.example#private",
        "https://remote.example:bad",
        "http://remote.example",
        "https://remote.example\nprivate",
        ",".join(f"https://host{index}.example" for index in range(9)),
    ],
)
def test_ingress_origins_reject_wildcards_ambiguous_and_unsafe_values(
    tmp_path: Path, extra: str
) -> None:
    with pytest.raises(ValueError, match="APP_INGRESS_ORIGINS") as error:
        Settings.load(
            environment(tmp_path) | {"APP_RUNTIME": "ingress", "APP_INGRESS_ORIGINS": extra}
        )
    assert "private" not in str(error.value)


def test_standalone_cannot_enable_ingress_aliases(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="APP_INGRESS_ORIGINS"):
        Settings.load(environment(tmp_path) | {"APP_INGRESS_ORIGINS": "https://ha.example"})


@pytest.mark.parametrize("obsolete", ["automation.synthetic", "not an entity", "private\nvalue"])
def test_obsolete_automation_setting_is_inert(tmp_path: Path, obsolete: str) -> None:
    env = environment(tmp_path)
    plain = Settings.load(env)
    ignored = Settings.load({**env, "LEGACY_AUTOMATION_ENTITY_ID": obsolete})
    assert ignored == plain
    assert not hasattr(ignored, "legacy_automation_entity_id")
    assert obsolete not in repr(ignored)
