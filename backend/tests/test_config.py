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
