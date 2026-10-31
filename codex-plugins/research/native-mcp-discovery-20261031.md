# Local plugin MCP discovery: verified 2026-10-31

This is a read-only runtime investigation. It did not create chats, start model
turns, read chat bodies, modify Codex configuration, or use the private app-tools
pipe. Only a newly spawned metadata-only `app-server --stdio` child was closed.

## Runtime and probe

- Runtime: `Codex Desktop/0.166.0-alpha.5.1` on Windows x86_64.
- Installed plugin: `codex-design-native-probe@codex-design-native-probes`.
- Installed version: `0.0.5`; `plugin/read` reported installed and enabled.
- The probe uses an AGP root `plugin.json`, an AGP `mcp.json`, and a self-contained
  server bundle. The command is `node`; arguments contain
  `${PLUGIN_ROOT}/server/index.mjs`; cwd is `${PLUGIN_ROOT}`. No user-specific
  absolute executable or source path is required.

`plugin/read` returned:

```json
{"mcpServers":["codex-design-native-probe"]}
```

`mcpServerStatus/list` returned 13 servers in total. Only the probe result is
recorded here; other server configuration and authentication data were omitted.
The probe had:

```json
{
  "name": "codex-design-native-probe",
  "pluginId": "codex-design-native-probe@codex-design-native-probes",
  "serverInfo": {
    "name": "codex-design-library-probe",
    "version": "0.3.0-spike"
  },
  "toolsError": null,
  "toolCount": 2,
  "tools": [
    {
      "name": "DesignLibrary",
      "_meta": {
        "ui": {
          "resourceUri": "ui://codex-design/library",
          "visibility": ["app"]
        },
        "openai/ui": {"entrypoints": [{"type": "global"}]}
      }
    },
    {
      "name": "DesignFile",
      "_meta": {
        "ui": {
          "resourceUri": "ui://codex-design/file",
          "visibility": ["app"]
        },
        "openai/ui": {
          "entrypoints": [{"type": "file", "extensions": [".codexdesign"]}]
        }
      }
    }
  ],
  "resources": [
    {"name": "library", "uri": "ui://codex-design/library", "mimeType": "text/html;profile=mcp-app"},
    {"name": "file", "uri": "ui://codex-design/file", "mimeType": "text/html;profile=mcp-app"}
  ],
  "authStatus": "unsupported"
}
```

`authStatus: unsupported` does not indicate a failed stdio handshake: this probe
has no OAuth flow, and its tool catalog and resources were returned successfully.
This verifies plugin loading, stdio startup, initialization, and tools/resources
discovery. It does **not** verify that the already-running Desktop window has
refreshed its catalog or rendered the native global entrypoint/iframe. That
requires a separate consuming-app check.

## Exact cause of the earlier empty catalog

Probe `0.0.4` lacked the AGP MCP file's required top-level field:

```json
{"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"}
```

The actual Desktop runtime logged:

```text
target: codex_core_plugins::loader
failed to parse plugin MCP config: missing field `$schema` at line 12 column 1
```

Adding this schema in `0.0.5`, without changing its `node`/`${PLUGIN_ROOT}` launch
configuration, changed `plugin/read.mcpServers` from empty to the probe server
and produced the successful catalog above. A classic-only control was parsed
by the legacy path; it was not needed to make the AGP configuration work.

The public Rust sources explain this behavior:

- [`agent_plugin_config.rs:38-44,86-95`](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/agent_plugin_config.rs#L38-L95): the AGP MCP file requires `$schema` and `mcpServers`, and accepts the declared schema URI only.
- [`agent_plugin_config.rs:46-57,150-245`](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/agent_plugin_config.rs#L46-L245): `type: "stdio"` is valid; bare command names and `${PLUGIN_ROOT}` cwd/argument expansion are supported.
- [`agent_plugin_manifest.rs:169-170`](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/agent_plugin_manifest.rs#L169-L170): AGP selects `./mcp.json`.
- [`agent_plugin_manifest.rs:203-215`](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/agent_plugin_manifest.rs#L203-L215): the Codex extension applies apps/hooks/onboarding/interface; an added extension `mcpServers` field does not replace the AGP MCP file path.
- [`loader.rs:1682-1697`](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/loader.rs#L1682-L1697): a parse failure is logged and returns no discovered servers.

These links point to public `main`, which is not asserted to be the exact source
revision of the installed alpha. The missing-schema failure and the corrected
probe startup were independently reproduced with the actual installed runtime.

## Native chat delegation boundary

Public SDK `@openai/mcp-extensions@0.2.1` declares message targets `active` and
`new`, plus `send`; it does not declare a destination thread ID, project ID, cwd,
or artifact-to-chat binding operation. See installed
`node_modules/@openai/mcp-extensions/dist/app/message.d.ts:5-12,103-120`.
The global app's active conversation must not be represented as an arbitrary
artifact's independently bound editing chat.

The bundled first-party app-tools server is different. Its installed source is:

`C:\Program Files\WindowsApps\OpenAI.Codex_26.1027.3384.0_x64__2p2nqsd0c76g0\app\resources\plugins\openai-bundled\plugins\codex-app-tools\server.mjs`

- Lines 34580-34595 require executor-supplied thread metadata.
- Lines 34600-34625 forward the caller source, thread ID, call ID, and turn ID.
- Lines 34695 and 34726-34735 consume the host-provided private app-tools pipe.
- The sibling `.mcp.json` assigns approval mode `prompt` to `create_thread`,
  `send_message_to_thread`, `fork_thread`, `handoff_thread`, and
  `move_thread_to_project`.

The actual registered native tools can be used through the normal agent/tool
execution and approval path when explicitly authorized. A third-party MCP UI
manually supplying copied thread metadata to this private pipe is not an
established public delegation API or a verified approval boundary. No such
delegation was attempted or implemented.

File-handler resource grants establish authorized filesystem access, not a
documented per-artifact Quick Chat binding. The first-party Space Slides
`artifact-session-binding`/Page Quick Chat integration is a separate private
implementation; no equivalent public binding operation was confirmed here.

The independent per-artifact native chat/composer requirement therefore remains
an explicit public-interface gap. Do not substitute the global shared chat,
spoof a thread context, bypass approval prompts, or run a separate model daemon.
