"""Explicit local-input validation; no network, VM changes or acceptance claim."""

import argparse
import json
import sys
from pathlib import Path

from .config import load_config


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["validate"])
    parser.add_argument("configuration", type=Path)
    args = parser.parse_args()
    try:
        report = load_config(args.configuration).public_report()
    except ValueError:
        print(
            json.dumps(
                {"result": "FAIL", "code": "invalid_fixture_input", "native_acceptance": "NOT_RUN"}
            ),
            file=sys.stderr,
        )
        raise SystemExit(2) from None
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
