"""The native browser helper's local tests must work without frontend packages."""

import shutil
import subprocess
from pathlib import Path


def test_browser_helper_boundaries_without_native_services_or_frontend_dependencies() -> None:
    node = shutil.which("node")
    assert node is not None, "Node is an explicit backend CI prerequisite"
    result = subprocess.run(
        [node, "--test", "scripts/haos_acceptance/browser.test.mjs"],
        cwd=Path(__file__).resolve().parents[2],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
