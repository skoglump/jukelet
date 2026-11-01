"""Synthetic add-on options/private state only; no Supervisor or household access."""

import json
import os
import sys
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from jukelet import addon
from jukelet.addon import execute, prepare, read_options
from jukelet.config import Settings


def write_options(tmp_path: Path, **values: object) -> Path:
    path = tmp_path / "options.json"
    path.write_text(json.dumps({"public_origin": "https://ha.example", **values}))
    return path


def fixture_prepare(tmp_path: Path, **values: object) -> dict[str, str]:
    return prepare(
        write_options(tmp_path, **values),
        tmp_path,
        {"SUPERVISOR_TOKEN": "synthetic-supervisor-private"},
        owner=(os.getuid(), os.getgid()),
    )


@pytest.mark.parametrize("option", ["token", "prefix", "command", "environment"])
def test_options_reject_unknown_controls_without_exposing_values(
    tmp_path: Path, option: str
) -> None:
    path = tmp_path / "options.json"
    private = "SYNTHETIC_PRIVATE_VALUE"
    path.write_text(json.dumps({"public_origin": "https://ha.example", option: private}))
    with pytest.raises(ValueError, match="Unsupported add-on option") as error:
        read_options(path)
    assert private not in str(error.value)


@pytest.mark.parametrize(
    "options",
    [
        {},
        {"public_origin": None},
        {"public_origin": "http://127.0.0.1"},
        {"public_origin": "https://ha.example", "mode": True},
        {"public_origin": "https://ha.example", "mode": "automatic"},
        {"public_origin": "https://ha.example", "mode": []},
        {"public_origin": "https://ha.example", "mode": {}},
        {"public_origin": "https://ha.example", "additional_origins": "https://remote.example"},
        {"public_origin": "https://ha.example", "additional_origins": [False]},
        {"public_origin": "https://ha.example", "spotifyplus_entity_id": False},
    ],
)
def test_options_reject_unsafe_shapes_and_non_https_origins(
    tmp_path: Path, options: object
) -> None:
    path = tmp_path / "options.json"
    path.write_text(json.dumps(options))
    with pytest.raises(ValueError):
        read_options(path)


def test_startup_selects_ingress_supervisor_and_read_only_without_inference(tmp_path: Path) -> None:
    options = tmp_path / "options.json"
    options.write_text('{"public_origin":"https://ha.example"}')
    environment = prepare(
        options,
        tmp_path,
        {
            "SUPERVISOR_TOKEN": "synthetic-supervisor-private",
            "APP_RUNTIME": "standalone",
            "HA_TRANSPORT": "direct",
            "APP_MODE": "manage",
        },
        owner=(os.getuid(), os.getgid()),
    )
    configured = Settings.load(environment)
    assert (configured.runtime, configured.ha_transport, configured.mode) == (
        "ingress",
        "supervisor",
        "read_only",
    )


def test_startup_maps_only_explicit_production_choices(tmp_path: Path) -> None:
    configured = Settings.load(
        fixture_prepare(
            tmp_path,
            mode="manage",
            additional_origins=["https://remote.example:8443"],
            spotifyplus_entity_id="media_player.synthetic_fixture",
        )
    )
    assert configured.mode == "manage"
    assert configured.allowed_origins == ("https://ha.example", "https://remote.example:8443")
    assert configured.spotifyplus_entity_id == "media_player.synthetic_fixture"


def test_startup_ignores_inherited_optional_settings(tmp_path: Path) -> None:
    environment = prepare(
        write_options(tmp_path),
        tmp_path,
        {
            "SUPERVISOR_TOKEN": "synthetic-supervisor-private",
            "APP_ALLOW_INSECURE_HTTP": "true",
            "APP_INGRESS_ORIGINS": "https://unconfigured.example",
            "SPOTIFYPLUS_ENTITY_ID": "media_player.unconfigured",
            "APP_AUTH_TOKEN_FILE": "/wrong/key",
            "DATABASE_PATH": "/wrong/database",
            "APP_STATIC_DIR": "/wrong/frontend",
            "JUKELET_SUPERVISOR_CONTINUITY": "false",
        },
        owner=(os.getuid(), os.getgid()),
    )
    configured = Settings.load(environment)
    assert configured.allowed_origins == ("https://ha.example",)
    assert configured.spotifyplus_entity_id is None
    assert environment["APP_ALLOW_INSECURE_HTTP"] == "false"
    assert configured.database_path == tmp_path / "jukelet/jukelet.db"
    assert configured.static_dir == Path("/app/frontend")
    assert environment["APP_AUTH_TOKEN_FILE"] == str(tmp_path / "jukelet/auth-secret")
    assert configured.supervisor_continuity
    assert environment["JUKELET_SUPERVISOR_CONTINUITY"] == "required"


