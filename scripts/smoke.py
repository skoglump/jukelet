"""Exercise only an isolated local container with generated synthetic credentials."""

import argparse
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
    args = parser.parse_args()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    secret_parent = ROOT / ".secrets"
    secret_parent.mkdir(mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="smoke-", dir=secret_parent) as directory:
        secret = secrets.token_hex(32)
        secret_file = Path(directory) / "synthetic-secret"
        secret_file.write_text(secret)
        secret_file.chmod(0o444)
        origin = f"http://localhost:{port}"
        env = os.environ | {
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
            assert secret not in run("logs", "--no-color")
            # New containers must reject bad configuration before database initialization.
            for override in [
                "APP_MODE=manage",
                "APP_AUTH_TOKEN_FILE=/missing-synthetic-secret",
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
                expected = (
                    "APP_MODE must be read_only"
                    if "APP_MODE" in override
                    else "APP_AUTH_TOKEN_FILE must contain"
                )
                assert expected in result.stdout + result.stderr
            if args.browser:
                subprocess.run(
                    ["npm", "run", "test:e2e"],
                    cwd=ROOT / "frontend",
                    env=env,
                    check=True,
                )
            print(
                "PASS: HTTP health/auth, CSRF, container replacement persistence, non-root runtime,"
            )
            print(
                "      secret isolation, missing-secret/mode rejection, and optional browser smoke."
            )
        finally:
            run("down", "--volumes", "--remove-orphans")


if __name__ == "__main__":
    main()
