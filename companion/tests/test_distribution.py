"""Synthetic Git repositories and packages; no deployment or private inputs."""

import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.package_integration import PREFIX, RUNTIME, build, release_version, verify


class DistributionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="jukelet-package-test-")
        self.addCleanup(self.temporary.cleanup)
        self.repository = Path(self.temporary.name) / "repo"
        self.repository.mkdir()
        source = Path(__file__).parents[1] / "custom_components/jukelet_bridge"
        self.runtime = self.repository / "companion/custom_components/jukelet_bridge"
        self.runtime.mkdir(parents=True)
        for name in RUNTIME:
            target = self.runtime / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, target)
        self.git("init", "-q")
        self.git("add", ".")
        self.commit()
        self.output = Path(self.temporary.name) / "output"

    def git(self, *args: str) -> str:
        return (
            subprocess.check_output(
                ["git", "-C", str(self.repository), *args], stderr=subprocess.PIPE
            )
            .decode()
            .strip()
        )

    def commit(self) -> None:
        self.git(
            "-c",
            "user.name=Synthetic",
            "-c",
            "user.email=synthetic@example.invalid",
            "commit",
            "-qm",
            "Synthetic",
        )

    def test_committed_allowlist_excludes_private_like_inputs_and_reproduces(self) -> None:
        # Tracked outside runtime and untracked within it are never read/copied.
        for name in (
            ".secrets/token",
            "configuration.yaml",
            "assignments.json",
            "fixtures/input.json",
            "migration-evidence/log",
        ):
            path = self.repository / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("SYNTHETIC_PRIVATE_CANARY")
        self.git("add", ".")
        self.commit()
        for name in (
            ".env",
            "credentials.json",
            "assignments.json",
            "fixture.yaml",
            "migration.log",
        ):
            (self.runtime / name).write_text("SYNTHETIC_PRIVATE_CANARY")
        manifest = build(self.repository, "HEAD", self.output)
        archive = self.output / manifest["archive"]
        original = archive.read_bytes()
        with zipfile.ZipFile(archive) as package:
            self.assertEqual(
                set(package.namelist()), {PREFIX + n for n in (*RUNTIME, "build_info.json")}
            )
            self.assertNotIn(
                b"SYNTHETIC_PRIVATE_CANARY", b"".join(package.read(n) for n in package.namelist())
            )
            package.extractall(Path(self.temporary.name) / "installed")
        self.assertEqual(verify(archive), manifest)
        verify(archive, Path(self.temporary.name) / "installed/custom_components/jukelet_bridge")
        (self.runtime / "bridge.py").write_text("uncommitted changes must not enter package")
        second = build(self.repository, "HEAD", Path(self.temporary.name) / "second")
        self.assertEqual(second, manifest)
        self.assertEqual(
            original, (Path(self.temporary.name) / "second" / manifest["archive"]).read_bytes()
        )
        self.assertEqual(manifest["source_commit"], self.git("rev-parse", "HEAD"))
        self.assertEqual(
            manifest["source_tree"],
            self.git("rev-parse", "HEAD:companion/custom_components/jukelet_bridge"),
        )

    def test_unexpected_committed_runtime_file_and_symlink_refuse_packaging(self) -> None:
        unexpected = self.runtime / "assignments.json"
        unexpected.write_text("SYNTHETIC_PRIVATE_CANARY")
        self.git("add", ".")
        self.commit()
        with self.assertRaisesRegex(ValueError, "allowlist"):
            build(self.repository, "HEAD", self.output)
        unexpected.unlink()
        target = self.runtime / "bridge.py"
        target.unlink()
        target.symlink_to("/not-a-real-private-source")
        self.git("add", ".")
        self.commit()
        with self.assertRaisesRegex(ValueError, "regular"):
            build(self.repository, "HEAD", self.output)
        self.assertFalse(self.output.exists())

    def test_tamper_and_mixed_installed_files_rejected(self) -> None:
        manifest = build(self.repository, "HEAD", self.output)
        archive = self.output / manifest["archive"]
        installed = Path(self.temporary.name) / "installed"
        with zipfile.ZipFile(archive) as package:
            package.extractall(installed)
        runtime = installed / "custom_components/jukelet_bridge"
        (runtime / "old-release.py").write_text("old bytes")
        with self.assertRaisesRegex(ValueError, "unexpected installed"):
            verify(archive, runtime)
        (runtime / "old-release.py").unlink()
        (runtime / "bridge.py").write_text("changed bytes")
        with self.assertRaisesRegex(ValueError, "installed runtime checksum"):
            verify(archive, runtime)
        archive.write_bytes(archive.read_bytes() + b"tamper")
        with self.assertRaisesRegex(ValueError, "archive checksum"):
            verify(archive)
        with self.assertRaisesRegex(ValueError, "refusing to replace"):
            build(self.repository, "HEAD", self.output)

    def test_integration_identity_is_separate_from_app_rc(self) -> None:
        self.assertEqual(release_version("integration-v0.1.1", "0.1.1", False), "0.1.1")
        for tag, version, prerelease in (
            ("v0.1.0-rc.1", "0.1.1", True),
            ("integration-v0.1.0", "0.1.1", False),
            ("integration-v0.1.1", "0.1.1", True),
            ("integration-v00.1.1", "00.1.1", False),
        ):
            with self.assertRaises(ValueError):
                release_version(tag, version, prerelease)
        workflow = Path(".github/workflows/publish-docker.yml").read_text()
        self.assertIn(
            "if: ${{ !startsWith(github.event.release.tag_name, 'integration-v') }}", workflow
        )
        integration = Path(".github/workflows/publish-integration.yml").read_text()
        self.assertIn("if: startsWith(github.event.release.tag_name, 'integration-v')", integration)
        self.assertNotIn("--clobber", integration)
        self.assertIn("Existing release assets are immutable", integration)


if __name__ == "__main__":
    unittest.main()
