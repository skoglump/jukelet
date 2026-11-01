# Disposable native acceptance helpers

These files are test infrastructure for the fixed
`jukelet-m5-issue62-matrix-kvm` VM. They are excluded from the add-on build context
and the separately packaged bridge. Never install the fixture component in a
household HA configuration. Local tests do not establish native acceptance.

`python -m scripts.haos_acceptance validate CONFIGURATION` checks declarations and
private input metadata only. The configuration must be a direct child of
`/tmp/jukelet-issue62-matrix-control` (mode `0700`). Its regular file must be
single-link, owned by the current user and mode `0600`. It declares:

```json
{
  "schema_version": 1,
  "fixture": "jukelet-m5-issue62-matrix-kvm",
  "synthetic": true,
  "origin": "https://127.0.0.1:18223",
  "proxy_origin": "https://127.0.0.1:28223",
  "qmp_socket_file": "qmp.sock",
  "admin_credentials_file": "credentials-admin.json",
  "denied_credentials_file": "credentials-denied.json",
  "certificate_file": "fixture.crt",
  "candidate": {
    "source_commit": "EXACT_40_LOWERCASE_HEX",
    "context_sha256": "EXACT_64_LOWERCASE_HEX",
    "image_config_digest": "sha256:EXACT_64_LOWERCASE_HEX",
    "image_manifest_digest": "sha256:EXACT_64_LOWERCASE_HEX"
  },
  "bridge": {
    "source_commit": "EXACT_40_LOWERCASE_HEX",
    "archive_sha256": "EXACT_64_LOWERCASE_HEX"
  }
}
```

Replace identity placeholders with recorded immutable identities; they are
deliberately invalid inputs. `proxy_origin` may be `null`. References are fixed-root
basenames. Credential files require private regular single-link metadata; this
command does not read their values. The certificate may be `0600` or `0644` within
the private root. The QMP socket must be owned and inaccessible to group/others.
This command neither contacts QMP/HA nor proves the declared artifact identities.
Its report explicitly retains `native_acceptance: NOT_RUN`.

The coordinator separately installs the three files under
`fixture/custom_components/jukelet_acceptance/` in the new disposable HA config and
adds this explicit YAML opt-in:

```yaml
jukelet_acceptance:
  fixture: jukelet-m5-issue62-matrix-kvm
  synthetic: true
```

The component refuses existing SpotifyPlus services or its synthetic entity.
It registers six bounded synthetic metadata services, with no provider account,
network client or image URL. Set the app's metadata entity option to
`media_player.jukelet_acceptance`. Actual HA loading and Supervisor-issued
credential authorization must be recorded separately; they are not proved by
these local tests.

The authenticated administrator-only `jukelet_acceptance/control` WebSocket command
supports only `action: status`, `action: metadata` with mode `fresh`, `unavailable`
or `malformed`, and `action: scan` with one of the exact `policy.TAGS`. Scans use
the supported HA tag producer and the fixed synthetic reader. It does not enable
dispatch, configure a bridge profile or publish a snapshot.

`policy.script_document()` returns the exact configuration for
`script.jukelet_issue62_inert`: variables followed by a correlated v1 stop response.
There are no service, network, media or nested-script actions. The fixture observes
only calls to that script, retains at most 32 strictly synthetic requests and counts
unexpected requests without retaining their values. Combine this independent
fixture observation with bridge-correlated completion and idle/fence readback;
neither proves household playback. The status always reports independent playback
verification as unavailable.

## Initial native browser phase

After the coordinator has verified the named VM, installed the exact artifacts and
configured the app in `manage` mode, run:

```sh
node scripts/haos_acceptance/browser.mjs read-only \
  /tmp/jukelet-issue62-matrix-control/acceptance.json --seed-expiry
```

The phase performs read-only operations against the manager. It checks the actual
QMP name/running state, verifies CA and hostname, pins Chromium to that certificate's
SPKI, then uses normal HA login and the sidebar. Only same-origin reads, HA login
POSTs and the side-effect-free metadata preview POST are permitted. The real HA
WebSocket is transparently forwarded; no responses or identity are fabricated.
Playwright is imported only when this explicit phase runs. Local backend tests and
module imports work without frontend/browser dependencies.

The two dedicated browser credential files have exactly these fields:

```json
{
  "schema_version": 1,
  "fixture": "jukelet-m5-issue62-matrix-kvm",
  "synthetic": true,
  "origin": "https://127.0.0.1:18223",
  "role": "administrator",
  "username": "GENERATED_SYNTHETIC_USERNAME",
  "password": "GENERATED_SYNTHETIC_PRIVATE_PASSWORD"
}
```

Use the generated actual administrator for `administrator`, and a separately
created actual nonadministrator for `denied`. Never add API access/refresh tokens.
The browser phase reads only the selected dedicated file after VM/TLS checks;
public output contains no password, cookie, CSRF token, raw user ID or Ingress URL.
The denied identity and later manager/security/restart scenarios are separate
phases; this initial checkpoint does not claim them.

