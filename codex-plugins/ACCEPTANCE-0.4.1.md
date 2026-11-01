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

## Installation and native display follow-up

The formal GitHub marketplace installed code commit
`961bb6615973070279c11b636d64762718c1c723` as **0.4.1**. All **179** installed
file hashes match the generated package. Actual Desktop runtime discovery found
all five enabled skills and the versioned library entrypoint without a tools
error. No GitHub workflow was used.

After the user restarted Codex again, the existing chat's live `design_read`
succeeded. The new Desktop process read
`ui://codex-design/0.4.1/library`; at **2026-11-01 07:05:22 Asia/Shanghai**, the
real MCP stderr resource-read record reported plugin/UI version **0.4.1** and
the same HTML SHA-256 listed above. The log also recorded a widget frame commit;
no matching new frame-src block or guest-load failure was observed in that
checked log range. The investigator did not trigger a resource read to create
this evidence.

The user then confirmed that the artwork now displays normally. This closes the
reported blocked-artwork loading case for that observed page. It does not prove
all four editors, save/reopen, comments, worker recovery, references, native
downloads, import/export, language, theme or restart-recovery behavior. Those
cases remain in the real-host acceptance matrix in `NATIVE-TESTING.md`.

Retained installation evidence:
`codex-design-0.4.1-installed-verification.txt` and
`codex-design-0.4.1-installed-hashes.json` in the local acceptance archive.
