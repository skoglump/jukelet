# Experimental local HA OS package (#58)

**Status: incomplete and blocked.** Local packaging, installation and initial
read-only operation have actual disposable HA OS evidence. The required
query-preserving redirect from a bare Ingress URL to its trailing-slash directory
fails on the tested Core version. This does not establish add-on support, release
readiness, migration readiness or household deployment. The
[accepted transition contract](33-ha-addon-transition.md) and
[browser mount requirement](10-development.md#browser-mount-paths-54) remain in force.

## Build a local package

The package reuses the root Dockerfile byte for byte, followed by a small add-on
stage. The stage selects the startup adapter and clears the standalone command.
The existing Dockerfile, Compose files and standalone app-secret workflow remain
the transition's standalone packaging.

From a reviewed commit, with the repository's pinned tools:

```sh
make addon-package
python3 scripts/package_addon.py --verify dist/addon/jukelet
```

These are the implemented packaging entry points. The actual installation below
used an explicit immutable source reference through the same builder. For a
fresh output directory, substituting an exact reviewed commit for `HEAD` when
needed:

```sh
python3 scripts/package_addon.py --ref HEAD --output dist/addon-rehearsal
python3 scripts/package_addon.py --verify dist/addon-rehearsal/jukelet
```

The builder reads committed Git blobs from a reviewed allowlist; working changes,
untracked files, deployment configuration, databases and secrets are excluded.
Missing, unlisted or nonregular build inputs fail closed. Output is a complete
`jukelet` directory with its build context, `config.json`, English option labels
and provenance. Existing destination directories are refused, including identical
previous output; retain that evidence and choose another fresh output directory.
The verifier checks the complete bundle against its recorded committed source.

Record `source_commit`, `source_tree`, `context_sha256` and the resulting local
image ID. The context digest covers the sorted file/checksum map, including
`build-info.json`; the image also carries provenance at
`/app/addon-build-info.json`. The raw `addon/local` source directory is a template,
not an independently installable add-on or a complete Docker build context.

Experimental versions use `0.1.0-addon.N`, increasing N for changed built candidate
bytes, including changed embedded provenance. The separate future registry
namespace is `ghcr.io/skoglump/jukelet-addon`. Local packaging publishes no image,
release or tag. Distribution/release isolation remains #59 work.

## Disposable local installation

Use only an explicitly authorized disposable HA OS installation. Transfer the
complete generated `jukelet` directory into Supervisor's local app directory,
reload the store, install `local_jukelet`, configure it and explicitly start it.
On the observed Supervisor 2026.10.5 system the host directory is
`/mnt/data/supervisor/apps/local/jukelet`; use the actual platform location rather
than assuming the older `addons/local` path. The recorded run used supported
Supervisor store/install/options/start controls. No add-on repository registration
or registry image is required; the manifest omits `image`, so Supervisor builds
locally from the generated context.

There are four production options:

| Option | Contract |
| --- | --- |
| `public_origin` | Required exact HTTPS origin used to open HA, including its port when needed; no path, credentials, wildcard or insecure development bypass |
| `additional_origins` | Up to eight distinct other HTTPS origins for the same HA installation; empty by default |
| `mode` | `read_only` by default; `manage` is an explicit choice independent of authentication and transport |
| `spotifyplus_entity_id` | Optional `media_player` entity for metadata through HA; empty by default |

Set the HTTPS origin before starting. Supervisor validates the schema, and the
startup adapter additionally applies the existing server configuration validation.
Invalid modes and HTTP origins were rejected by the actual tested Supervisor;
valid HTTPS options were accepted and read back. The manifest uses manual boot.
Installing, starting or selecting manage mode does not pair the bridge, activate
automatic publication, or dispatch playback.

The adapter explicitly selects `APP_RUNTIME=ingress` and
`HA_TRANSPORT=supervisor`. Supervisor supplies the server-only credential; direct
`HA_URL`/`HA_TOKEN` credentials must remain unset or empty. The package exposes no
token, secret, browser-prefix or arbitrary-command option. The
[existing trust/session boundary](10-development.md#backend-ingress-boundary-55)
and [transport boundary](10-development.md#supervisor-core-transport-57) apply.
The separate playback bridge and v1 wire contract are unchanged.

## Private state and runtime

Supervisor owns `/data/options.json`. A brief root bootstrap reads it without
changing its bytes or permissions, prepares only `/data/jukelet`, clears
supplementary groups, drops GID/UID to `10001:10001`, then replaces itself with one
Uvicorn worker on internal port 8000. The health probe also drops to that identity
before its bounded loopback liveness request. The app has no public port binding.

`/data/jukelet/jukelet.db` is the private SQLite database.
`/data/jukelet/auth-secret` is a generated persistent HMAC key, not a user login
option. The private directory is mode `0700`; the database and key are `0600`,
owned by `10001:10001`. Key creation is exclusive and atomic; existing valid key
and database bytes are retained. Unsafe types, symlinks, ownership, permissions or
invalid existing keys cause startup refusal rather than secret replacement or
recursive permission repair. Never share this database with a running standalone
writer. Full database transfer and backup/restore remain #60/#61 work.

On the observed system the options file is root-owned `0600`. The app user cannot
read it after bootstrap. The state probe records that expected denial and its
metadata; a separate authorized fixture operator fingerprints the options file.
Do not loosen its permissions to satisfy a probe. Comparing state across restart
or replacement requires the database publisher/schema observations, key
fingerprint and separate options fingerprint, not just an arbitrary sentinel file.

The manifest requests Core API access (`homeassistant_api`) and no Supervisor
management API, Docker API, host network, outward ports, additional maps, devices
or privileged capabilities. Actual candidate 1 inspection found no host port
bindings, added capabilities, device entries or extra device-cgroup rules.
Docker reported network mode `bridge`, with an endpoint on `hassio`.

Supervisor itself supplies `/data` read-write plus `/dev` and `/run/cid` read-only.
Those two platform mounts are part of the observed baseline, not additional
manifest maps. Supervisor's [pinned container setup](https://github.com/home-assistant/supervisor/blob/2026.10.5/supervisor/docker/app.py)
explains the default `/dev` mount. The server's effective, permitted, inheritable
and ambient capabilities were all zero; its supplementary groups were empty.
These observations describe the actual platform baseline, including its host
mounts, rather than claiming an entirely mount-free container.

## Recorded observations and remaining gate

The October 31, 2026 disposable target was **HA OS 18.4 / Supervisor 2026.10.5
stable / Core 2026.10.4**, **AMD64**, machine `qemux86-64`, with fixture HTTPS.
These are tested environment identities, not certified support minima. The
manifest retains Core **2026.10.3** as the accepted installation target; that
minimum Core version still needs add-on acceptance with #62. The Supervisor
2026.10.4+ source prerequisite for administrator metadata is distinct from a
tested support floor. Numeric OS/Supervisor support minima remain unestablished
while the routing gate fails; #62 must justify them. ARM64 is not advertised.

Candidate 1 identities:

| Identity | Value |
| --- | --- |
| Version | `0.1.0-addon.1` |
| Source commit | `8eaac9e3a961ea479e30416cbd4bad523b422ef3` |
| Context digest | `37afa7a2f3b41454ee7d0335e2a18968c335f78d788f3ba84093f77cf9e0368c` |
| Local image ID, not a registry manifest digest | `sha256:d6b4e753fe93d0e69b0afb459ec9d17d72317ba17fa53fcdb574b56f4ea7f2ca` |

Actual discovery, local build/install, option validation, startup and healthy
liveness were observed. The corrected read-only state probe observed schema
`0004`, integrity `ok`, a generated publisher identity, assignment revision zero,
zero assignments/jobs and publication neither established nor automatically
enabled. These are observations of this synthetic instance, not assertions that
every database should be empty.

The configured health-probe code was replayed in the actual container, observing
real UID/GID `10001` and empty supplementary groups before its loopback request.
A supported Supervisor stop produced complete application-shutdown logs and a
Docker die event with exit code zero. Supervisor removes the stopped container;
post-stop Docker inspection is therefore unavailable, rather than a separate
successful stopped-container observation.

A genuine Core-issued administrator Ingress session returned canonical-directory
HTML **200** and session API **200**, with `runtime=ingress`, `mode=read_only` and
the expected HA user. The actual bare base URL with escaped/repeated query values
returned **404**, without `Location`. This fails #58's canonical redirect criterion.
An earlier observation accidentally used metadata's double-slash URL and is
superseded by the check against the actual base prefix.

Candidate 1 also set `ingress_entry` to `/`. Supervisor already supplies that
slash and appends this field, producing `//`; see its
[pinned URL construction](https://github.com/home-assistant/supervisor/blob/2026.10.5/supervisor/apps/app.py#L597).
The **`0.1.0-addon.2`** correction omits the field and has a regression for the
generated effective URL. Its actual supported Supervisor update completed and
reported a single-slash Ingress URL, sidebar enabled, and a passing state probe.
Schema, publisher identity, key fingerprint, assignment revision/rows and selected
publication state/jobs were preserved from candidate 1.

| Candidate 2 identity | Value |
| --- | --- |
| Source commit | `1d5b48b5c9299a7c76a518ffc509e41cec98f692` |
| Context digest | `68d2d6005286dbeae55efc25f9011ba997eaf9b512b3f63c6d486232bbe8bbf1` |
| Local image ID | `sha256:27381624f44ba8975938199033033b094edbb3af35fe55ea1e70387eded8cd9e` |

The initial browser probe on candidate 2 failed at its sidebar selector. An
independent normal HA login found one visible semantic link named exactly
`Jukelet` and opened its Ingress iframe. The probe's obsolete hard-coded href
`/hassio/ingress/local_jukelet` did not match the actual HA sidebar route,
`/local_jukelet`; that harness failure does not establish a missing product
sidebar. The repaired probe selects the exact semantic link and retains every
interface, session, asset, Core and canonical-redirect assertion. Actual rerunning
of those stages is still required.

**`0.1.0-addon.3`** is prepared for the new source/provenance bytes, with no built
or installed candidate 3 claimed here. Record its final immutable source,
context, image and actual retest separately. Earlier candidate observations do
not establish final-candidate acceptance.

The independent bare-URL failure remains: the tested
[Core Ingress route](https://github.com/home-assistant/core/blob/2026.10.4/homeassistant/components/hassio/ingress.py)
requires the slash. Core returns 404 before forwarding that request, so the
root-mounted backend cannot supply its missing redirect. No external proxy shim,
upstream modification, browser-base setting or authentication inference has been
implemented. A reviewed resolution that satisfies the accepted redirect/query
contract is an unmet prerequisite; the requirement has not been removed.

The opt-in container/browser probes use only the explicitly configured disposable
fixture, bounded redacted observations and normal synthetic HA login. Browser
candidate identifiers require a separate operator binding to the actual container.
Container replacement/persistence, Core-down startup/reconnect and full
sidebar/browser evidence require their own actual records; passing unit or
fixture-browser tests does not establish them. The full
manager, identity and compatibility matrix remains #62 work.

Issue #58 remains incomplete and must not merge while the routing gate is unmet.
The dependent sequence cannot advance past it. Standalone support, household
deployment, release publication, cutover and #65/#66 retirement gates retain their
existing authorization and verification boundaries.
