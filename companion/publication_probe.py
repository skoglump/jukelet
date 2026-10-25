"""Opt-in app HTTP -> actual HA WebSocket/Store publication and recovery proof.

Run in the pinned HA environment after make bootstrap. No target, credentials or
configuration arguments are accepted. All state and credentials are generated in
owned temporary directories; dispatch remains disabled, no scripts are loaded.
"""

import asyncio
import hashlib
import os
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import aiohttp

from companion.custom_components.jukelet_bridge.protocol import PUBLISHER
from companion.probe_support import probe_ha_version
from companion.runtime_probe import Runtime

ROOT = Path(__file__).resolve().parents[1]
APP_PYTHON = ROOT / "backend/.venv/bin/python"
TAG = " Synthetic publication:Å/😀 "
URI = "spotify:album:" + "A" * 22


def free_port() -> int:
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        return int(reservation.getsockname()[1])


class App:
    def __init__(self, directory: Path, ha_port: int, token: str, port: int) -> None:
        self.directory, self.port = directory, port
        self.origin = f"http://127.0.0.1:{port}"
        # Start from a small known environment, never inherit live integration settings.
        env = {
            key: value
            for key, value in os.environ.items()
            if key in {"PATH", "LANG", "LC_ALL", "TZ"}
        }
        self.env = {
            **env,
            "APP_PUBLIC_ORIGIN": self.origin,
            "APP_ALLOW_INSECURE_HTTP": "true",
            "APP_MODE": "manage",
            "DATABASE_PATH": str(directory / "app.db"),
            "APP_AUTH_TOKEN_FILE": str(directory / "app-secret"),
            "APP_STATIC_DIR": str(directory / "no-assets"),
            "HA_URL": f"http://127.0.0.1:{ha_port}",
            "HA_TOKEN": token,
        }
        self.log = (directory / "app.log").open("ab")
        self.process = subprocess.Popen(
            [
                str(APP_PYTHON),
                "-m",
                "uvicorn",
                "jukelet.main:create_app",
                "--factory",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--no-access-log",
            ],
            env=self.env,
            stdout=self.log,
            stderr=self.log,
        )

    def close(self, *, crash: bool = False) -> None:
        if self.process.poll() is None:
            self.process.kill() if crash else self.process.terminate()
            self.process.wait(15)
        self.log.close()


class Client:
    def __init__(self, app: App, secret: str) -> None:
        self.app, self.secret = app, secret
        self.http = aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True))
        self.headers: dict[str, str] = {"Origin": app.origin}

    async def request(self, method: str, path: str, body: object | None = None) -> Any:
        async with self.http.request(
            method, self.app.origin + "/api/v1/" + path, json=body, headers=self.headers
        ) as response:
            value = await response.json()
            assert response.status == 200, (path, response.status, value)
            return value

    async def login(self) -> None:
        async with asyncio.timeout(20):
            while True:
                try:
                    value = await self.request("POST", "session", {"secret": self.secret})
                    self.headers["X-CSRF-Token"] = value["csrf_token"]
                    return
                except aiohttp.ClientConnectionError:
                    await asyncio.sleep(0.05)

    async def status(self, *, verified: bool = False, guard: bool = False) -> dict[str, Any]:
        async with asyncio.timeout(35):
            while True:
                status: dict[str, Any] = await self.request("GET", "publication")
                if status["actual"]:
                    assert status["actual"]["dispatch_enabled"] is False
                if (
                    (not verified or status["verified"])
                    and (not guard or status["reconciliation_required"])
                    and not status["actual_stale"]
                ):
                    assert status["playback_verified"] is None
                    return status
                await asyncio.sleep(0.1)

    async def save(self, version: int, suffix: str = "A") -> None:
        await self.request(
            "PUT",
            f"tags/{hashlib.sha256(TAG.encode()).hexdigest()}/assignment",
            {
                "ha_tag_id": TAG,
                "input": "spotify:album:" + suffix * 22,
                "media_type": "album",
                "enabled": True,
                "shuffle": False,
                "playback_profile_id": "default",
                "expected_version": version,
            },
        )

    async def publish(self, action: str = "publish") -> None:
        review = await self.request("POST", "publication/review", {"action": action})
        await self.request(
            "POST",
            "publication/confirm",
            {
                "review_token": review["review_token"],
                "confirmed": True,
                "confirm_empty": review["empty"],
                "migration_attested": action == "activate",
            },
        )

    async def close(self) -> None:
        await self.http.close()


