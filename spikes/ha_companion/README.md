# Isolated HA companion feasibility spike

Issue #19 selects a dedicated integration and settles the v1 wire contract. This directory is an executable **synthetic experiment**, excluded from the application image and Python distribution. It is not an installable production bridge, dispatcher or publisher. See [the contract, evidence and blockers](../../docs/15-companion-feasibility.md).

From the repository root, normal dependency-free companion checks are included in `make check`:

```sh
make companion-check
```

The actual HA experiment is opt-in. With the repository's Python 3.14.8 and uv 0.13.1, create an isolated environment and install its pinned dependencies (initial installation needs package-index access):

```sh
uv venv --python 3.14.8 /tmp/jukelet-ha-spike-venv
uv pip sync --python /tmp/jukelet-ha-spike-venv/bin/python spikes/ha_companion/runtime-requirements.txt
/tmp/jukelet-ha-spike-venv/bin/python -m spikes.ha_companion.runtime_probe
```

The probe accepts no URL, token or configuration-directory argument. It creates temporary synthetic HA configuration, copies only this prototype, starts real HA Core 2026.10.2 processes, authenticates over loopback WebSocket using generated test users, and stops/removes its own environment data. Credentials stay inside the child processes and are created only through HA auth APIs; the harness never reads or edits credential stores. HA manages its own temporary files. No application process is needed for snapshot recovery. No `default_config`, discovery, tag, automation, playback or Spotify integrations are started. Runtime dependency installation is disabled. Expected unauthorized and injected-write-error HA log entries contain synthetic data only.

It verifies graceful restart, process kill after acknowledgment, process kill immediately before/after the real atomic writer, lost-response reconciliation, rejected non-admin access, and an invalid-schema record saved through the companion's supported HA Store. Fault hooks exist only in this test harness's process, not in the integration's WebSocket API. They affect only `jukelet_bridge.snapshot`. All persistence uses `Store`; no raw `.storage` edits are made. See the report for the distinction between actual HA behavior and injected failures, and for untested power-loss/filesystem guarantees.

A run should print seven `PASS` lines and a final JSON record with `synthetic: true`, HA version, recovered revision 3 and checksum. On failure the process exits nonzero. The last scenario deliberately leaves the *temporary* companion degraded, demonstrating that it cannot silently replace a corrupt record. Temporary files are then removed.

The lock is generated for Python 3.14.8:

```sh
uv pip compile --python-version 3.14.8 spikes/ha_companion/runtime-requirements.in -o spikes/ha_companion/runtime-requirements.txt
```

HA itself depends on its own pinned uv package; use the repository's uv 0.13.1 to prepare the isolated environment. The HA dependencies never enter the application backend environment. Cross-platform installation and other HA versions have not been verified.
