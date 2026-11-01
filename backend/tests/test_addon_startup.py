"""Synthetic add-on options/private state only; no Supervisor or household access."""

import json
import os
import sys
import threading
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from pathlib import Path
from typing import Any

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


class NativeOwnershipModel:
    """Virtual numeric owners over real FDs/modes/inodes; never actual root proof."""

    def __init__(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, populated: bool = False
    ) -> None:
        self.state = tmp_path / "jukelet"
        self.state.mkdir(mode=0o700)
        self.database = self.state / "jukelet.db"
        if populated:
            from scripts.probe_database_transfer import seed

            seed(self.database)
        else:
            self.database.write_bytes(b"synthetic opaque database; bootstrap must not open SQLite")
        self.key = self.state / "auth-secret"
        self.key.write_bytes(b"synthetic-retained-private-key-12345678901234567890")
        for path in (self.database, self.key):
            path.chmod(0o644)
        self.real_stat, self.real_fstat, self.real_chown = os.stat, os.fstat, os.fchown
        self.owners = {
            (value.st_dev, value.st_ino): (0, 0)
            for value in (self.real_stat(path) for path in (self.state, self.database, self.key))
        }
        self.changed: list[tuple[int, int]] = []
        monkeypatch.setattr(os, "stat", self.stat)
        monkeypatch.setattr(os, "fstat", self.fstat)
        monkeypatch.setattr(os, "fchown", self.chown)
        monkeypatch.setattr(os, "geteuid", lambda: 0)

    def mark(self, path: Path, owner: tuple[int, int] = (0, 0)) -> None:
        metadata = self.real_stat(path, follow_symlinks=False)
        self.owners[(metadata.st_dev, metadata.st_ino)] = owner

    def owned(self, value: os.stat_result) -> os.stat_result:
        owner = self.owners.get((value.st_dev, value.st_ino))
        if owner is None:
            return value
        fields = list(value)
        fields[4], fields[5] = owner
        return os.stat_result(
            fields,
            {
                "st_atime_ns": value.st_atime_ns,
                "st_mtime_ns": value.st_mtime_ns,
                "st_ctime_ns": value.st_ctime_ns,
            },
        )

    def stat(self, *args: Any, **kwargs: Any) -> os.stat_result:
        return self.owned(self.real_stat(*args, **kwargs))

    def fstat(self, descriptor: int) -> os.stat_result:
        return self.owned(self.real_fstat(descriptor))

    def chown(self, descriptor: int, uid: int, gid: int) -> None:
        value = self.real_fstat(descriptor)
        identity = value.st_dev, value.st_ino
        if identity in self.owners:
            self.changed.append(identity)
            self.owners[identity] = (uid, gid)
        else:
            self.real_chown(descriptor, uid, gid)

    def prepare(self, tmp_path: Path) -> dict[str, str]:
        return prepare(
            write_options(tmp_path),
            tmp_path,
            {"SUPERVISOR_TOKEN": "synthetic-supervisor-private"},
            owner=addon.SERVICE_ID,
        )


def test_native_root_owned_private_restore_is_normalized_without_changing_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    restored = NativeOwnershipModel(tmp_path, monkeypatch)
    before = restored.database.read_bytes(), restored.key.read_bytes()
    environment = restored.prepare(tmp_path)
    assert Settings.load(environment).auth_secret == before[1]
    assert (restored.database.read_bytes(), restored.key.read_bytes()) == before
    for path, mode in ((restored.state, 0o700), (restored.database, 0o600), (restored.key, 0o600)):
        metadata = path.stat()
        assert (metadata.st_uid, metadata.st_gid) == addon.SERVICE_ID
        assert metadata.st_mode & 0o777 == mode
    assert {path.name for path in restored.state.iterdir()} == {"jukelet.db", "auth-secret"}
    assert environment["JUKELET_SUPERVISOR_CONTINUITY"] == "required"


