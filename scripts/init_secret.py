"""Create a local app secret without printing it or replacing an existing credential."""

import os
import secrets
from pathlib import Path


def main() -> None:
    directory = Path(__file__).resolve().parents[1] / ".secrets"
    directory.mkdir(mode=0o700, exist_ok=True)
    directory.chmod(0o700)
    destination = directory / "app-auth-token"
    # Docker Compose binds the file itself, so the non-root app needs read permission.
    # The private parent directory prevents other host users from accessing the file.
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(secrets.token_hex(32) + "\n")
    destination.chmod(0o444)
    print(
        "Created .secrets/app-auth-token; keep this file private. "
        "Existing secrets are never replaced."
    )


if __name__ == "__main__":
    main()
