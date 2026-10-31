"""Server-selected HA endpoints and credential; never browser-provided routing."""

from dataclasses import dataclass, field
from urllib.parse import urlsplit, urlunsplit


@dataclass(frozen=True)
class HAConnection:
    rest_api_url: str = field(repr=False)
    websocket_url: str = field(repr=False)
    token: str = field(repr=False)

    @classmethod
    def direct(cls, origin: str, token: str) -> HAConnection:
        parsed = urlsplit(origin)
        websocket_url = urlunsplit(
            ("wss" if parsed.scheme == "https" else "ws", parsed.netloc, "/api/websocket", "", "")
        )
        return cls(f"{origin}/api/", websocket_url, token)

    @classmethod
    def supervisor(cls, token: str) -> HAConnection:
        return cls("http://supervisor/core/api/", "ws://supervisor/core/websocket", token)
