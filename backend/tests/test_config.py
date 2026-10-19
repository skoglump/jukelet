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


def test_local_http_requires_explicit_opt_in(tmp_path: Path) -> None:
    env = environment(tmp_path) | {"APP_PUBLIC_ORIGIN": "http://localhost:8000"}
    with pytest.raises(ValueError, match="HTTP requires"):
        Settings.load(env)
    settings = Settings.load(env | {"APP_ALLOW_INSECURE_HTTP": "true"})
    assert not settings.secure_cookie


@pytest.mark.parametrize(
    "overrides",
    [
        {"APP_MODE": "manage"},
        {"APP_MODE": "anything"},
        {"APP_PUBLIC_ORIGIN": ""},
        {"APP_PUBLIC_ORIGIN": "https://name:password@example.com"},
        {"APP_PUBLIC_ORIGIN": "https://example.com/path"},
        {"APP_PUBLIC_ORIGIN": "https://example.com?query=value"},
        {"APP_PUBLIC_ORIGIN": "https://example.com:invalid"},
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


def test_legacy_entity_is_optional_bounded_and_redacted(tmp_path: Path) -> None:
    env = environment(tmp_path)
    assert Settings.load(env).legacy_automation_entity_id is None
    assert (
        Settings.load(
            env | {"LEGACY_AUTOMATION_ENTITY_ID": "automation.synthetic"}
        ).legacy_automation_entity_id
        == "automation.synthetic"
    )
    for value in (
        "script.synthetic",
        "automation.a/b",
        "automation...",
        "automation." + "x" * 129,
        "https://private.example",
    ):
        with pytest.raises(ValueError) as error:
            Settings.load(env | {"LEGACY_AUTOMATION_ENTITY_ID": value})
        assert value not in str(error.value)
