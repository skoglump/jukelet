from pathlib import Path

import pytest

from jukelet.config import Settings

# Deliberately synthetic; never usable against a household installation.
SYNTHETIC_SECRET = b"synthetic-fixture-secret-not-for-real-use"


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        public_origin="https://jukelet.example",
        database_path=tmp_path / "fixture.db",
        auth_secret=SYNTHETIC_SECRET,
        static_dir=tmp_path / "absent-assets",
    )