@pytest.mark.parametrize(
    "damage",
    [
        "directory_mode",
        "directory_group",
        "foreign_owner",
        "root_wrong_group",
        "service_weak_file",
        "writable_file",
        "special_bits",
        "hardlink",
        "symlink",
        "directory_file",
        "fifo",
        "marker",
        "unknown_entry",
        "missing_key",
        "missing_db",
        "short_key",
        "oversize_key",
        "binary_key",
        "late_bad_sidecar",
        "service_parent_root_files",
    ],
)
def test_native_normalization_validates_all_state_before_any_metadata_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, damage: str
) -> None:
    restored = NativeOwnershipModel(tmp_path, monkeypatch)
    if damage == "directory_mode":
        restored.state.chmod(0o755)
    elif damage == "directory_group":
        restored.mark(restored.state, (0, 77))
    elif damage == "foreign_owner":
        restored.mark(restored.database, (77, 77))
    elif damage == "root_wrong_group":
        restored.mark(restored.key, (0, 77))
    elif damage == "service_weak_file":
        restored.mark(restored.database, addon.SERVICE_ID)
    elif damage == "service_parent_root_files":
        restored.mark(restored.state, addon.SERVICE_ID)
    elif damage in {"writable_file", "special_bits"}:
        restored.database.chmod(0o666 if damage == "writable_file" else 0o4644)
    elif damage == "hardlink":
        os.link(restored.key, tmp_path / "external-key-link")
    elif damage == "symlink":
        external = tmp_path / "external-key"
        restored.key.rename(external)
        restored.key.symlink_to(external)
    elif damage == "directory_file":
        restored.database.unlink()
        restored.database.mkdir(mode=0o700)
    elif damage == "fifo":
        restored.database.unlink()
        os.mkfifo(restored.database)
    elif damage == "marker":
        (restored.state / addon.MARKER_NAME).write_bytes(
            b"retained-witness-must-not-certify-restore"
        )
    elif damage == "unknown_entry":
        (restored.state / "unexplained-root-data").write_bytes(b"preserve")
    elif damage == "missing_key":
        restored.key.unlink()
    elif damage == "missing_db":
        restored.database.unlink()
    elif damage in {"short_key", "oversize_key", "binary_key"}:
        restored.key.write_bytes(
            {"short_key": b"short", "oversize_key": b"x" * 131, "binary_key": b"\xff" * 64}[damage]
        )
    else:
        sidecar = restored.state / "jukelet.db-wal"
        sidecar.write_bytes(b"unsafe-sidecar")
        sidecar.chmod(0o666)
        restored.mark(sidecar)
    before = {
        path: (path.lstat().st_mode, path.lstat().st_uid, path.lstat().st_gid)
        for path in (restored.state, *restored.state.iterdir())
    }
    with pytest.raises(ValueError):
        restored.prepare(tmp_path)
    assert restored.changed == []
    assert {
        path: (path.lstat().st_mode, path.lstat().st_uid, path.lstat().st_gid) for path in before
    } == before
    if damage == "missing_key":
        assert not restored.key.exists()


