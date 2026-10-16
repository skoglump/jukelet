"""Explicit, server-only configuration. Errors never include environment values."""

import os
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
        return cls(
            public_origin=origin,
            database_path=Path(env.get("DATABASE_PATH", "./data/jukelet.db")),
            auth_secret=secret,
            static_dir=Path(
                env.get(
                    "APP_STATIC_DIR", str(Path(__file__).resolve().parents[3] / "frontend/dist")
                )
            ),
        )
