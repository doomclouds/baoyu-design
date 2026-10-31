# Local dashboard data sources

Local dashboards read attached CSV, TSV, or JSON files. Every dataset uses a file source and records its title, origin, and last update.

1. Obtain the user's file or gather the requested rows with tools available in this Codex chat. Describe the origin accurately; do not invent data.
2. Save the data in the user project and run the bundled `codex-artifact.mjs upload <root> <file>` command.
3. Use the returned URL in `datasets/<id>` with `source: {kind: "file", url, name}` and `updated: {at, by}`. Write documents with `write-db` as described in SKILL.md.
4. Bind charts and values to dataset rows using the supported data marks and calculations. Keep the Sources panel usable so numbers can be traced to the attached data.
5. When the user asks to refresh, obtain fresh data, upload it, update that dataset's source and timestamp, and check the dashboard. Explain when data is a fixed snapshot.

Remote query execution, shared connector credentials, certified-query administration, and scheduled refresh services are not bundled. Use an existing authorized data tool to retrieve a new file when needed. Remove an attachment only after no dataset or page file references it.
