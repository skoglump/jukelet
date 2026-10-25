"""Bounded test-environment checks, independent of the runtime version allowlist."""

import json
import multiprocessing
import os
import shutil
import subprocess
import sys
import zipfile
from importlib.metadata import version
from multiprocessing import spawn
from multiprocessing.process import BaseProcess
from pathlib import Path


def probe_ha_version() -> str:
    installed = version("homeassistant")
    from .custom_components.jukelet_bridge.compatibility import version_policy

    assert version_policy(installed).allowed, "Use a prepared isolated HA environment >=2026.10.3"
    return installed


def start_probe_process(process: BaseProcess, executable: Path | None = None) -> None:
    """Select an interpreter only around serial probe Process.start(), then restore it.

    multiprocessing's executable selection is process-global. The upgrade probe
    uses this seam serially; it must never be used beside concurrent launches.
    No HTTP/WS command or production integration exposes this selection.
    """
    if executable is None:
        process.start()
        return
    assert executable.is_absolute() and executable.is_file()
    previous = spawn.get_executable()
    previous_path = list(sys.path)
    # spawn transfers the parent's sys.path. Without replacing its site-packages,
    # a different executable could still import the parent's Core version.
    child_path = json.loads(
        subprocess.check_output(
            [str(executable), "-I", "-c", "import json,sys; print(json.dumps(sys.path))"],
            text=True,
        )
    )
    assert isinstance(child_path, list) and all(isinstance(path, str) for path in child_path)
    try:
        sys.path[:] = [str(Path(__file__).resolve().parents[1]), *child_path]
        multiprocessing.set_executable(str(executable))
        process.start()
    finally:
        sys.path[:] = previous_path
        multiprocessing.set_executable(previous)


def install_probe_component(directory: Path) -> None:
    """Install only into the caller's newly owned temporary config directory."""
    archive = os.environ.get("JUKELET_PROBE_ARCHIVE")
    if archive:
        from scripts.package_integration import verify

        path = Path(archive).resolve(strict=True)
        verify(path)
        with zipfile.ZipFile(path) as package:
            package.extractall(directory)
        verify(path, directory / "custom_components/jukelet_bridge")
    else:
        shutil.copytree(
            Path(__file__).parent / "custom_components", directory / "custom_components"
        )