def app_command(*args: str) -> None:
    subprocess.run([str(APP_PYTHON), *args], check=True, cwd=ROOT, stdout=subprocess.DEVNULL)


def app_token(runtime: Runtime) -> str:
    runtime.pipe.send({"type": "app_connection"})
    return str(runtime.receive()["token"])


async def run(directory: Path) -> None:
    ha_dir, app_dir = directory / "ha", directory / "app"
    ha_dir.mkdir()
    app_dir.mkdir()
    (ha_dir / "configuration.yaml").write_text("homeassistant: {}\n")
    shutil.copytree(ROOT / "companion/custom_components", ha_dir / "custom_components")
    secret = secrets.token_urlsafe(40)
    (app_dir / "app-secret").write_text(secret)
    (app_dir / "app-secret").chmod(0o600)
    database = app_dir / "app.db"
    # Migrate generated empty app state, then pair the fixture's known synthetic UUID.
    # This is not a production identity-changing tool or recovery procedure.
    app_command(
        "-c",
        "from pathlib import Path; from jukelet.storage import open_database,migrate; import sys; "
        "e=open_database(Path(sys.argv[1])); migrate(e); e.dispose()",
        str(database),
    )
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE recovery_state SET publisher_id=?", (PUBLISHER,))
    ha_port, app_port = free_port(), free_port()
    runtime = Runtime(ha_dir, ha_port)
    app: App | None = None
    client: Client | None = None
    try:
        app = App(app_dir, ha_port, app_token(runtime), app_port)
        client = Client(app, secret)
        await client.login()
        await client.status()
        await client.save(0)
        assert (await client.status())["jobs"] == []
        await client.publish()
        assert (await client.status(verified=True))["active_revision"] == 1
        backup = app_dir / "app-backup.db"
        app_command("-m", "jukelet.backup", "backup", str(database), str(backup))
        password = secrets.token_urlsafe(32)
        runtime.pipe.send({"type": "backup_full", "password": password})
        backup_id = runtime.receive()["backup_id"]
        print(
            "PASS app HTTP -> actual HA adapter publication/readback; initial save never publishes"
        )

        runtime.pipe.send({"type": "delay_app_ack"})
        assert runtime.receive()["delayed_ack_installed"]
        await client.save(1, "B")
        await client.publish()
        async with asyncio.timeout(10):
            while runtime.request("status")["result"]["active_revision"] != 2:
                await asyncio.sleep(0.05)
        await client.save(2, "C")
        status = await client.status()
        assert status["active_revision"] == 2 and status["active_desired_version"] == 2
        assert status["desired_version"] == 3 and not status["verified"]
        await client.publish()
        assert (await client.status(verified=True))["active_revision"] == 3
        print(
            "PASS actual HA delayed/lost app response: actual readback reconciles; concurrent "
            "edit stays pending"
        )

        await client.publish("activate")
        await client.close()
        app.close()
        runtime.close(crash=True)
        runtime = Runtime(ha_dir, ha_port)
        app = App(app_dir, ha_port, app_token(runtime), app_port)
        client = Client(app, secret)
        await client.login()
        status = await client.status(verified=True)
        assert status["automatic_enabled"] and status["active_revision"] == 3
        await client.save(3, "D")
        assert (await client.status(verified=True))["active_revision"] == 4
        print(
            "PASS actual HA process SIGKILL/restart and app restart: activation persists, actual "
            "identity gates automatic later save"
        )

        await client.close()
        app.close()
        database.rename(app_dir / "advanced-app.db")
        app_command("-m", "jukelet.backup", "recover", str(backup), str(database))
        app = App(app_dir, ha_port, app_token(runtime), app_port)
        client = Client(app, secret)
        await client.login()
        status = await client.status(guard=True)
        assert not status["automatic_enabled"] and status["actual"]["active_revision"] == 4
        await client.publish("recover")
        assert (await client.status(verified=True))["active_revision"] == 5
        print(
            "PASS app-only restore against newer actual HA: durable guard, explicit reviewed "
            "recovery revision5"
        )

        await client.close()
        app.close()
        runtime.pipe.send({"type": "restore_full", "backup_id": backup_id, "password": password})
        assert runtime.receive() == {"restart_for_restore": True}
        runtime.process.join(10)
        assert runtime.process.exitcode == 0
        runtime = Runtime(ha_dir, ha_port)
        assert runtime.ready["restored"] is True
        assert runtime.request("status")["result"]["active_revision"] == 1
        app = App(app_dir, ha_port, app_token(runtime), app_port)
        client = Client(app, secret)
        await client.login()
        status = await client.status(guard=True)
        assert status["high_water"] == 5 and status["actual"]["active_revision"] == 1
        await client.publish("recover")
        status = await client.status(verified=True)
        assert status["active_revision"] == 6 and not status["automatic_enabled"]
        print(
            "PASS actual coherent Core HA backup/restore against newer app: mismatch fenced, "
            "reviewed recovery revision6; no revision rewind"
        )
        runtime.pipe.send({"type": "delay_app_ack"})
        assert runtime.receive()["delayed_ack_installed"]
        await client.save(1, "E")
        await client.publish()
        async with asyncio.timeout(10):
            while runtime.request("status")["result"]["active_revision"] != 7:
                await asyncio.sleep(0.05)
        # Kill the app before its response deadline/readback. The persisted in-flight
        # envelope survives; restart must reconcile status rather than send new content.
        app.close(crash=True)
        await client.close()
        app = App(app_dir, ha_port, app_token(runtime), app_port)
        client = Client(app, secret)
        await client.login()
        status = await client.status(verified=True)
        assert status["active_revision"] == 7 and status["jobs"][0]["state"] == "verified"
        print(
            "PASS app SIGKILL during lost acknowledgment: durable immutable in-flight job "
            "reconciled on restart"
        )

        runtime.pipe.send({"type": "remove_snapshot"})
        assert runtime.receive() == {"removed": True}
        runtime.pipe.send({"type": "reload"})
        assert runtime.receive() == {"reloaded": True}
        status = await client.status(guard=True)
        assert status["actual"]["persistence"] == "degraded"
        async with client.http.post(
            app.origin + "/api/v1/publication/review",
            json={"action": "recover"},
            headers=client.headers,
        ) as response:
            assert response.status == 409
            assert (await response.json())["detail"]["code"] == "operator_ha_recovery_required"
        # Only the HA operator flow can consult retained history for degraded state.
        # Input comes from this fixture's own last immutable app job, not a live store.
        with sqlite3.connect(database) as connection:
            import json

            envelope = json.loads(
                connection.execute(
                    "SELECT envelope FROM publication_job ORDER BY revision DESC LIMIT 1"
                ).fetchone()[0]
            )
        envelope.update(revision=8, expected_active_revision=None)
        runtime.pipe.send({"type": "recover", "snapshot": envelope})
        assert runtime.receive() == {"flow_type": "create_entry"}
        status = await client.status(guard=True)
        assert status["actual"]["active_revision"] == 8 and status["reconciliation_required"]
        await client.publish("recover")
        assert (await client.status(verified=True))["active_revision"] == 9
        print(
            "PASS real HA degraded snapshot: app fenced; HA operator recovery alone retains app "
            "guard; reviewed app recovery revision9"
        )
        print(
            "PASS all publication scenarios: dispatch disabled, no playback/scan/script/Spotify "
            "integrations"
        )
    finally:
        if client:
            await client.close()
        if app:
            app.close()
        runtime.close()


def main() -> None:
    assert len(sys.argv) == 1, "No target/config/credential arguments are accepted"
    probe_ha_version()
    assert APP_PYTHON.is_file(), "Run make bootstrap with the pinned app tools first"
    with tempfile.TemporaryDirectory(prefix="jukelet-app-publication-") as temporary:
        asyncio.run(run(Path(temporary)))


if __name__ == "__main__":
    main()
