# Experimental local HA OS package (#58)

**Status: candidate 5 actual native-routing/lifecycle checks PASS; independent
issue acceptance and review pending.** Local packaging, installation and read-only
operation have actual disposable HA OS evidence. On October 31, 2026 the owner
explicitly selected native HA Ingress,
accepting a fail-closed bare-URL 404 without Jukelet HTML/bootstrap or app
asset/API requests. [D16](08-decisions-and-risks.md#accepted-decisions) amends the
earlier unconditional redirect criterion; its recorded failure remains historical
evidence, not a new PASS. No external proxy is a deployment prerequisite. A proper
canonical redirect still conforms. The canonical HA-provided trailing-slash entry,
query preservation, prefixed requests and existing authentication boundaries
remain required. Candidate 5's new observations below demonstrate this clarified
contract without relabeling earlier results. This does not establish release
readiness, migration readiness or household deployment.

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
Use **HA OS 18.4 / Supervisor 2026.10.5** as conservative minimum versions for
this experimental AMD64 package: this is the first disposable pair with actual
local install/options, lifecycle, administrator identity and initial native
Ingress evidence. Older pairs remain untested, rather than declared incompatible.
The Supervisor 2026.10.4+ source prerequisite for administrator metadata is
distinct from this tested floor. The manifest retains Core **2026.10.3** as the
accepted installation target; actual package evidence so far uses **2026.10.4**.
Minimum-Core acceptance and the full manager/custom-command/security compatibility
matrix remain #62 work. Candidate 5's actual native-routing proof is recorded below.
This floor selection does not certify every later version or ARM64, nor satisfy
the separate backup, recovery, migration and household cutover gates.

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
returned **404**, without `Location`. This failed #58's original canonical
redirect criterion; it was not a successful canonical navigation.
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
sidebar. Candidate 3 fixed that selector, but the full probe still failed at the
inherited raw-text assertion: the link has an exact accessible name and is
visible, while its raw anchor text is whitespace. The final harness correction
checks the exact accessible name and visibility with the same 30-second bounds;
every later assertion, timeout and navigation remains in place.

| Candidate 3 identity | Value |
| --- | --- |
| Source commit | `5c571f0ae61cd476e84264dbab71ebc5f488e168` |
| Context digest | `eb1defb42803c6716ec10a5a0a2d203a85817131b82383aa103d368a1b460758` |
| Local image ID | `sha256:2f47dcbf5aae9a3aa1008503d81a638d676c4769846169a57fc69eee1196d3b2` |

Candidate 3's actual Core-down start remained healthy with liveness 200; effective
readbacks confirmed Core was stopped before and after app startup. The replacement
container used the same image and preserved schema, publisher/key fingerprints,
selected assignment/publication state and the separately observed options
bytes/owner/mode. Core was restored with CA/hostname-verified HTTPS 200.

An independent real-browser observation on candidate 3 used the exact accessible
link and opened one canonical iframe. It confirmed the manager heading, read-only
badge, absent app-secret form, session 200 in Ingress/read-only mode with a HA
identity, connected Core, CSS/JavaScript 200 under the prefix, and zero escaped,
external or app-write requests. It then observed canonicalization 404, no redirect
and no trailing slash, with the query preserved. These are separate diagnostic
observations; the original full probe result remains **FAIL at sidebar**, not PASS.

**`0.1.0-addon.4`** was subsequently built, installed and independently tested.
This corrects the earlier preparation-only prose without replacing those older
observations:

| Candidate 4 identity | Value |
| --- | --- |
| Source commit | `1b6701d779f16c373450d4b8ccc36c9f92b9b1ea` |
| Context digest | `979f3aeef217f44fa97c648bf358973eee1562fcffbfb5238d8d8b7dcb59cb29` |
| Local image ID | `sha256:c96faa668e3430647c958a90e2f78dde84275224a02cbf227bf2c3e7464b98a2` |

The actual state probe passed; schema, publisher/key fingerprints, assignment
revision/rows, selected publication state/jobs and options fingerprint were
preserved from candidate 3. The final tracked browser probe passed TLS, the exact
accessible and visible sidebar link, manager/read-only/no-secret UI, Ingress
session, Core connection and prefixed CSS/JavaScript assertions. It then returned
**FAIL at `canonical_slash_query`**: bare URL 404, no redirect, no trailing slash,
query retained on the rejected URL. That result remains FAIL against its original
criterion.

The routing explanation remains: the tested
[Core Ingress route](https://github.com/home-assistant/core/blob/2026.10.4/homeassistant/components/hassio/ingress.py)
requires the slash. Core returns 404 before forwarding that request, so the
root-mounted backend cannot supply a redirect. The owner first approved a proxy
proposal, then asked why it was needed for normal add-ons. After the distinction
was explained, the owner explicitly chose native Ingress and accepted fail-closed
404 for this bare address. The unused proxy proposal was archived outside the
delivered source; no proxy, upstream modification, browser-base setting or
authentication inference was installed. Generic proxies that serve HTML at the
bare address still require a canonical redirect; existing fixture 308 regressions
are unchanged.

**`0.1.0-addon.5`** was built and installed from the following immutable source.
It retains the single-slash Supervisor entry by omitting `ingress_entry`.

| Candidate 5 identity | Value |
| --- | --- |
| Source commit | `4bee87e7d1e88702eca79f077e792636e75337b9` |
| Source tree | `9b3e8a79b4890b609005944b6a84f14eeec435f2` |
| Context digest | `856de041b412205c9c051173abd22edca6028d3f5b966e996c3ddf6bdd85b506` |
| Local image ID | `sha256:b704e5719876251f794a3f9e5151eb19b0c822af1ef0a5ca70ddf29c48476784` |

The image's embedded provenance matched the generated context. The actual state
probe passed, with schema `0004`, integrity `ok`, liveness 200 and runtime
UID/GID `10001:10001`, empty supplementary groups and zero effective, permitted,
inheritable and ambient capabilities. Private state retained its documented
permissions; Supervisor-owned options remained unreadable to the app user.
Update from candidate 4 preserved schema, publisher/key fingerprints, assignment
revision/rows, selected publication state/jobs and the separately checked options
fingerprint. Publication remained unestablished and disabled, with no assignments
or publication jobs in this synthetic instance. Container inspection again found
no public port bindings, host network, extra capabilities, devices or privileged
mode; mounts remained the documented Supervisor `/data`, `/dev` and `/run/cid`
baseline.

The full tracked Chromium probe returned **PASS** for candidate 5. It verified
CA/hostname TLS and the pinned browser certificate, the exact accessible and
visible Jukelet sidebar link, manager heading/read-only/no-secret UI, session 200
with `runtime=ingress` and the HA user identity, connected Core, and CSS/JavaScript
under the Ingress prefix. There were zero escaped, external or app-write requests.
The canonical directory with repeated and escaped query values returned **200**,
without a redirect and with the query preserved. The bare address returned
**404**, without `Location` or a redirect; the same-origin path/query remained
unchanged, with no HTML/bootstrap and zero subresource requests from the newly
committed document. Returning to the canonical address restored manager/read-only
UI and session **200** with the expected runtime and identity. This is new evidence
against D16, not a correction of the old probe's recorded FAIL. Its redacted report
contains no response bodies, Ingress tokens or user identifiers.

A subsequent candidate 5 lifecycle run also returned **PASS**. Supported stop
produced complete shutdown logs and a matching Docker die event with exit code
zero. Core was effectively stopped before app startup, after startup, and after
state/health readback; CA-verified HTTPS was unavailable at all three observations.
The replacement app container used the same candidate image, remained healthy and
returned liveness **200** with Core stopped. Schema, publisher/key fingerprints,
assignment revision/rows, selected publication state/jobs and options
bytes/owner/mode/size were preserved. Core was then restored and returned
CA/hostname-verified HTTPS **200**; the app state probe still passed. These artifact
identities remain authoritative after subsequent documentation-only updates.

A fresh independent tester repeated the candidate 5 full browser PASS and
read-only version, replacement-container, source/image, state, permissions and
options observations. Final documentation verification, fresh review and PR gates
remain separate from those demonstrated results.

The opt-in container/browser probes use only the explicitly configured disposable
fixture, bounded redacted observations and normal synthetic HA login. Browser
candidate identifiers require a separate operator binding to the actual container.
Candidate 5's records above come from actual HA OS/Supervisor operation, separately
from unit and fixture-browser checks. The browser scope was one synthetic
administrator and desktop Chromium. The full manager, identity, mobile and
compatibility matrix remains #62 work.

Issue #58 still requires independent verification/review and all PR gates before
completion or merge; these actual observations do not assert those outcomes.
The dependent sequence cannot advance past it. Standalone support, household
deployment, release publication, cutover and #65/#66 retirement gates retain their
existing authorization and verification boundaries.
