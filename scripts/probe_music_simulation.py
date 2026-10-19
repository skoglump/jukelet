"""Probe the local synthetic Postman simulation only. Restart it before each probe.

Run with the backend environment; target is fixed loopback, no household settings read.
"""

import asyncio

from jukelet.ha.adapter import HAAdapter
from jukelet.ha.rest import RestClient, capabilities
from jukelet.providers.spotifyplus import SpotifyPlus


async def main() -> None:
    now = [0.0]
    rest = RestClient("http://127.0.0.1:4900", "synthetic-probe-token")
    rest.client.headers["x-mock-slug"] = "ha"
    ha = HAAdapter(None, None, rest=rest)
    try:
        ha.status.services = capabilities(await rest.read("services"))
        provider = SpotifyPlus(ha, "media_player.synthetic", clock=lambda: now[0])
        uri = "spotify:album:0123456789ABCDEFGHIJKL"
        first = await provider.resolve(uri, "album")
        assert first.state == "fresh" and first.item is not None
        assert first.item.title == "Synthetic album"
        assert await provider.resolve(uri, "album") == first
        now[0] = 301
        limited = await provider.resolve(uri, "album")
        assert limited.error == "rate_limited" and limited.item == first.item
        assert limited.retry_after == 30
        assert (await provider.resolve(uri, "album")).error == "rate_limited"
        now[0] = 332
        missing = await provider.resolve(uri, "album")
        assert missing.error == "not_found" and missing.item == first.item
        assert missing.last_success_at == first.last_success_at
        assert missing.uri == uri and missing.state == "stale"
        print(
            "PASS: synthetic HTTP discovery, detail, cache, rate limit, "
            "backoff, not-found preservation"
        )
    finally:
        await ha.close()


if __name__ == "__main__":
    asyncio.run(main())
