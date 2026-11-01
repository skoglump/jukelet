"""The native browser helper's local tests must work without frontend packages."""

import json
import shutil
import subprocess
from pathlib import Path

from scripts.haos_acceptance.fixture.custom_components.jukelet_acceptance.policy import (
    ALBUM_ID,
    PLAYLIST_ID,
    TAG_ALBUM,
    TAG_PLAYLIST,
)


def test_browser_helper_boundaries_without_native_services_or_frontend_dependencies() -> None:
    node = shutil.which("node")
    assert node is not None, "Node is an explicit backend CI prerequisite"
    result = subprocess.run(
        [
            node,
            "--test",
            "scripts/haos_acceptance/browser.test.mjs",
            "scripts/haos_acceptance/browser_auth.test.mjs",
            "scripts/haos_acceptance/browser_manager.test.mjs",
        ],
        cwd=Path(__file__).resolve().parents[2],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_native_manager_targets_match_the_frozen_synthetic_ha_fixture() -> None:
    node = shutil.which("node")
    assert node is not None
    result = subprocess.run(
        [
            node,
            "--input-type=module",
            "-e",
            "import { ALBUM_TAG, PLAYLIST_TAG, ALBUM_URI, PLAYLIST_URI } "
            "from './scripts/haos_acceptance/browser_manager.mjs'; "
            "process.stdout.write(JSON.stringify([ALBUM_TAG,PLAYLIST_TAG,ALBUM_URI,PLAYLIST_URI]));",
        ],
        cwd=Path(__file__).resolve().parents[2],
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == [
        TAG_ALBUM,
        TAG_PLAYLIST,
        f"spotify:album:{ALBUM_ID}",
        f"spotify:playlist:{PLAYLIST_ID}",
    ]
