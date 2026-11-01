"""Explicit, server-only configuration. Errors never include environment values."""

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, cast
from urllib.parse import urlsplit

from jukelet.ha.transport import HAConnection


def _valid_origin(origin: str, insecure: str) -> bool:
    try:
        parsed = urlsplit(origin)
        _ = parsed.port
        return (
            parsed.scheme in {"http", "https"}
            and bool(parsed.hostname)
            and not parsed.username
            and not parsed.password
            and not parsed.path
            and not parsed.query
            and not parsed.fragment
            and origin.isascii()
            and "*" not in origin
            and not any(character.isspace() for character in origin)
            and (
                parsed.scheme == "https"
                or (insecure == "true" and parsed.hostname in {"localhost", "127.0.0.1", "::1"})
            )
        )
    except ValueError:
        return False


@dataclass(frozen=True)
class Settings:
    public_origin: str
    database_path: Path
    auth_secret: bytes = field(repr=False)
    static_dir: Path

    mode: Literal["read_only", "manage"] = "read_only"
    runtime: Literal["standalone", "ingress"] = "standalone"
    ingress_origins: tuple[str, ...] = ()
    # Internal startup adapter requirement, never a Supervisor/browser option.
    supervisor_continuity: bool = False

    ha_url: str | None = field(default=None, repr=False)
    ha_token: str | None = field(default=None, repr=False)
    ha_transport: Literal["direct", "supervisor"] = "direct"
    supervisor_token: str | None = field(default=None, repr=False)

    spotifyplus_entity_id: str | None = field(default=None, repr=False)

    @property
    def secure_cookie(self) -> bool:
        return urlsplit(self.public_origin).scheme == "https"

    @property
    def allowed_origins(self) -> tuple[str, ...]:
        if self.runtime == "ingress":
            return (self.public_origin, *self.ingress_origins)
        return (self.public_origin,)

    @property
    def ha_connection(self) -> HAConnection | None:
        if self.ha_transport == "supervisor":
            if self.supervisor_token:
                return HAConnection.supervisor(self.supervisor_token)
            return None
        if self.ha_url and self.ha_token:
            return HAConnection.direct(self.ha_url, self.ha_token)
        return None

    @classmethod
    def load(cls, environ: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if environ is None else environ
        if env.get("APP_MODE", "read_only") not in {"read_only", "manage"}:
            raise ValueError("APP_MODE must be read_only or manage")
        runtime = env.get("APP_RUNTIME", "standalone")
        if runtime not in {"standalone", "ingress"}:
            raise ValueError("APP_RUNTIME must be standalone or ingress")
        ha_transport = env.get("HA_TRANSPORT", "direct")
        if ha_transport not in {"direct", "supervisor"}:
            raise ValueError("HA_TRANSPORT must be direct or supervisor")
        continuity = env.get("JUKELET_SUPERVISOR_CONTINUITY", "")
        if continuity not in {"", "required"} or (
            continuity and (runtime != "ingress" or ha_transport != "supervisor")
        ):
            raise ValueError("Invalid internal Supervisor continuity requirement")
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
                and "*" not in origin
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
        extra_origins: tuple[str, ...] = ()
        if "APP_INGRESS_ORIGINS" in env:
            extra_origins = tuple(part.strip() for part in env["APP_INGRESS_ORIGINS"].split(","))
            if (
                runtime != "ingress"
                or len(extra_origins) > 8
                or len(set((origin, *extra_origins))) != len(extra_origins) + 1
                or any(
                    not _valid_origin(value, insecure) or urlsplit(value).scheme != parsed.scheme
                    for value in extra_origins
                )
            ):
                raise ValueError("APP_INGRESS_ORIGINS requires distinct allowed Ingress origins")
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
        supervisor_token: str | None = None
        if ha_transport == "supervisor":
            if ha_url or ha_token:
                raise ValueError("HA_URL and HA_TOKEN must be unset with Supervisor transport")
            supervisor_token = env.get("SUPERVISOR_TOKEN", "")
            if not supervisor_token or any(not 33 <= ord(c) <= 126 for c in supervisor_token):
                raise ValueError(
                    "SUPERVISOR_TOKEN must be a nonempty ASCII token without controls or whitespace"
                )
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
        spotify = env.get("SPOTIFYPLUS_ENTITY_ID", "")
        if spotify and not re.fullmatch(r"media_player\.[a-z0-9_]{1,128}", spotify):
            raise ValueError("SPOTIFYPLUS_ENTITY_ID must be a media_player entity ID")
        return cls(
            mode=cast(Literal["read_only", "manage"], env.get("APP_MODE", "read_only")),
            runtime=cast(Literal["standalone", "ingress"], runtime),
            ingress_origins=extra_origins,
            supervisor_continuity=continuity == "required",
            ha_transport=cast(Literal["direct", "supervisor"], ha_transport),
            supervisor_token=supervisor_token,
            spotifyplus_entity_id=spotify or None,
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
