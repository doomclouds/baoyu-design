# Opaque editor capability audit

Read-only inspection of the four canonical editor bundles on 2026-11-01.
This records source behavior, not proof that a feature failed in the running
Codex host. No production changes were made for this audit.

## Clipboard

- All four editors implement plain-text copying with an attempted
  `navigator.clipboard.writeText`, followed by a selected temporary textarea
  and `document.execCommand("copy")` in a catch fallback. A failed primary
  API is therefore not sufficient evidence of broken text copying.
- Canvas image/HTML rich clipboard helpers explicitly require `ClipboardItem`
  and `navigator.clipboard.write`, returning `refused` when unavailable.
  They do not provide a binary clipboard fallback through execCommand.
  Canonical Canvas `index-9BhYeCfK.js:28081`.
- Canvas's inspector `Copy declaration` callback directly attempts optional
  `navigator.clipboard?.writeText` and suppresses errors. It does not call
  the general textarea fallback. Canonical Canvas `index-9BhYeCfK.js:28100`.
- Canvas element copy keeps an internal `setElementClipboard` buffer when the
  system clipboard is absent or rejects writing. Corresponding paste paths
  select that buffer through `getActiveClipboardSource`.
  Canonical Canvas `index-9BhYeCfK.js:28120`.
- Canvas also consumes real manual paste events and `clipboardData`, registering
  its outer `window` paste listener at `index-9BhYeCfK.js:28262`; the embedded
  DC runtime registers `onEditorPaste` at line 13111. A context-menu paste action
  without an actual paste event has an async `readText` path that falls back to
  an empty string, while internal clipboard data can still be available.

Useful consuming-browser checks: text Copy on each editor; Canvas Copy
declaration; Canvas Copy as PNG/SVG/HTML; internal copy/paste; a real manual paste
of known fixture text. Do not replace existing fallbacks based only on an absent
clipboard property.

## Storage

The inspected `localStorage`/`sessionStorage` get/set/remove callsites use
try/catch or safe access wrappers. This includes local layout preferences,
style clipboard, remembered canvas position, edit counts, and draft/reload
state. No additional unhandled storage boot access was identified in this
inspection. Denied storage may lose these preferences even when it does not
crash. The native transport's existing scoped storage handling is owned by
the editor integration work.

## Web Crypto

Several source paths need `crypto.subtle` without a hashing fallback:

| Editor | Canonical source | Observed use |
|---|---|---|
| Design System | `index-BBq8YM1-.js:528`, callers at line 780 | `sha256Hex(bytes)` for deduplicating uploaded assets on the blob-storage route. Small inline-only uploads need not reach this route. |
| Dashboard | `index-BX9MvuwQ.js:548`, caller at line 553 | `hashVersionDocument` / `snapshotVersionDocuments`, called by the original version-history writer. |
| Canvas | `index-9BhYeCfK.js:28216`, caller at line 28162 | `verifyExportAssetIntegrity` hashes bundled runtime dependencies during standalone HTML export. |

Canvas's separate REPL runtime verifier checks for `crypto.subtle` and returns
false when missing (`index-9BhYeCfK.js:28348`); this differs from the unguarded
export helper above. Slides contains no direct `crypto.subtle` call in the
inspected main bundle.

The important runtime checks are a Design System asset upload that actually
uses blob storage, a Dashboard edit that creates an original history record,
and Canvas standalone HTML export. These checks must establish whether the
new execution context affects the path before adding compatibility code.

## WebCodecs

Slides bundles video/audio encode and decode support. Its capability checks
test `typeof VideoEncoder`, `AudioEncoder`, `VideoDecoder`, and `AudioDecoder`,
returning unsupported when absent. Encoder construction also has explicit
unsupported errors and supports registered custom encoders. The other three
main editor bundles contain none of these four constructors. No new codec
polyfill is justified by this source inventory alone.

## Scope

Native UI rendering, manual copy/paste, real output bytes, and browser codec
support remain consuming-runtime checks. The source findings above must not be
reported as completed runtime failures or completed runtime verification.
