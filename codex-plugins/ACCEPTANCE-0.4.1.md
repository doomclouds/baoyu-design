# Codex Design 0.4.1 native startup follow-up

The user restarted Codex and reported that the library opens but artwork frames
show Chromium's blocked-content page. Live `design_read` in the existing chat
now succeeds. The earlier disconnected-chat blocker is resolved.

The installed Desktop log records HTTP localhost frame navigation blocked by
both the remote frame CSP and a `frame-src 'none'` policy. This proves the
attempted HTTP path failed; it does not prove that the opaque data-shell path
failed. Generated and installed 0.4.0 HTML bytes match and contain the native
branch. The exact reason that the running view selected the old HTTP path is
not yet established.

The host's resource query key includes connection, URI and plugin revision.
Persisted entrypoint/resource startup fallback exists. No cache was deleted,
host policy changed, debug endpoint enabled, or private host API used.

## Patch and regression scope

- Library/file resource URIs include `0.4.1`, independently identifying the new
  resource from earlier stored snapshots.
- The native entrypoint only reuses a current-version, available MCP bridge
  with inline-editor support. Legacy bridges and HTTP preview endpoints cannot
  select the HTTP editor path inside the native view.
- Standalone previews keep their explicit bridge/endpoint behavior.
- UI resource reads emit only server/plugin/UI version, resource URI and the
  actual served HTML SHA-256 on stderr. They do not log artwork, paths or tokens,
  and they do not add output to ordinary model tools.
- Host CSP permissions and the editor's origin isolation remain unchanged.

## Frozen package validation

- Full local suite: **206/206 passed**, zero failures, skips or cancellations.
  Retained log: `codex-design-0.4.1-tests.txt` in the local acceptance archive.
- Generated-package consistency: **179 owned files**, current.
- Portable relocation: passed with generic `node`, a Unicode/space-containing
  directory, no `node_modules`, five tools and two resources.
- Advertised library resource: `ui://codex-design/0.4.1/library`.
- Bundled UI SHA-256:
  `1e52c6e33acb664e8edcbe0f3902ce87c38a25f7b6a386ae50bfb791c0c2ce6b`.

GitHub installation and actual native rendering remain pending. Native rendering
is unverified until a real artwork page is observed using the new resource;
protocol checks are not a visual pass.
