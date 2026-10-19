"""Explicit, server-only configuration. Errors never include environment values."""

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Settings:
    public_origin: str
    database_path: Path
    auth_secret: bytes = field(repr=False)
    static_dir: Path

    ha_url: str | None = field(default=None, repr=False)
    ha_token: str | None = field(default=None, repr=False)

    legacy_automation_entity_id: str | None = field(default=None, repr=False)

    spotifyplus_entity_id: str | None = field(default=None, repr=False)

    @property
    def secure_cookie(self) -> bool:
        return self.public_origin.startswith("https://")

    @classmethod
    def load(cls, environ: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if environ is None else environ
        if env.get("APP_MODE", "read_only") != "read_only":
            raise ValueError("APP_MODE must be read_only in this release")
        insecure = env.get("APP_ALLOW_INSECURE_HTTP", "false")
        if insecure not in {"true", "false"}:
            raise ValueError("APP_ALLOW_INSECURE_HTTP must be true or false")
        origin = env.get("APP_PUBLIC_ORIGIN", "").rstrip("/")
        try:
            parsed = urlsplit(origin)
            _ = parsed.port
            valid = (
                parsed.scheme in {"http", "https"}
                and bool(parsed.hostname)
                and not parsed.username
                and not parsed.password
                and not parsed.path
                and not parsed.query
                and not parsed.fragment
                and origin.isascii()
                and not any(character.isspace() for character in origin)
            )
        except ValueError:
            valid = False
        if not valid:
            raise ValueError("APP_PUBLIC_ORIGIN must be an HTTP(S) origin")
        if parsed.scheme == "http" and not (
            insecure == "true" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        ):
            raise ValueError("HTTP requires explicit development mode and a loopback origin")
        try:
            secret_path = Path(env["APP_AUTH_TOKEN_FILE"])
            with secret_path.open("rb") as stream:
                secret = stream.read(130).rstrip(b"\r\n")
            if not 32 <= len(secret) <= 128 or not secret.isascii():
                raise ValueError
        except KeyError, OSError, ValueError:
            raise ValueError(
                "APP_AUTH_TOKEN_FILE must contain a 32–128 byte ASCII secret"
            ) from None
        ha_url = env.get("HA_URL", "")
        ha_token = env.get("HA_TOKEN", "")
        try:
            ha = urlsplit(ha_url)
            _ = ha.port
            valid_ha = (
                ha.scheme in {"http", "https"}
                and bool(ha.hostname)
                and ha.username is None
                and ha.password is None
                and not ha.path
                and not ha.query
                and not ha.fragment
                and ha_url.isascii()
                and not any(c.isspace() for c in ha_url)
            )
        except ValueError:
            valid_ha = False
        if bool(ha_url) != bool(ha_token) or (ha_url and not valid_ha):
            raise ValueError("HA_URL and HA_TOKEN require a valid HTTP(S) origin and token")
        if ha_token and (not ha_token.isascii() or any(c.isspace() for c in ha_token)):
            raise ValueError("HA_TOKEN must be a nonempty ASCII token without whitespace")
        legacy = env.get("LEGACY_AUTOMATION_ENTITY_ID", "")
        if legacy and not re.fullmatch(r"automation\.[a-z0-9_]{1,128}", legacy):
            raise ValueError("LEGACY_AUTOMATION_ENTITY_ID must be an automation entity ID")
        spotify = env.get("SPOTIFYPLUS_ENTITY_ID", "")
        if spotify and not re.fullmatch(r"media_player\.[a-z0-9_]{1,128}", spotify):
            raise ValueError("SPOTIFYPLUS_ENTITY_ID must be a media_player entity ID")
        return cls(
            spotifyplus_entity_id=spotify or None,
            legacy_automation_entity_id=legacy or None,
            ha_url=ha_url or None,
            ha_token=ha_token or None,
            public_origin=origin,
            database_path=Path(env.get("DATABASE_PATH", "./data/jukelet.db")),
            auth_secret=secret,
            static_dir=Path(
                env.get(
                    "APP_STATIC_DIR", str(Path(__file__).resolve().parents[3] / "frontend/dist")
                )
            ),
        )