@pytest.mark.parametrize(
    "values",
    [
        {"public_origin": "https://ha.example/private"},
        {"public_origin": "https://private@ha.example"},
        {"additional_origins": ["https://ha.example"]},
        {"additional_origins": ["https://remote.example/private"]},
        {"spotifyplus_entity_id": "script.synthetic_private"},
    ],
)
def test_settings_remain_authoritative_for_exact_origins_and_entity(
    tmp_path: Path, values: dict[str, object]
) -> None:
    with pytest.raises(ValueError):
        fixture_prepare(tmp_path, **values)


@pytest.mark.parametrize(
    "credentials",
    [
        {},
        {"SUPERVISOR_TOKEN": "bad token"},
        {"SUPERVISOR_TOKEN": "synthetic-private", "HA_URL": "http://direct.example"},
        {"SUPERVISOR_TOKEN": "synthetic-private", "HA_TOKEN": "direct-private"},
    ],
)
def test_startup_does_not_hide_missing_or_conflicting_credentials(
    tmp_path: Path, credentials: dict[str, str]
) -> None:
    with pytest.raises(ValueError) as error:
        prepare(
            write_options(tmp_path),
            tmp_path,
            credentials,
            owner=(os.getuid(), os.getgid()),
        )
    assert not any(value in str(error.value) for value in credentials.values())