`--seed-expiry` is optional and explicit. It captures only the exact generated app
cookie and the secure, Strict `ingress_session` cookie for `/api/hassio_ingress/`,
then closes the browser completely. Only after closing does it exclusively create
private `expiry-seed.json` (schema 2) in the fixed control root, with those two
cookies and corresponding identity/path/deadline metadata. Existing seeds are never
overwritten. It exports no full browser storage or HA access/refresh token.

Supervisor 2026.10.5 uses a
[15-minute sliding session lifetime](https://github.com/home-assistant/supervisor/blob/fdba115f215c61f7a02c7c0567263785cfcf0034/supervisor/ingress.py#L134).
Proxied requests renew it, and the HA frontend parent
[validates its session every minute](https://github.com/home-assistant/frontend/blob/901c0a61ad44c7f52f50a986f6b5a81371f97a0a/src/panels/app/ha-panel-app.ts#L229).
The browser's closing time is therefore a conservative last-touch upper bound for
the captured Supervisor credential O. The public report contains only hashes and
timestamps, including replay-not-before **16 minutes after closure**, with natural
Supervisor expiry **PENDING**. It does not claim eight-hour app-session expiry or
spontaneous expiry while a live parent keeps renewing its credential.

After the recorded deadline, the separate opt-in phase is:

```sh
node scripts/haos_acceptance/browser.mjs expiry-replay \
  /tmp/jukelet-issue62-matrix-control/acceptance.json
```

It validates the exact private seed schema, configuration identity and conservative
deadline before QMP, TLS, credential values or browser activity. An early invocation
fails with `expiry_replay_too_early`; it does not wait or retry. Use the original
configuration and same actual administrator. The phase first establishes a normal,
independently valid context N through HA login/sidebar and repeats the positive
native manager, metadata and asset checks. It binds the same principal and prefix,
requires fresh N cookies, and replaces only N's Supervisor cookie with retained O.
It makes no test request after injection: the first completed O-bearing ordinary
protected GET (inventory, connection, publication, playback or capabilities poll)
must receive the actual
[Supervisor 401 before forwarding](https://github.com/home-assistant/supervisor/blob/fdba115f215c61f7a02c7c0567263785cfcf0034/supervisor/api/ingress.py#L175),
then remove the manager DOM without a standalone form. The report records endpoint
categories, request ordering and cookie hashes. A prior in-flight N response cannot
satisfy the denial; O returning success, changed app cookies, unexpected reads or
session bootstrap fail the case. No response body, raw header, URL, stack or HAR is
retained. The before-app location is a **source-backed causal inference** from the
only-cookie change and pinned Supervisor validation code; the harness does not
claim to observe an app-backend denial log.

The negative case ends at denial and the DOM fence, then closes the browser without
clicking “Check access again,” changing credentials/transports or retrying through
another account. The original seed remains unchanged. This is a
**natural Supervisor-expired-credential replay**,
with no clocks, database rows or API responses altered. It is not a natural
eight-hour app-backend expiry claim. A future app-cookie expiry probe must also
distinguish lookup expiry from expired-row cleanup by any new session creation.
Actual native results and all remaining criteria require separate retained evidence.

## Network isolation and the bounded HA-parent warning

Service workers remain blocked so the browser's request guards can observe and
abort outside requests. Playwright 1.64.1's
[registration override](https://github.com/microsoft/playwright/blob/v1.64.1/packages/playwright-core/src/server/browserContext.ts#L173)
resolves registration without a result. The pinned HA frontend
[uses the registration's `addEventListener`](https://github.com/home-assistant/frontend/blob/901c0a61ad44c7f52f50a986f6b5a81371f97a0a/src/util/register-service-worker.ts#L136),
and its [error logger](https://github.com/home-assistant/frontend/blob/901c0a61ad44c7f52f50a986f6b5a81371f97a0a/src/resources/log-message.ts#L65)
can attempt an original-source lookup. The owned minimum-Core investigation
confirmed that specific parent-only TypeError and one blocked lookup, with no
Authorization header, Cookie header or query string. This is a harness artifact;
normal HA service-worker registration is not certified by this run.

The assessment accepts either all-zero counters or only that complete known pair:
one exact undefined/`addEventListener` TypeError from recognized HA-parent app
assets, and one still-aborted parent GET/XHR for the canonical original
`register-service-worker.ts` path at a numeric frontend version. Its observed
headers must be available and contain no Authorization or Cookie; no query,
overflow, extra request, unknown/mixed/app error or Ingress escape is accepted.
All outside requests stay blocked; no response or identity is fabricated.

Reports retain the actual global counts. A separate `expected_fixture_warning`
and explicit zero app/unexpected-error assessment avoid presenting the known
parent warning as zero global errors. All original issue criteria, independent
verification and final review requirements remain unchanged.

The snapshot helper awaits the existing inbox registry-refresh response before
reading the inventory cache. The UI's count and exact opaque-ID assertions remain;
this does not change application refresh behavior or replace native HA responses.
