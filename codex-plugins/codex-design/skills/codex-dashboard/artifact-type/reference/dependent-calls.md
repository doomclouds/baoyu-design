# Data that needs an earlier answer

A local dashboard loads attached CSV, TSV or JSON snapshots. It does not execute connector queries or dependent tool calls in the viewer, and its datasets must not use `source: {kind: "query"}`.

1. If obtaining the requested data needs an earlier answer, use tools already available and authorized in the Codex chat to obtain that answer first. Read the actual returned schema and preserve the type of a date, id or number; do not guess a later argument or treat a valid zero/false value as missing.
2. Validate the required value, then run the dependent retrieval with that value through the same authorized data workflow. If the prerequisite is absent, stop that retrieval and explain which result is missing. No viewer connector, shared credentials, certified-query rules or scheduled service is created.
3. Materialize each needed result as a local CSV, TSV or JSON file, upload it through `codex-artifact.mjs upload <root> <file>`, and write a file-backed dataset with its real source description and update time. See `sources.md` and SKILL.md for the supported source shape and `write-db` calls.
4. For interactive choices over the attached rows, use `dash/params`, `dash.params()` and the supported local calculations/filtering. A parameter change filters a snapshot; it does not rerun the original remote call. Keep that distinction clear when handing over.
5. Refresh the dependency chain in the chat when the user requests fresh data, then upload and update the affected file sources together. Keep their dates/ids consistent, preserve unrelated documents, run the built-in check and report the snapshot time. Do not introduce `connector`, `tool`, `args`, `rules` or a loader solely to imitate a hosted-query example.

If one authorized retrieval can produce the complete result, prefer it over a dependent chain. The Sources panel must still trace every displayed value to the files actually attached.