@pytest.mark.parametrize(
    "failure", ["first_chmod", "first_chown", "last_directory_chown", "final_sync"]
)
def test_native_normalization_interruption_preserves_bytes_and_can_resume(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    restored = NativeOwnershipModel(tmp_path, monkeypatch)
    before = restored.database.read_bytes(), restored.key.read_bytes()
    real_chmod, real_sync = os.fchmod, os.fsync
    failed = False

    def chmod(descriptor: int, mode: int) -> None:
        nonlocal failed
        real_chmod(descriptor, mode)
        if failure == "first_chmod" and not failed:
            failed = True
            raise OSError("synthetic interrupted chmod")

    def chown(descriptor: int, uid: int, gid: int) -> None:
        nonlocal failed
        directory = os.path.samestat(
            restored.real_fstat(descriptor), restored.real_stat(restored.state)
        )
        restored.chown(descriptor, uid, gid)
        if not failed and (
            failure == "first_chown" or (failure == "last_directory_chown" and directory)
        ):
            failed = True
            raise OSError("synthetic interrupted chown")

    def sync(descriptor: int) -> None:
        nonlocal failed
        real_sync(descriptor)
        if (
            failure == "final_sync"
            and not failed
            and os.path.samestat(
                restored.real_fstat(descriptor), restored.real_stat(restored.state)
            )
        ):
            failed = True
            raise OSError("synthetic interrupted directory sync")

    monkeypatch.setattr(os, "fchmod", chmod)
    monkeypatch.setattr(os, "fchown", chown)
    monkeypatch.setattr(os, "fsync", sync)
    with pytest.raises(ValueError, match="Unable to prepare"):
        restored.prepare(tmp_path)
    assert failed
    assert (restored.database.read_bytes(), restored.key.read_bytes()) == before
    assert not (restored.state / addon.MARKER_NAME).exists()
    environment = restored.prepare(tmp_path)
    assert environment["JUKELET_SUPERVISOR_CONTINUITY"] == "required"
    for path in (restored.state, restored.database, restored.key):
        assert (path.stat().st_uid, path.stat().st_gid) == addon.SERVICE_ID
    assert (restored.database.read_bytes(), restored.key.read_bytes()) == before


@pytest.mark.parametrize("race", ["file", "directory", "new_entry", "key_bytes"])
def test_native_normalization_rejects_path_replacement_without_following_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, race: str
) -> None:
    restored = NativeOwnershipModel(tmp_path, monkeypatch)
    external = tmp_path / "unrelated-external"
    external.write_bytes(b"SYNTHETIC_UNRELATED_CONTENT")
    external.chmod(0o644)
    external_before = external.read_bytes(), external.stat()
    original_db = restored.database.read_bytes()
    real_chmod = os.fchmod
    raced = False

    def replace(descriptor: int, mode: int) -> None:
        nonlocal raced
        if not raced:
            raced = True
            if race == "file":
                restored.database.rename(tmp_path / "retained-original-db")
                restored.database.symlink_to(external)
            elif race == "directory":
                restored.state.rename(tmp_path / "retained-state")
                restored.state.symlink_to(tmp_path, target_is_directory=True)
            elif race == "new_entry":
                (restored.state / "jukelet.db-wal").symlink_to(external)
            else:
                restored.key.write_bytes(b"another-synthetic-key-with-different-bytes-123456789")
        real_chmod(descriptor, mode)

    monkeypatch.setattr(os, "fchmod", replace)
    with pytest.raises(ValueError):
        restored.prepare(tmp_path)
    assert raced and restored.changed == []
    retained = (
        tmp_path / "retained-original-db"
        if race == "file"
        else tmp_path / "retained-state/jukelet.db"
        if race == "directory"
        else restored.database
    )
    assert retained.read_bytes() == original_db
    after = external.stat()
    assert external.read_bytes() == external_before[0]
    assert (after.st_mode, after.st_uid, after.st_gid) == (
        external_before[1].st_mode,
        external_before[1].st_uid,
        external_before[1].st_gid,
    )


def test_native_normalization_rechecks_all_selected_inodes_before_first_mutation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    restored = NativeOwnershipModel(tmp_path, monkeypatch)
    old_key = restored.key.read_bytes()
    real_open = os.open
    replaced = False

    def open_file(path: str | Path, *args: Any, **kwargs: Any) -> int:
        nonlocal replaced
        if path == addon.DATABASE_NAME and not replaced:
            replaced = True
            restored.key.rename(tmp_path / "retained-original-key")
            restored.key.write_bytes(b"another-valid-synthetic-private-key-123456789012345")
            restored.key.chmod(0o644)
            restored.mark(restored.key)
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(os, "open", open_file)
    with pytest.raises(ValueError, match="changed"):
        restored.prepare(tmp_path)
    assert replaced and restored.changed == []
    assert restored.database.stat().st_mode & 0o777 == 0o644
    assert restored.key.stat().st_mode & 0o777 == 0o644
    assert (tmp_path / "retained-original-key").read_bytes() == old_key


