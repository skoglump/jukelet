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
