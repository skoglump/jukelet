"""Exercise only an isolated local container with generated synthetic credentials."""

import argparse
import hashlib
import http.cookiejar
import json
import os
import secrets
import socket
import subprocess
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", action="store_true")
    parser.add_argument(
        "--lifecycle", action="store_true", help="Also test fixed RC upgrade/guarded restore"
    )
    args = parser.parse_args()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    # Never inspect/create the checkout's .secrets or read its implicit .env file.
    with tempfile.TemporaryDirectory(prefix="jukelet-smoke-") as directory:
        secret = secrets.token_hex(32)
        secret_file = Path(directory) / "synthetic-secret"
        secret_file.write_text(secret)
        secret_file.chmod(0o444)
        origin = f"http://localhost:{port}"
        env = os.environ | {
            "HA_URL": "",
            "HA_TOKEN": "",
            "SPOTIFYPLUS_ENTITY_ID": "",
            "APP_MODE": "read_only",
            "JUKELET_PORT": str(port),
            "JUKELET_SECRET_FILE": str(secret_file),
            "JUKELET_E2E_URL": origin,
        }
        project = "jukelet-smoke-" + secrets.token_hex(4)
        compose = [
            "docker",
            "compose",
            "-p",
            project,
            "--env-file",
            "/dev/null",
            "-f",
            "compose.yaml",
            "-f",
            "compose.dev.yaml",
        ]

        def run(*arguments: str) -> str:
            result = subprocess.run(
                [*compose, *arguments],
                cwd=ROOT,
                env=env,
                capture_output=True,
                check=False,
                text=True,
            )
            if result.returncode:
                # Only synthetic credentials are used, but never echo them even on failure.
                raise RuntimeError((result.stdout + result.stderr).replace(secret, "[redacted]"))
            return result.stdout

        jar = http.cookiejar.CookieJar()
        client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

        def request(
            method: str, path: str, data: object = None, csrf: str | None = None
        ) -> tuple[int, bytes]:
            headers = {"Origin": origin}
            body = None
            if data is not None:
                headers["Content-Type"] = "application/json"
                body = json.dumps(data).encode()
            if csrf:
                headers["X-CSRF-Token"] = csrf
            req = urllib.request.Request(origin + path, data=body, headers=headers, method=method)
            try:
                with client.open(req, timeout=10) as response:
                    return response.status, response.read()
            except urllib.error.HTTPError as error:
                return error.code, error.read()

        try:
            run("up", "-d", "--wait", "--wait-timeout", "90")
            assert request("GET", "/health/live") == (200, b'{"status":"ok"}')
            assert request("GET", "/api/v1/session")[0] == 401
            status, body = request("POST", "/api/v1/session", {"secret": secret})
            assert status == 200
            session = json.loads(body)
            assert session["mode"] == "read_only"
            run("up", "-d", "--force-recreate", "--wait", "--wait-timeout", "90")
            status, persisted = request("GET", "/api/v1/session")
            assert status == 200 and json.loads(persisted) == session
            assert request("DELETE", "/api/v1/session")[0] == 403
            assert request("DELETE", "/api/v1/session", csrf=session["csrf_token"])[0] == 204
            assert request("GET", "/api/v1/session")[0] == 401
            assert request("POST", "/api/v1/tags/example/test-playback")[0] in {
                404,
                405,
            }
            assert run("exec", "-T", "app", "id", "-u").strip() == "10001"
            scan = (
                "from pathlib import Path; "
                "s=Path('/run/secrets/app_auth_token').read_bytes().strip(); "
                "files=(p for p in Path('/app').rglob('*') if p.is_file()); "
                "assert all(s not in p.read_bytes() for p in files); "
                "assert not Path('/app/.secrets').exists()"
            )
            run("exec", "-T", "app", "python", "-c", scan)
            trust_scan = """
import hashlib
import ssl
try:
    import certifi
except ImportError:
    try:
        from pip._vendor import certifi
    except ImportError:
        certifi = None
contexts = [ssl.create_default_context()]
if certifi is not None:
    contexts.append(ssl.create_default_context(cafile=certifi.where()))
compromised = '86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b'
for context in contexts:
    assert all(hashlib.sha256(certificate).hexdigest() != compromised
               for certificate in context.get_ca_certs(binary_form=True))
"""
            for interpreter in ("python", "/usr/local/bin/python"):
                run("exec", "-T", "app", interpreter, "-c", trust_scan)
            assert secret not in run("logs", "--no-color")
            # New containers must reject bad configuration before database initialization.
            for override, expected in [
                ("APP_MODE=invalid", "APP_MODE must be read_only"),
                ("APP_RUNTIME=invalid", "APP_RUNTIME must be standalone or ingress"),
                (
                    "APP_AUTH_TOKEN_FILE=/missing-synthetic-secret",
                    "APP_AUTH_TOKEN_FILE must contain",
                ),
            ]:
                result = subprocess.run(
                    [*compose, "run", "--rm", "--no-deps", "-e", override, "app"],
                    cwd=ROOT,
                    env=env,
                    capture_output=True,
                    check=False,
                    text=True,
                    timeout=30,
                )
                assert result.returncode != 0
                assert secret not in result.stdout + result.stderr
                assert expected in result.stdout + result.stderr
            if args.browser:
                subprocess.run(
                    ["npm", "run", "test:e2e"],
                    cwd=ROOT / "frontend",
                    env=env,
                    check=True,
                )
            if args.lifecycle:
                # Fixed immutable public RC is the sole supported app upgrade origin.
                # It must already be pulled explicitly; never substitute a rolling tag.
                baseline = (
                    "ghcr.io/skoglump/jukelet@sha256:"
                    "cf34632641534b4e8e0062780211f835b885a0ccfac270837fad2a8ad2e0ce56"
                )
                candidate = env.get("JUKELET_IMAGE", "jukelet:local")
                for label, image in (("baseline", baseline), ("candidate", candidate)):
                    identity = subprocess.check_output(
                        ["docker", "image", "inspect", image, "--format", "{{.Id}}"],
                        env=env,
                        text=True,
                    ).strip()
                    print(f"{label} image: {identity}", flush=True)
                env.update(JUKELET_IMAGE=baseline, APP_MODE="manage")
                run("up", "-d", "--no-build", "--force-recreate", "--wait")
                status, body = request("POST", "/api/v1/session", {"secret": secret})
                assert status == 200 and json.loads(body)["mode"] == "manage"
                csrf = json.loads(body)["csrf_token"]
                tag = " Synthetic release upgrade:Å/😀 "
                key = hashlib.sha256(tag.encode()).hexdigest()
                assignment = {
                    "ha_tag_id": tag,
                    "input": "spotify:album:" + "A" * 22,
                    "media_type": "album",
                    "enabled": True,
                    "shuffle": False,
                    "playback_profile_id": "default",
                    "expected_version": 0,
                }
                route = f"/api/v1/tags/{key}/assignment"
                status, saved = request("PUT", route, assignment, csrf)
                assert status == 200
                identity_code = (
                    "import sqlite3; c=sqlite3.connect('/data/jukelet.db'); "
                    "print(c.execute('SELECT publisher_id FROM recovery_state').fetchone()[0])"
                )
                publisher = run("exec", "-T", "app", "python", "-c", identity_code).strip()
                env["JUKELET_IMAGE"] = candidate
                run("up", "-d", "--no-build", "--force-recreate", "--wait")
                assert request("GET", route) == (200, saved)
                assert request("GET", "/api/v1/session")[0] == 200
                assert run("exec", "-T", "app", "python", "-c", identity_code).strip() == publisher
                run(
                    "exec",
                    "-T",
                    "app",
                    "python",
                    "-m",
                    "jukelet.backup",
                    "backup",
                    "/data/jukelet.db",
                    "/data/synthetic-backup.db",
                )
                run("stop", "app")
                run(
                    "run",
                    "--rm",
                    "--no-deps",
                    "--entrypoint",
                    "python",
                    "app",
                    "-m",
                    "jukelet.backup",
                    "recover",
                    "/data/synthetic-backup.db",
                    "/data/synthetic-recovered.db",
                )
                override = Path(directory) / "recovered.yaml"
                override.write_text(
                    "services:\n  app:\n    environment:\n"
                    "      DATABASE_PATH: /data/synthetic-recovered.db\n"
                )
                compose.extend(["-f", str(override)])
                run("up", "-d", "--no-build", "--force-recreate", "--wait")
                assert request("GET", "/api/v1/session")[0] == 401
                status, body = request("POST", "/api/v1/session", {"secret": secret})
                assert status == 200
                assert request("GET", route) == (200, saved)
                guard_code = (
                    "import sqlite3; c=sqlite3.connect('/data/synthetic-recovered.db'); "
                    "assert c.execute('PRAGMA integrity_check').fetchone()==('ok',); "
                    "assert c.execute('SELECT reconciliation_required FROM recovery_state')"
                    ".fetchone()==(1,); "
                    "assert c.execute('SELECT automatic_enabled,healthy FROM publication_state')"
                    ".fetchone()==(0,0); "
                    "assert c.execute('SELECT publisher_id FROM recovery_state').fetchone()[0]"
                    f"=={publisher!r}"
                )
                run("exec", "-T", "app", "python", "-c", guard_code)
                print(
                    "PASS fixed RC -> candidate app upgrade: exact assignment/session/identity; "
                    "SQLite online backup/offline guarded recovery: assignment/identity retained, "
                    "sessions invalidated, publication fenced, automatic suspended. "
                    "No HA configured.",
                    flush=True,
                )
            # The production server must preserve its actual peer even when a caller
            # on trusted loopback supplies forged proxy/user metadata. This is direct
            # access refusal, not a real Supervisor authorization demonstration.
            ingress_override = Path(directory) / "ingress-direct-check.yaml"
            ingress_override.write_text(
                "services:\n  app:\n    environment:\n      APP_RUNTIME: ingress\n"
            )
            compose.extend(["-f", str(ingress_override)])
            run("up", "-d", "--no-build", "--force-recreate", "--wait")
            assert request("GET", "/health/live") == (200, b'{"status":"ok"}')
            assert request("GET", "/api/v1/session")[0] == 403
            direct_check = f"""
import urllib.request
import urllib.error
headers = {{
    'Host': 'localhost:{port}',
    'Origin': {origin!r},
    'X-Forwarded-For': '172.30.32.2',
    'X-Real-IP': '172.30.32.2',
    'X-Forwarded-Host': 'localhost:{port}',
    'X-Forwarded-Proto': 'https',
    'X-Ingress-Path': '/api/hassio_ingress/synthetic-direct-token',
    'X-Remote-User-Id': 'a' * 32,
    'X-Remote-User-Groups': 'system-admin',
}}
for method, path in [
    ('GET', '/'), ('GET', '/api/v1/session'), ('GET', '/api/v1/tags'),
    ('POST', '/api/v1/session'), ('POST', '/api/v1/publication/confirm'),
]:
    req = urllib.request.Request('http://127.0.0.1:8000' + path,
                                 headers=headers, method=method)
    try:
        urllib.request.urlopen(req, timeout=5)
    except urllib.error.HTTPError as error:
        assert error.code == 403, (method, path, error.code)
        assert error.read() == b'{{"detail":"Ingress access denied"}}'
        assert error.headers.get('Set-Cookie') is None
    else:
        raise AssertionError('Direct request trusted forged proxy metadata')
"""
            run("exec", "-T", "app", "python", "-c", direct_check)
            assert secret not in run("logs", "--no-color")
            print(
                "PASS: HTTP health/auth, CSRF, container replacement persistence, non-root runtime,"
            )
            print(
                "      secret isolation, missing-secret/mode/runtime rejection, optional browser,"
            )
            print("      and Ingress direct-port/forged-peer refusal by the production server.")
        finally:
            run("down", "--volumes", "--remove-orphans")


if __name__ == "__main__":
    main()
