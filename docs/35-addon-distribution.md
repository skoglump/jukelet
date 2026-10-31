# Add-on artifact preparation (#59)

This tooling prepares a source-bound build context and a separate Home Assistant
repository snapshot, seals an exported image archive, and validates supplied
registry observations. It does not build or publish an image, register a
repository, or change a running installation. Candidate 6 is reserved for the new
artifact path; no built candidate 6 is claimed by this tooling checkpoint.

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
guard permits ordinary COPY and a single `COPY --from=` selecting a verified
prior named stage, including JSON COPY. Other COPY flags, RUN instruction flags
(including mount forms), and nested ONBUILD instructions are refused. Default
continuations are joined before checking flags; ordinary continued shell
arguments are preserved. External-image or named-context selectors are not
silently treated as reviewed stage aliases. The
[local package](34-local-ha-addon.md)
keeps its default local-build behavior. Stable `addon-vX.Y.Z` preparation uses
matching metadata and `--prerelease false`; stable syntax alone does not establish
readiness or authorize publication.

## Build once, then seal the exact saved bytes

Use a never-built packaging version and its reviewed source. A known locally
built candidate must not be rebuilt under the same version, including from a
later documentation-only commit. Identical source inputs do not guarantee an
identical Docker image. Subsequent publication must promote the exact tested
archive; an absent registry tag is not permission to rebuild it.

After preparation and `verify-prepared`, the following local commands derive all
image labels and the exact image reference from the validated plan. Substitute the
chosen fresh directory and archive filename. Keep the archive outside the
prepared directory; verification refuses extra files in that directory.

```sh
python3 - <<'PY'
import json
import subprocess
from pathlib import Path

prepared = Path("dist/addon-release-6")
plan = json.loads((prepared / "plan.json").read_text())
command = ["docker", "build", "--platform", plan["platforms"][0],
           "--tag", plan["image_reference"]]
for key, value in sorted(plan["labels"].items()):
    command += ["--label", f"{key}={value}"]
subprocess.run(command + [str(prepared / "context/jukelet")], check=True)
subprocess.run(["docker", "image", "save", "--output", "dist/addon-image-6.tar",
                plan["image_reference"]], check=True)
PY
python3 -m scripts.addon_release seal \
  --prepared dist/addon-release-6 --expected-source REVIEWED_COMMIT \
  --archive dist/addon-image-6.tar --output dist/addon-image-6.artifact.json
python3 -m scripts.addon_release verify-archive \
  --prepared dist/addon-release-6 --expected-source REVIEWED_COMMIT \
  --expected-archive-sha256 APPROVED_ARCHIVE_SHA256 \
  --archive dist/addon-image-6.tar --artifact dist/addon-image-6.artifact.json
```

This is an explicit local build, not a registry push. Build/export and actual
isolated HA OS install/update evidence are still pending for candidate 6 at this
checkpoint. Preparing or verifying a synthetic archive is not that evidence.

Sealing streams bounded regular-file input without extracting it to the host. It
checks a single exact image tag, AMD64/Linux config, required identity labels,
add-on startup adapter, filesystem diffIDs and embedded committed provenance.
Classic Docker archives and Docker29's OCI/blob layout, gzip layers and bounded
legacy compatibility records are supported. Mixed images, foreign tags/platforms,
unsafe or extra members, inconsistent hashes and hidden/replaced provenance are
refused. Reports contain selected identities and hashes, never image environment
or raw configuration contents. Existing artifact/receipt outputs are refused.

| Identity | Meaning |
| --- | --- |
| `archive_sha256` | SHA-256 of the complete saved `.tar` bytes |
| `image_id` | Digest of the image config, including its ordered filesystem diffIDs |
| `exported_oci_manifest_digest` / `exported_oci_index_digest` | Optional representations inside the saved archive; not assumed to be registry digests |
| `registry_manifest_digest` / `registry_index_digest` | Digests of separately supplied observed registry bytes; index is absent for a single platform manifest |

The checks establish consistency and exact byte identity; sidecars are not
signatures. Use trusted reviewed tooling and independently recorded source and
archive checksums, and retain the actual build/test evidence.
Verification and receipt commands require the independently approved lowercase
64-digit archive checksum. Do not obtain that authority from a downloaded sidecar
or merely recompute it from the untrusted current file. This also rejects a
self-consistent replacement of both archive and sidecar after testing.

## Record an observed registry result

After a separately authorized publication or disposable registry copy, retain the
raw platform manifest and its independently observed digest. Then validate them
against the sealed archive:

```sh
python3 -m scripts.addon_release receipt \
  --prepared dist/addon-release-6 --expected-source REVIEWED_COMMIT \
  --expected-archive-sha256 APPROVED_ARCHIVE_SHA256 \
  --archive dist/addon-image-6.tar --artifact dist/addon-image-6.artifact.json \
  --manifest dist/registry-manifest.json --manifest-digest OBSERVED_SHA256_DIGEST \
  --output dist/addon-image-6.registry.json
```

`OBSERVED_SHA256_DIGEST` includes `sha256:` and the full digest. When a registry
index exists, also supply `--index FILE --index-digest DIGEST`. The index must
resolve only the tested AMD64 platform manifest. The manifest must reference the
sealed image config and layer count. Actual registry blob readback, normal pull
and runtime identity checks remain necessary; this offline command neither
contacts the registry nor establishes publication or network-readback success.

For the authorized disposable guest-loopback registry, add
`--fixture-image 127.0.0.1:15059/skoglump/jukelet-addon:PACKAGING_VERSION`, replacing
the version with the validated exact version. The receipt explicitly records
`disposable-loopback-registry`; production metadata and archive bytes stay
unchanged. A fixture receipt cannot change the repository path or version and
does not establish GHCR availability. Release workflow preparation, actual
install/upgrade evidence and any later publication request remain separate gates.
