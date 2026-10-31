# Add-on artifact preparation (#59)

This tooling prepares a source-bound build context and a separate Home Assistant
repository snapshot. It does not build or publish an image, register a repository,
or change a running installation. Candidate 6 is reserved for the new artifact
path; no built candidate 6 is claimed by this preparation checkpoint.

Run from the repository root with its pinned tools and an exact reviewed commit:

```sh
python3 -m scripts.addon_release prepare \
  --ref REVIEWED_COMMIT \
  --release-tag addon-v0.1.0-addon.6 --prerelease true \
  --output dist/addon-release-6
python3 -m scripts.addon_release verify-prepared \
  --prepared dist/addon-release-6 --expected-source REVIEWED_COMMIT
```

`REVIEWED_COMMIT` must be replaced by the full expected source commit. Preparation
resolves its input once, reads committed blobs, and ignores dirty or untracked
working files. Verification requires the independently expected full commit;
trusting a source value copied from an untrusted sidecar is insufficient. Existing
output directories are refused, including a partial earlier attempt. Preserve the
old evidence and choose a fresh output directory.

The prepared directory contains:

| Path | Purpose |
| --- | --- |
| `context/jukelet/` | Existing allowlisted application build with embedded source provenance |
| `repository/repository.yaml` | HA repository name, URL and maintainer metadata |
| `repository/jukelet/config.json` | Exact packaging version and fixed prebuilt-image namespace |
| `repository/jukelet/translations/en.yaml` | The committed option labels |
| `plan.json` | Source/tree/context identity, separate app/bridge source versions, pinned base images, required build labels and repository checksums |

The repository metadata uses `image: ghcr.io/skoglump/jukelet-addon` and its exact
version. Native Supervisor app metadata does not support a digest in `image`;
version-tag immutability, artifact digests and independent registry/runtime
readbacks must establish the expected bytes. No native cryptographic digest pin
is claimed. A disposable registry test may replace only this external snapshot's
registry host while preserving its repository path/version and the image bytes;
that is not evidence that an image exists at GHCR.

The plan supplies the required prebuilt-image HA version, architecture and app-type
labels, OCI source/revision/version, separate application version and context hash.
Pinned base-image declarations are checked; actual AMD64 builds and dependency
support still require build evidence. Instruction case and indentation are
normalized. Alternative parser/escape directives, continued `FROM` declarations
and heredocs are explicitly refused by this supported recipe subset. The
[local package](34-local-ha-addon.md)
keeps its default local-build behavior. Stable `addon-vX.Y.Z` preparation uses
matching metadata and `--prerelease false`; stable syntax alone does not establish
readiness or authorize publication. Archive sealing, release publication and
isolated install/upgrade evidence remain subsequent #59 checkpoints.