def test_native_normalization_resumes_partial_metadata_with_all_known_sidecars(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    restored = NativeOwnershipModel(tmp_path, monkeypatch)
    restored.key.chmod(0o600)
    restored.mark(restored.key, addon.SERVICE_ID)
    restored.database.chmod(0o600)  # Interrupted after tightening, before chown.
    for suffix in ("-wal", "-shm", "-journal"):
        sidecar = restored.state / (addon.DATABASE_NAME + suffix)
        sidecar.write_bytes(b"synthetic-retained-sidecar")
        sidecar.chmod(0o644)
        restored.mark(sidecar)
    before = {path: path.read_bytes() for path in restored.state.iterdir()}
    restored.prepare(tmp_path)
    assert {path: path.read_bytes() for path in before} == before
    for path in before:
        metadata = path.stat()
        assert (metadata.st_uid, metadata.st_gid) == addon.SERVICE_ID
        assert metadata.st_mode & 0o777 == 0o600


def test_normal_service_state_never_enters_metadata_normalization(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    restored = NativeOwnershipModel(tmp_path, monkeypatch)
    for path in (restored.state, restored.database, restored.key):
        restored.mark(path, addon.SERVICE_ID)
    for path in (restored.database, restored.key):
        path.chmod(0o600)
    restored.prepare(tmp_path)
    assert restored.changed == []


def test_native_normalization_keeps_missing_witness_guard_before_publisher(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import sqlite3

    from fastapi.testclient import TestClient

    from jukelet.ha.adapter import HAAdapter
    from jukelet.main import create_app
    from jukelet.publication import Publisher

    current_user = os.geteuid(), os.getegid()
    restored = NativeOwnershipModel(tmp_path, monkeypatch, populated=True)
    key_before = restored.key.read_bytes()
    original_connect = sqlite3.connect

    def forbidden(*args: Any, **kwargs: Any) -> None:
        pytest.fail("root bootstrap must never open SQLite")

    monkeypatch.setattr(sqlite3, "connect", forbidden)
    environment = restored.prepare(tmp_path)
    monkeypatch.setattr(sqlite3, "connect", original_connect)
    # Model the service phase with the current test user; numeric root
    # adoption above is not actual root/native verification.
    restored.owners = {identity: current_user for identity in restored.owners}
    monkeypatch.setattr(os, "geteuid", lambda: current_user[0])
    starts: list[bool] = []

    def guarded(_: object) -> None:
        with sqlite3.connect(restored.database) as connection:
            assert connection.execute(
                "SELECT reconciliation_required FROM recovery_state"
            ).fetchone() == (1,)
            assert connection.execute(
                "SELECT automatic_enabled,healthy,guard_generation FROM publication_state"
            ).fetchone() == (0, 0, 8)
            assert connection.execute("SELECT count(*) FROM owner_session").fetchone() == (0,)
            assert connection.execute(
                "SELECT count(*) FROM publication_job WHERE state IN "
                "('queued','in_flight','uncertain')"
            ).fetchone() == (0,)
        starts.append(True)

    monkeypatch.setattr(HAAdapter, "start", guarded)
    monkeypatch.setattr(Publisher, "start", guarded)
    settings = Settings.load(environment)
    with TestClient(create_app(settings)):
        assert starts == [True, True]
    assert restored.key.read_bytes() == key_before


def test_concurrent_root_bootstrap_serializes_the_directory_creation_boundary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model = NativeOwnershipModel(tmp_path, monkeypatch)
    model.database.unlink()
    model.key.unlink()
    model.state.rmdir()
    model.owners = {}
    options = write_options(tmp_path)
    created, release = threading.Event(), threading.Event()
    real_mkdir = os.mkdir

    def mkdir(path: str | Path, *args: Any, **kwargs: Any) -> None:
        real_mkdir(path, *args, **kwargs)
        if path == addon.STATE_DIRECTORY:
            model.mark(model.state)
            created.set()
            assert release.wait(5), "test creator was never released"

    def chown(descriptor: int, uid: int, gid: int) -> None:
        metadata = model.real_fstat(descriptor)
        model.owners[(metadata.st_dev, metadata.st_ino)] = (uid, gid)

    def initialize() -> bytes:
        environment = prepare(
            options,
            tmp_path,
            {"SUPERVISOR_TOKEN": "synthetic-private"},
            owner=addon.SERVICE_ID,
        )
        return Settings.load(environment).auth_secret

    monkeypatch.setattr(os, "mkdir", mkdir)
    monkeypatch.setattr(os, "fchown", chown)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(initialize)
        assert created.wait(5)
        second = pool.submit(initialize)
        try:
            # Before creation is protected, this contender can misclassify the
            # creator's root0700 empty directory as incomplete restored state.
            try:
                second.result(timeout=0.2)
            except FutureTimeout:
                pass
        finally:
            release.set()
        keys = first.result(timeout=5), second.result(timeout=5)
    assert keys[0] == keys[1] and len(keys[0]) == 64
    assert model.key.read_bytes() == keys[0]


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