def test_additional_origin_cannot_smuggle_multiple_list_entries(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        fixture_prepare(tmp_path, additional_origins=["https://one.example,https://two.example"])


def test_startup_rejects_symlink_private_directory_without_writing_outside(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (tmp_path / "jukelet").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError):
        fixture_prepare(tmp_path)
    assert list(outside.iterdir()) == []


@pytest.mark.parametrize(
    "name", ["auth-secret", "jukelet.db", "jukelet.db-wal", "jukelet.db-shm", "jukelet.db-journal"]
)
def test_startup_rejects_symlink_state_files_without_touching_target(
    tmp_path: Path, name: str
) -> None:
    state = tmp_path / "jukelet"
    state.mkdir(mode=0o700)
    outside = tmp_path / "outside"
    contents = b"synthetic-private-value" * 3
    outside.write_bytes(contents)
    (state / name).symlink_to(outside)
    with pytest.raises(ValueError):
        fixture_prepare(tmp_path)
    assert outside.read_bytes() == contents


@pytest.mark.parametrize("mode", [0o755, 0o770])
def test_startup_rejects_unsafe_existing_private_directory(tmp_path: Path, mode: int) -> None:
    state = tmp_path / "jukelet"
    state.mkdir(mode=mode)
    state.chmod(mode)
    with pytest.raises(ValueError):
        fixture_prepare(tmp_path)
    assert state.stat().st_mode & 0o777 == mode


def test_interrupted_secret_write_cannot_publish_partial_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_write = os.write
    written = False

    def interrupted_write(descriptor: int, contents: bytes) -> int:
        nonlocal written
        if written:
            raise OSError("synthetic-write-failure")
        written = True
        return real_write(descriptor, contents[:7])

    monkeypatch.setattr(os, "write", interrupted_write)
    with pytest.raises(ValueError):
        fixture_prepare(tmp_path)
    assert list((tmp_path / "jukelet").iterdir()) == []


def test_startup_preserves_database_secret_options_and_unrelated_data(tmp_path: Path) -> None:
    options = write_options(tmp_path)
    options.chmod(0o640)
    options_before = options.stat()
    options_bytes = options.read_bytes()
    state = tmp_path / "jukelet"
    state.mkdir(mode=0o700)
    secret = state / "auth-secret"
    secret_bytes = b"existing-synthetic-auth-key-123456789\n"
    secret.write_bytes(secret_bytes)
    secret.chmod(0o600)
    database = state / "jukelet.db"
    database_bytes = b"synthetic existing database bytes; startup must not open SQLite"
    database.write_bytes(database_bytes)
    database.chmod(0o600)
    unrelated = tmp_path / "supervisor-owned-unrelated"
    unrelated.write_text("preserve")
    for _ in range(2):
        environment = prepare(
            options,
            tmp_path,
            {"SUPERVISOR_TOKEN": "synthetic-supervisor-private"},
            owner=(os.getuid(), os.getgid()),
        )
        assert Settings.load(environment).auth_secret == secret_bytes.rstrip(b"\n")
    assert database.read_bytes() == database_bytes
    assert secret.read_bytes() == secret_bytes
    assert options.read_bytes() == options_bytes
    options_after = options.stat()
    assert (
        options_after.st_mode,
        options_after.st_uid,
        options_after.st_gid,
        options_after.st_mtime_ns,
    ) == (
        options_before.st_mode,
        options_before.st_uid,
        options_before.st_gid,
        options_before.st_mtime_ns,
    )
    assert unrelated.read_text() == "preserve"


def test_concurrent_preparation_publishes_one_complete_private_key(tmp_path: Path) -> None:
    options = write_options(tmp_path)

    def initialize(_: int) -> bytes:
        environment = prepare(
            options,
            tmp_path,
            {"SUPERVISOR_TOKEN": "synthetic-supervisor-private"},
            owner=(os.getuid(), os.getgid()),
        )
        return Settings.load(environment).auth_secret

    with ThreadPoolExecutor(max_workers=8) as pool:
        keys = list(pool.map(initialize, range(16)))
    assert len(set(keys)) == 1
    key = keys[0]
    assert len(key) == 64 and key.isascii()
    state = tmp_path / "jukelet"
    assert {path.name for path in state.iterdir()} == {"auth-secret"}
    for path, mode in [(state, 0o700), (state / "auth-secret", 0o600)]:
        metadata = path.stat()
        assert metadata.st_mode & 0o777 == mode
        assert (metadata.st_uid, metadata.st_gid) == (os.getuid(), os.getgid())


@pytest.mark.parametrize("contents", [b"short", b"\xff" * 64, b"x" * 131])
def test_invalid_existing_secret_is_rejected_without_replacement(
    tmp_path: Path, contents: bytes
) -> None:
    state = tmp_path / "jukelet"
    state.mkdir(mode=0o700)
    secret = state / "auth-secret"
    secret.write_bytes(contents)
    secret.chmod(0o600)
    with pytest.raises(ValueError, match="ASCII secret"):
        fixture_prepare(tmp_path)
    assert secret.read_bytes() == contents


@pytest.mark.parametrize("name", ["auth-secret", "jukelet.db"])
def test_unsafe_existing_file_permissions_are_rejected_without_repair(
    tmp_path: Path, name: str
) -> None:
    state = tmp_path / "jukelet"
    state.mkdir(mode=0o700)
    path = state / name
    contents = b"synthetic-valid-key-but-readable-by-others"
    path.write_bytes(contents)
    path.chmod(0o644)
    with pytest.raises(ValueError, match="Unsafe private"):
        fixture_prepare(tmp_path)
    assert path.read_bytes() == contents
    assert path.stat().st_mode & 0o777 == 0o644


def test_existing_state_owner_mismatch_is_not_adopted(tmp_path: Path) -> None:
    state = tmp_path / "jukelet"
    state.mkdir(mode=0o700)
    with pytest.raises(ValueError, match="Unsafe private"):
        prepare(
            write_options(tmp_path),
            tmp_path,
            {"SUPERVISOR_TOKEN": "synthetic-supervisor-private"},
            owner=(os.getuid() + 1, os.getgid()),
        )
    assert state.stat().st_uid == os.getuid()
    assert list(state.iterdir()) == []


@pytest.mark.parametrize("name", ["jukelet.db", ".supervisor-continuity", "jukelet.db-wal"])
def test_retained_state_without_key_never_regenerates_one(tmp_path: Path, name: str) -> None:
    state = tmp_path / "jukelet"
    state.mkdir(mode=0o700)
    retained = state / name
    retained.write_bytes(b"synthetic-retained-state")
    retained.chmod(0o600)
    with pytest.raises(ValueError, match="missing"):
        fixture_prepare(tmp_path)
    assert not (state / "auth-secret").exists()
    assert retained.read_bytes() == b"synthetic-retained-state"


def test_hardlinked_key_cannot_establish_private_state(tmp_path: Path) -> None:
    state = tmp_path / "jukelet"
    state.mkdir(mode=0o700)
    external = tmp_path / "external"
    external.write_bytes(b"synthetic-valid-private-auth-key-123456789")
    external.chmod(0o600)
    os.link(external, state / "auth-secret")
    with pytest.raises(ValueError, match="hard links"):
        fixture_prepare(tmp_path)
    assert external.stat().st_nlink == 2


@pytest.mark.parametrize("value", ["false", "true", "yes", "required "])
def test_internal_continuity_requirement_has_no_disable_value(tmp_path: Path, value: str) -> None:
    environment = fixture_prepare(tmp_path)
    environment["JUKELET_SUPERVISOR_CONTINUITY"] = value
    with pytest.raises(ValueError, match="internal Supervisor"):
        Settings.load(environment)


def test_startup_rejects_hardlinked_database_without_changing_external_bytes(
    tmp_path: Path,
) -> None:
    state = tmp_path / "jukelet"
    state.mkdir(mode=0o700)
    outside = tmp_path / "external-database"
    outside.write_bytes(b"synthetic-external-database")
    outside.chmod(0o600)
    os.link(outside, state / "jukelet.db")
    with pytest.raises(ValueError, match="hard links"):
        fixture_prepare(tmp_path)
    assert outside.read_bytes() == b"synthetic-external-database"


@pytest.mark.parametrize(
    "contents",
    [
        b"[",
        b"[]",
        b"null",
        b"\xff",
        b"{}" + b" " * 16384,
        b'{"public_origin":"https://ha.example","mode":"manage","mode":"read_only"}',
    ],
)
def test_options_reject_invalid_duplicate_or_unbounded_json(
    tmp_path: Path, contents: bytes
) -> None:
    path = tmp_path / "options.json"
    path.write_bytes(contents)
    with pytest.raises(ValueError):
        read_options(path)


@pytest.mark.parametrize("kind", ["missing", "directory", "symlink", "fifo"])
def test_options_require_regular_no_follow_file(tmp_path: Path, kind: str) -> None:
    path = tmp_path / "options.json"
    if kind == "directory":
        path.mkdir()
    elif kind == "symlink":
        target = tmp_path / "target"
        target.write_text('{"public_origin":"https://ha.example"}')
        path.symlink_to(target)
    elif kind == "fifo":
        os.mkfifo(path)
    with pytest.raises(ValueError):
        read_options(path)


def test_exec_uses_fixed_single_server_after_dropping_all_identity_privileges(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class ReplacedProcess(Exception):
        pass

    identity: dict[str, object] = {"uid": 0, "gid": 0, "groups": [0, 42], "umask": 0o022}

    def set_umask(mask: int) -> int:
        identity["umask"] = mask
        return 0o022

    def clear_groups(groups: list[int]) -> None:
        assert identity["uid"] == 0
        identity["groups"] = groups

    def set_gid(gid: int) -> None:
        assert identity["uid"] == 0
        identity["gid"] = gid

    def set_uid(uid: int) -> None:
        assert identity["groups"] == [] and identity["gid"] == 10001
        identity["uid"] = uid

    environment = {"SUPERVISOR_TOKEN": "synthetic-private", "UVICORN_WORKERS": "99"}

    def replace(path: str, arguments: list[str], received: Mapping[str, str]) -> None:
        assert identity == {"uid": 10001, "gid": 10001, "groups": [], "umask": 0o077}
        assert path == sys.executable
        assert arguments == [
            sys.executable,
            "-m",
            "uvicorn",
            "jukelet.main:create_app",
            "--factory",
            "--host",
            "0.0.0.0",
            "--port",
            "8000",
            "--workers",
            "1",
            "--no-access-log",
            "--no-proxy-headers",
        ]
        assert received == environment
        raise ReplacedProcess

    monkeypatch.setattr(os, "umask", set_umask)
    monkeypatch.setattr(os, "setgroups", clear_groups)
    monkeypatch.setattr(os, "setgid", set_gid)
    monkeypatch.setattr(os, "setuid", set_uid)
    monkeypatch.setattr(os, "execve", replace)
    with pytest.raises(ReplacedProcess):
        execute(environment)


def test_invalid_startup_exits_redacted_without_exec(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    private = "SYNTHETIC-PRIVATE-OPTIONS-VALUE"
    options = write_options(tmp_path, command=private)
    monkeypatch.setattr(addon, "OPTIONS_PATH", options)
    monkeypatch.setattr(addon, "DATA_ROOT", tmp_path)
    monkeypatch.setenv("SUPERVISOR_TOKEN", "SYNTHETIC-PRIVATE-SUPERVISOR-TOKEN")
    assert addon.main() == 1
    output = capsys.readouterr()
    assert output.out == ""
    assert "startup failed" in output.err
    assert private not in output.err
    assert "SYNTHETIC-PRIVATE-SUPERVISOR-TOKEN" not in output.err
