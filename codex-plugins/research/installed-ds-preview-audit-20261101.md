# Installed design-system preview audit

Read-only canonical-source audit on 2026-11-01. No runtime success is inferred
from these source paths, and no production code was changed.

## Canvas already materializes its ordinary copied dependencies

Canonical source: `skills/claude-design/scripts/editor/assets/index-9BhYeCfK.js`.

- Line 28126: `ArtboardFrame` invokes `buildPreviewDocument` with its project
  dependency closure, `createProjectAssetReadinessProbe`,
  `resolvePublishedDesignSystemFile`, and `createLinkedFileScript`.
- Line 28020: `buildPreviewDocument` runs `collectProjectDependencyFiles` and
  `rewritePreviewAssets`, places the resulting dependency text in
  `window.__dcFiles`, and constructs the preview document. Large files can be
  transferred through the existing two-phase runtime parts mechanism.
- Line 27995: `rewriteHtmlDependencies` resolves a stylesheet against the
  artboard path; when that CSS exists in the project map it inlines
  `inlineStylesheetImports` into `<style>`. Classic local JavaScript becomes
  `__dcRun("resolved/path.js")`; module scripts use the runtime import-map path.
- Lines 16161–16248: `__dcRun` reads `window.__dcFiles`. Its recovery path makes
  a script whose text is the existing file content. Thus the canonical classic
  component bundle path already has a text fallback if a Blob script fails.
- Line 28126: `createProjectAssetReadinessProbe` returns without a URL provider
  when `globalThis.origin` is missing or `"null"`.
- Line 27915: `resolvePublishedDesignSystemFile` also returns without a URL when
  the origin is missing or `"null"`. The installed local/opaque case therefore
  does not select its published HTTP URL optimization.
- Line 15543: the preview fetch wrapper `__dcLookup` reads the existing
  `window.__dcFiles` for local requests before delegating to the original fetch.

For an ordinary copied `ds/<namespace>/components/bundle.css` and classic IIFE
`bundle.js`, this is evidence that the original editor already packages those
files for the preview. It is not a reason to grant arbitrary project-file reads
to authored preview JavaScript. Arbitrary ESM dependency graphs have a different
import-map/Blob path and are not established by the classic-IIFE evidence.

## Fonts require separate evidence

- Canvas `rewriteProjectAssets` at line 27991 replaces local image references
  with data URLs, but its supported extension pattern is
  `png|jpe?g|gif|webp|avif|bmp|svg`, not `woff`, `woff2`, `ttf`, or `otf`.
- `inlineStylesheetImports` at line 27994 invokes that image rewrite and
  recursively inlines local CSS imports. It does not establish that every
  relative copied font URL is converted to data.
- The skill reference
  `skills/claude-design/artifact-type/reference/design-system-components.md:49`
  describes loading the copied CSS/JS. Its following paragraph explicitly says
  fonts held by upload ID must be uploaded into the consuming artifact and
  referenced using that returned `/_blob/` URL.
- The current preview prelude in `source/scripts/editor-native-transport.js`
  only resolves `/_blob/<32hex>` image/font references; its child fetch bridge
  permits read-only Blob/data/upload references. A raw relative font request
  is not proven to pass this resolver.

Slides has an explicit copied-font path: canonical
`skills/claude-slides/scripts/editor/assets/index-RJQpopVD.js:3603`
tracks `project/ds/<namespace>/` fonts from the file-port listing and
`loadSystemFontFiles` uses `fetch(src).arrayBuffer()` followed by
`new FontFace(family, bytes)`. That fetch occurs in the main editor transport,
not through the Canvas preview's raw DOM URL loader. This source path supports
a focused test of the existing artwork-scoped project route; it does not call
for unrestricted filesystem access.

## Existing fixture limits

The repository's `codex-plugins/examples/design-system/project/` contains the
Nimbus classic bundle and CSS. Its README explicitly uses system fonts and
requires no font download. The existing example Canvas and Slides indices have
empty `designSystems` arrays. The inspected global sample Canvas also has an
empty list. Those examples therefore do not constitute an installed-system
or copied-font runtime test.

The minimal useful fixture is a copied Nimbus classic bundle linked from a
Canvas artboard, plus an uploaded `/_blob/` image/font. Test a real copied
relative font separately before adding any narrowly scoped materialization.

## React srcDoc bypass is confirmed

Canonical Canvas React DOM:

- `index-9BhYeCfK.js:28126`: main preview uses JSX iframe `srcDoc: Qe`.
- Line 28134: drag preview likewise uses `srcDoc: n.srcdoc`.
- Line 9: the React property switch has no `srcDoc` case and takes the generic
  `K=mn.get(K)||K; ze(P,K,te)` branch.
- Line 8: `ze` uses `P.setAttribute(I,K)`; the alias table contains no srcDoc
  entry. Consequently React writes the attribute rather than assigning the
  JavaScript `.srcdoc` property.

Canonical Slides instead directly uses `g.srcdoc=y` at
`index-RJQpopVD.js:1191`; the exported viewer similarly writes `.srcdoc` at
line 3235. The module has no JSX `srcDoc:` occurrence.

At inspection time, the native transport wrapped only the
`HTMLIFrameElement.prototype.srcdoc` property setter. A minimal compatibility
change must also handle `Element.setAttribute` when the receiver is an iframe
and the attribute name is case-insensitively `srcdoc`. It should use the same
single idempotent prelude injection and preserve the original source value,
leaving every other element/attribute unchanged. This finding does not justify
any host UI or filesystem permission change.
