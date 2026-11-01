# Add-on artifacts and approved promotion (#59)

This tooling prepares a source-bound build context and a separate Home Assistant
repository snapshot, seals an exported image archive, and validates supplied
registry observations. Preparation and offline verification do not publish or
change a running installation; the separately authorized promotion phase below
publishes the exact approved archive. Candidate 6 is a frozen rehearsal artifact
from `0f9fdebbeefb8e777130d65bd1063f5187b501a0`.
Candidate 7 was built once at `7b1d58b290da1f1c89e9c7e386aba97c17fc3c80` and
passed actual isolated clean-install and same-channel upgrade checks; see the
[dated evidence](#actual-isolated-evidence-2026-11-01). Its original archive and
build source remain authoritative after documentation-only commits.

Run from the repository root with its pinned tools and an exact reviewed commit:

```sh
python3 -m scripts.addon_release prepare \
  --ref REVIEWED_COMMIT \
  --release-tag addon-vPACKAGING_VERSION --prerelease true \
  --output dist/addon-release
python3 -m scripts.addon_release verify-prepared \
  --prepared dist/addon-release --expected-source REVIEWED_COMMIT
```

These preparation/build examples are future templates. Replace
`PACKAGING_VERSION` with a never-built candidate version and `REVIEWED_COMMIT`
with its full reviewed source commit containing that matching committed metadata.
This does not reserve or build another candidate or authorize publication.
Any later release still requires a separate explicit release request.
Candidate 7 is already built: use its pinned verification command below, never
repeat its build. Preparation
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
Pinned base-image declarations are checked; they do not replace actual build
and dependency evidence. Candidate 7's AMD64 evidence is recorded below. Instruction case and indentation are
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

prepared = Path("dist/addon-release")
plan = json.loads((prepared / "plan.json").read_text())
command = ["docker", "build", "--platform", plan["platforms"][0],
           "--tag", plan["image_reference"]]
for key, value in sorted(plan["labels"].items()):
    command += ["--label", f"{key}={value}"]
subprocess.run(command + [str(prepared / "context/jukelet")], check=True)
subprocess.run(["docker", "image", "save", "--output", "dist/addon-image.tar",
                plan["image_reference"]], check=True)
PY
python3 -m scripts.addon_release seal \
  --prepared dist/addon-release --expected-source REVIEWED_COMMIT \
  --archive dist/addon-image.tar --output dist/addon-image.artifact.json
python3 -m scripts.addon_release verify-archive \
  --prepared dist/addon-release --expected-source REVIEWED_COMMIT \
  --expected-archive-sha256 APPROVED_ARCHIVE_SHA256 \
  --archive dist/addon-image.tar --artifact dist/addon-image.artifact.json
```

These are explicit local build commands, not a registry push. Run them only for
a never-built version from its matching reviewed commit. The completed candidate
7 build/install/update evidence below does not permit rebuilding version 7 from
this or a later documentation commit. Synthetic archive tests remain separate
from that actual evidence.

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
  --prepared dist/addon-release --expected-source REVIEWED_COMMIT \
  --expected-archive-sha256 APPROVED_ARCHIVE_SHA256 \
  --archive dist/addon-image.tar --artifact dist/addon-image.artifact.json \
  --manifest dist/registry-manifest.json --manifest-digest OBSERVED_SHA256_DIGEST \
  --output dist/addon-image.registry.json
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

## Actual isolated evidence (2026-11-01)

The operator and independent tester verified the same once-built candidate 7 on
a disposable **HA OS 18.4 / Supervisor 2026.10.5 / Core 2026.10.4, AMD64** fixture.
This is actual Supervisor installation evidence. It covers the selected AMD64
platform, not ARM64 or a wider HA version/support matrix.

| Candidate 7 identity | Recorded value |
| --- | --- |
| Add-on / shared application / separate bridge source versions | `0.1.0-addon.7` / `0.1.0-rc.3` / `0.1.5` |
| Build source | [`7b1d58b290da1f1c89e9c7e386aba97c17fc3c80`](https://github.com/skoglump/jukelet/tree/7b1d58b290da1f1c89e9c7e386aba97c17fc3c80) |
| Source tree | `9311572821d49c81e6fac476e8dfdbbf1b2e05b0` |
| Prepared context SHA256 | `2e998dfbcb9ad40204b69b92df4d1e185732558dad67b8cb0fed812f71b3a1f4` |
| Original saved archive | `180666880` bytes; SHA256 `e1fed4c81b5e35a5744104966e5ad9af6476a30b6010664929e5d24008a03eed` |
| Image config digest | `sha256:68313c48db1874e5167d26bb6b5c9ab206364798c425324793d9e7c1725446d4` |
| Exported and observed fixture platform-manifest digest | `sha256:07467ae9d56f3e96817390eb2564fc364730f785cae99a9ee72244423abf11b9` |
| Exported archive index digest | `sha256:8e6c74bb8109840557eb96600c2671949187814d6d2a6a80f5bcd82b9d2af040` |
| Actual registry index | None: the fixture served a single platform manifest |
| Embedded provenance SHA256 | `377a942d3d404eb806e64952263df6bf6554faf8bdaf408d8e2eec51ab2e401f` |

The production reference remains
`ghcr.io/skoglump/jukelet-addon:0.1.0-addon.7`. Delivery used only
`127.0.0.1:15059/skoglump/jukelet-addon:0.1.0-addon.7` inside the owned guest.
The generated metadata copy changed only its registry host; repository path,
version, architecture and runtime settings matched the production snapshot.
There was no local Dockerfile and the Store selected prebuilt-image operation.
Neither this fixture nor its receipt proves GHCR availability or public Store
repository deployment.

The actual producer completed preparation, `verify-prepared`, one
`docker build --platform linux/amd64` with every validated plan label,
`docker image save` by the exact qualified tag, sealing and independently expected
source/archive verification, all with exit 0. The actual local
`verify_image` load/re-export/dependency/provenance probe also passed with network
disabled. Its diagnostic re-export did not replace the original archive.
The recorded verification-only command used the following retained local paths:

```sh
python3 -m scripts.addon_release verify-archive \
  --prepared /tmp/jukelet-issue59-candidate7/prepared \
  --expected-source 7b1d58b290da1f1c89e9c7e386aba97c17fc3c80 \
  --archive /tmp/jukelet-issue59-candidate7/image.tar \
  --artifact /tmp/jukelet-issue59-candidate7/image.artifact.json \
  --expected-archive-sha256 e1fed4c81b5e35a5744104966e5ad9af6476a30b6010664929e5d24008a03eed
```

These paths identify this run's local evidence, not public downloads. Candidate
6 remains frozen at source `0f9fdebbeefb8e777130d65bd1063f5187b501a0`, config
`sha256:efd12491077e17a1eba7d6fbd309994fa12ba9fa6e51af42c13d7d063f0c86db`,
original archive SHA256
`b14a6b7a359bc8cf477464263293106c7b76219d19fb01e2253beac48f541caf`.
Its prior normal clean installation and independent observation formed the
upgrade baseline; neither candidate was rebuilt for the following operations.

| Actual operation | Operator history and independent readback |
| --- | --- |
| Normal 6 → 7 same-channel upgrade | Candidate 7 tag caches were absent before supported Store reload/update. Supervisor pulled the new manifest and started a new healthy container; the old 6 container exited 0. Independent 7 observation matched the tester's own 6 baseline for publisher/key fingerprints, schema `0004`, reconciliation fence, assignment revision/rows, publication state/jobs, runtime identity and options ownership/mode. A fixed privileged fingerprint check matched options bytes without exposing values. |
| Normal clean installation of the same 7 bytes | The upgraded app stopped with exit 0 and only task-owned synthetic data was privately preserved consistently. Supported uninstall removed its data directory; candidate tag caches were absent. The existing fixture manifest was unchanged, with no second push/build. Normal Store install/start produced a different healthy container, schema `0004`/integrity OK, fresh publisher/key, zero assignment/revision/jobs/reconciliation state and publication disabled. Independent readback corroborated the fresh identities and the same source/config/manifest/layers/provenance. |

Normal pull logs contained **3 distinct GET requests** during upgrade and
**8 during clean install** (the latter had 26 debug lines, not 26 requests).
Shared base layers could remain cached; candidate tag absence does not imply
absence of every shared layer. The operator separately hashed the actual registry
manifest, config and all ten layer bodies/decompressed diffIDs. The tester
reconciled those retained captures with the original archive and independently
observed installed labels, ordered diffIDs and provenance; it did not restart the
stopped registry or claim new registry GETs.

Independent observations passed for both the upgraded and clean-installed app:
nonroot UID/GID `10001`, no supplementary groups/capabilities, protected data/DB/key
permissions and root-owned `0600` options unreadable by the app user. Native
browser checks passed using one synthetic administrator and desktop Chromium:
verified TLS, sidebar/login, Ingress session and Core connection, prefixed assets,
canonical slash/query preservation, fail-closed bare 404 without app bootstrap,
no escaped/external/write requests, and restored canonical session. Broader
identity/mobile coverage remains downstream work.

While the temporary unregistered delivery registry ran, Supervisor reported
`healthy=true` but `supported=false` with a software warning naming that registry.
After each delivery, stopping only the task registry and using supported
`ha supervisor reload` restored `healthy=true`, `supported=true` and empty
unsupported/unhealthy resolution lists with the app healthy. The tester
independently observed the restored state after both 7 phases. No health checks,
resolution guards, auto-fix controls, GitHub repository settings or Docker daemon
trust settings were disabled or changed; support was **not** true throughout delivery.

The actual upgrade fixture had zero assignments/revisions/jobs and no established
publication. It demonstrates preservation of that real state, identity, key and
configuration, not migration of nonzero history or household playback. Historical
revision/recovery/concurrency guards remain separately covered by fixture tests.
The private synthetic-data preservation is not production backup/restore or
household migration evidence.

The implementer's frozen-content `make check build` run and the independent run
at build source `7b1d58b` passed 712 backend, 13 historical spike, 108 companion and 198 frontend tests,
lint/format/types and both builds. The 61 focused promotion tests and four
production modules' strict types passed. Independent checks additionally passed a
standalone image build plus HTTP/security/persistence/Chromium smoke, 20 compiled
local Ingress browser fixtures, separate bridge package/readback and nine extra
publication-boundary cases. Raw actionlint 1.7.12 exited 1 solely for its unsupported
`queue` key; the narrowly scoped supplemental check exited 0, with queue semantics
checked against [official GitHub documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
The raw failure remains a tooling limitation, not a passed raw check.

The independent tester reported **PASS for all six original #59 criteria** within
this agreed AMD64/isolated-delivery scope. Final evidence-prose readback, fresh
complete-issue review, final PR checks/rules and merge gates remain pending at
this dated checkpoint; this is not a reviewer `APPROVED`, merged or release-ready
claim. No hosted add-on release, GHCR publication, public Store deployment,
household operation or standalone retirement was performed or authorized by
these observations. Any future authorized promotion must use the original
archive and actual build source above; this or later prose must never rebuild 7.

## Future approved promotion

The dedicated [add-on workflow](../.github/workflows/publish-addon.yml) handles
published `addon-v` releases. Standalone releases and independently versioned
integration archives retain their existing workflows. The add-on lane never
builds an image: it loads and promotes the exact approved saved archive. Full CI
still builds/tests the standalone application to protect compatibility.

The following publication procedure is prepared tooling, **not authorization to
create a tag, release or registry image**. Obtain a separate release request for
the exact source, archive and channel first. Candidate 6 predates this workflow
and remains rehearsal-only. Candidate 7's actual build source contains the whole
workflow; any later authorized promotion must retain that exact source and its
original approved archive. Later documentation commits do not justify rebuilding
a known candidate. A future stable release first commits its unused
`X.Y.Z` packaging version and follows the same build-once path with
`addon-vX.Y.Z` / `--prerelease false`; it does not retag candidate bytes whose
embedded packaging identity differs.

1. Preserve the exact archive and seal from the first trusted build. Verify them
   with the independently recorded source and archive checksum. Complete actual
   isolated HA OS clean-install and same-channel upgrade verification, independent
   review and the release's required support/readiness gates. Those activities do
   not require public registry publication; disposable delivery evidence must
   clearly identify its registry-host substitution and limitations.
2. In a fresh input directory, copy the saved bytes to
   `jukelet-addon-image.tar` and their seal to
   `jukelet-addon-image.artifact.json`. Add the reviewed
   `jukelet-addon-verification.json` attestation described below. Keep evidence
   references sanitized; include no credentials or household identifiers.
3. Prepare and review an annotation JSON file using the schema below. It binds
   the full source, exact image, config digest and the three input assets' SHA256
   checksums and sizes. Use the first trusted archive checksum as independent
   authority; do not approve a replacement merely because its new sidecar agrees.
4. Only under the separate release authorization, create the annotated tag at the
   exact reviewed build commit. Push that one tag, create a draft with
   `--verify-tag --latest=false`, and attach exactly the three approved inputs
   without replacement. Read back their names, IDs, sizes, digests and bytes.
   Publish the draft with its matching candidate/stable prerelease flag and
   `--latest=false`. Never let `gh` create an absent tag from the default branch.
   The tag annotation is JSON only; lightweight, nested or moved tags are refused.
5. The published event validates the tag and inputs, invokes full CI and verifies
   the loaded image before the publishing job begins. That job repeats validation
   and the image probe before using registry credentials. The tag object and asset
   identities are checked again immediately before the exact single push.
6. Require successful effective registry and release-asset readbacks, then retain
   the generated receipt. A successful push alone is not completion.

These are the prepared CLI entry points used by the workflow, run from a trusted
checkout with full tag history. Each requires a fresh task-owned work directory:

```sh
python3 -m scripts.publish_addon validate \
  --event PUBLISHED_EVENT_JSON --source REVIEWED_COMMIT --work FRESH_VALIDATE_DIR
python3 -m scripts.publish_addon verify-image \
  --event PUBLISHED_EVENT_JSON --source REVIEWED_COMMIT \
  --expected-tag-object FROZEN_ANNOTATED_TAG_OBJECT --work FRESH_IMAGE_DIR
# Writes to GitHub/GHCR: only the authorized publishing job may run this phase.
python3 -m scripts.publish_addon publish \
  --event PUBLISHED_EVENT_JSON --source REVIEWED_COMMIT \
  --expected-tag-object FROZEN_ANNOTATED_TAG_OBJECT --work FRESH_PUBLISH_DIR
```

The annotation has exactly these fields. Replace every placeholder with reviewed
values and replace the sizes with actual integers; this is a schema example, not
an approval for these illustrative values:

```json
{
  "format_version": 1,
  "artifact": "jukelet-addon-promotion-approval",
  "source_commit": "FULL_REVIEWED_COMMIT",
  "image_reference": "ghcr.io/skoglump/jukelet-addon:0.1.0-addon.7",
  "platform": "linux/amd64",
  "image_id": "sha256:APPROVED_CONFIG_DIGEST",
  "assets": {
    "jukelet-addon-image.tar": {"sha256": "APPROVED_ARCHIVE_SHA256", "size": 1},
    "jukelet-addon-image.artifact.json": {"sha256": "APPROVED_SEAL_SHA256", "size": 1},
    "jukelet-addon-verification.json": {"sha256": "APPROVED_EVIDENCE_SHA256", "size": 1}
  }
}
```

The verification attestation has exactly `format_version: 1`,
`artifact: "jukelet-addon-verification"`, the seal's `source_commit`,
`archive_sha256`, `image_id`, `addon_version`, `platform`, plus `result: "PASS"`,
`reviewer: "APPROVED"`, `gates` and `limitations`. `limitations` is an array of
sanitized strings. `gates` has exactly `isolated_haos_clean_install`,
`isolated_haos_same_channel_upgrade`, `support_matrix` and `release_readiness`;
each contains `result` (`PASS` or `PENDING`) and a nonempty `evidence` reference.
Clean install and upgrade must pass for both channels. Stable releases require
every gate to pass; candidates may explicitly record pending matrix/readiness
work. No flag bypasses a stable gate. This is an owner-reviewed attestation bound
by the tag, not an automated re-execution or cryptographic verification of its
claims. A GitHub approval from another account remains separate from the agent's
internal `APPROVED` verdict when repository rules require one.

## Publication checks and limits

Only GitHub's exact published release and three uploaded input assets are
accepted. Their independent checksums, sizes, identities and downloaded bytes
must match. Existing output assets or a partial earlier publication block a
retry. The published release must report `immutable: false`, because receipts
can only be attached after their registry observations exist. If repository
policy enables
[immutable GitHub releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository#editing-a-release),
this workflow refuses publication before pushing; it does not change that policy.
Such a policy needs a separately
reviewed receipt-publication design.

Registry authentication and the exact tag absence check fail closed. An existing
tag, denied/ambiguous response, DNS/TLS failure or server error cannot mean
absence. Only the authenticated expected missing-manifest/repository response
allows the single push. The queue serializes this repository's sole publisher
without cancelling active or pending publication. The registry API provides no
atomic create-only tag guarantee here: an external writer could race the final
absence check. Exclude competing registry publishers and freeze approved GitHub
tag/asset writers throughout promotion; no claim of server-enforced tag
immutability or repository-settings change is made. An independent inert-fixture
probe moved the approval tag after the final preflight: one push could occur
before a later check rejected completion, with no success assets. The earlier
runtime-probe tag mutation was caught before registry HTTP/login/push. GitHub
approval state and the registry write are not one atomic transaction; late
mutation belongs to the partial-state reconciliation procedure below.

After the push, the tool reads the tag and digest manifests, hashes the actual
config and every layer body, verifies ordered uncompressed diffIDs, pulls by
digest and checks the resulting image. Docker stores differ: inspect `.Id` may
be a config digest or a manifest/index digest. The tool records that meaning and
independently hashes the loaded image's re-exported config; it does not equate
those identities. The dependency/provenance container probe has no network and
does not substitute for actual Supervisor installation evidence.

Three new output assets are attached exclusively, then downloaded and checked:
`jukelet-addon-registry.json`, `jukelet-addon-repository.zip` and
`jukelet-addon-output-sha256.txt`. The checksum list covers the receipt and ZIP;
the uploaded checksum file also receives its own checked GitHub asset digest.
The ZIP contains only the validated native repository metadata snapshot.
Attaching it does not register or deploy an HA Git repository. A public Store
repository delivery arrangement and household installation remain separate
approved deployment work.

Any failure after the push may leave partial registry/release state. Preserve the
run, inputs and observed digests; reconcile effective state before a separately
reviewed recovery action. Never rerun blindly, replace assets, repoint a tag or
rebuild the same candidate. GHCR publication and this hosted workflow have not
been exercised by preparing the tooling or by disposable registry evidence.
