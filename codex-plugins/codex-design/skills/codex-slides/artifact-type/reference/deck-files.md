# A local deck's files

The deck lives in one user-project folder. Read this skill's SKILL.md for the full index and slide schemas.

- Keep the index in `project/deck.json` and each slide in `project/slides/<id>.html`. A slide contains exactly one section whose id matches its file name.
- Read current files before editing; preserve slide ids and index keys unrelated to the request. Speaker notes are plain text in one final `aside` per slide.
- Upload pictures and font files with `node "<this skill folder>/scripts/codex-artifact.mjs" upload <root> <file>`; use the returned asset URL.
- To install a design system, read its local README and tokens, copy the required files byte for byte into `project/ds/<namespace>/`, and add its record to `designSystems` in the current deck index. Use the user-provided local system folder as `artifact`, `version: null`, and the current time as `copiedAt`. Follow the namespace and font rules in SKILL.md.
- Add or remove slides by updating both their files and `order`; update section starts and the cover only when affected. Re-read the index immediately before changing it.
- Run `node "<this skill folder>/scripts/codex-artifact.mjs" check <root>`, fix reported problems, and inspect the changed output with available Codex preview tools. Start or reopen the editor with the same entry point's `open` command.
