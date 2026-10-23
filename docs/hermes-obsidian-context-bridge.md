# Hermes Obsidian context bridge

Hermes Console uses one Obsidian plugin and one Hermes plugin, connected by local JSON files: a per-vault bridge file inside your vault, plus a vault-independent pointer file that tells the Hermes plugin which vault that is.

The Obsidian plugin is **Hermes Console**. It owns the terminal UI, tabs, PTY sessions, per-tab note/PDF selection and cursor capture, and the busy/idle tab indicators.

The Hermes plugin is **obsidian-context-bridge**. It appears in Hermes Plugins because it runs inside Hermes. It registers Hermes hooks, injects note/PDF selection or cursor context before the LLM call, exposes the `obsidian_context()` tool for large selections, and writes per-tab busy/idle status for the Obsidian UI.

It is not a second Obsidian plugin.

## Fast path

Community Plugins installs the Obsidian plugin assets only. It does not install Hermes Agent and it does not auto-enable Hermes plugins.

1. Install **Hermes Console** from **Settings > Community Plugins**.
2. Enable **Hermes Console**.
3. Click **Settings > Hermes Console > Download binaries**.
4. Make sure `hermes` is installed and available to the shell launched by Obsidian.
5. Install and enable the Hermes-side bridge once:

   ```bash
   hermes plugins install dannyshmueli/obsidian-hermes-console#hermes --enable
   ```

6. Open Hermes Console, enable the **Send context to Hermes** header toggle for the terminal tab you want to use, select text in a note or a PDF (or put your cursor in a note), type a prompt, and press Enter.

Note context sharing is opt-in per Hermes Console terminal tab. The tab header toggle defaults off after plugin reload or Obsidian restart, so enable it again for each terminal tab that should share note context. You can also run **Toggle note context for active Hermes Console tab** from the command palette and bind that command under Settings > Hotkeys.

## What users see in Hermes Plugins

Seeing `obsidian-context-bridge` in Hermes Plugins is expected.

Call it the **Hermes plugin** or **Hermes companion plugin** when explaining the architecture. Do not call it an Obsidian plugin.

It is dashboard-only/no-UI in Hermes because its job is not to render a tab. Its job is to:

- read `<vault>/.obsidian/hermes/context.json` (found through `OBSIDIAN_CONTEXT_BRIDGE_PATH`, the pointer file below, or a scan from the working directory)
- inject fresh selected-text or cursor context before the LLM call
- expose `obsidian_context()` for large selections
- write `<vault>/.obsidian/hermes/runtime/<tab-id>.json` so Hermes Console can show busy/idle tab state

## Architecture

```text
Obsidian note selection/cursor
  -> Hermes Console Obsidian plugin
  -> <vault>/.obsidian/hermes/context.json
  -> obsidian-context-bridge Hermes plugin
  -> current Hermes turn
```

The Hermes plugin locates the bridge file in this order:

```text
OBSIDIAN_CONTEXT_BRIDGE_PATH            (inherited from the PTY Hermes Console spawns)
  -> <config home>/hermes-console/bridge.json   (pointer file; works in any process)
  -> working-directory scan               (vault at or above the cwd, or a sibling *.vault)
  -> ~/wiki/.obsidian/hermes/context.json (historical fallback)
```

Busy/idle status uses a second local JSON side channel:

```text
Hermes hooks
  -> obsidian-context-bridge Hermes plugin
  -> <vault>/.obsidian/hermes/runtime/<tab-id>.json
  -> Hermes Console tab spinner / unread dot / optional Obsidian Notice
```

These bridge files are just JSON. They are not sockets, servers, clipboard paste, or network connections.

## Context bridge file

Hermes Console writes the current attachment state to:

```text
<vault>/.obsidian/hermes/context.json
```

Plain Enter writes a fresh marker before the PTY receives Enter. If note context sharing is enabled for that terminal tab, Hermes Console sends the current selection first; if nothing is selected, it sends cursor/file context for the active Markdown note.

When note context sharing is off for that terminal tab, the marker has:

```json
{"attach":{"enabled":false},"context":null}
```

Hermes consumers must treat that as a fresh detach and clear any previously accepted selected text.

## Bridge pointer file

`OBSIDIAN_CONTEXT_BRIDGE_PATH` is inherited only inside the process tree Hermes Console spawns. When the turn is served by a process that never inherited it - a Hermes gateway running as a service, a container, a remote/SSH backend, or a turn started by cron or a webhook - the variable is simply absent, and no hard-coded fallback can know which vault is active.

Hermes Console therefore also publishes the active vault's bridge path to a fixed, vault-independent location:

```text
$XDG_CONFIG_HOME/hermes-console/bridge.json      (default: ~/.config/hermes-console/bridge.json)
```

```json
{
  "schemaVersion": 1,
  "source": "hermes-console",
  "updatedAt": "2026-10-23T09:40:00.000Z",
  "entries": [
    {
      "vaultPath": "/path/to/vault",
      "configDir": ".obsidian",
      "tabId": "terminal-2",
      "tabTitle": "Hermes 1",
      "bridgePath": "/path/to/vault/.obsidian/hermes/context.json",
      "updatedAt": "2026-10-23T09:40:00.000Z",
      "updateTimestamp": 1792744486400,
      "submitSequence": 15
    }
  ]
}
```

Keyed by `vaultPath` (the bridge file is per vault, not per tab), newest first, capped at 16 entries. It is written when a terminal tab spawns, refreshed on every submit, and pruned when the vault unloads. Writes are atomic (temp file + rename), and the Hermes side picks the entry with the newest `updateTimestamp`. The pointer file is additive: a Hermes process that already inherits the environment variable is unaffected, and the file is never consulted before the variable.

Because one pointer file serves every vault, several vaults can be listed at once - useful when a setup runs several vaults that share a single Obsidian config folder (`_obsidian` style), since each still contributes exactly one entry.

## PDF context

A PDF open in Obsidian renders inside the plugin's bundled pdf.js viewer, which has no CodeMirror editor and keeps its selection in the DOM only. Hermes Console therefore reads that DOM selection (`div.page[data-page-number]` and its `textLayer` spans), maps it onto the page it came from, and snapshots it while it is still live: clicking into the console terminal to press Enter clears the viewer's selection, so a snapshot taken at submit time would always be empty. The snapshot is refreshed on `selectionchange`, `keyup` and `pointerup`.

The snapshot travels through the same `context.json` as a note selection, with one extra field:

```json
{
  "context": {
    "type": "selection",
    "file": { "path": "papers/study.pdf", "name": "study.pdf" },
    "selectedText": "3.1 引言 传统工业装配任务…",
    "lineCount": 1,
    "charCount": 295,
    "hash": "458acab50d8b6ce7",
    "pdf": { "pageFrom": 33, "pageTo": 33, "pageCount": 1, "totalPages": 102 }
  }
}
```

`range` and `lineCount` are still filled from the page's text, so a Hermes-side consumer written before this field existed keeps working; `pdf` is additive, and `totalPages` is `null` when the viewer did not report a page count.

The console header shows the page and the selection size in words (`PDF p.33 (51 words)`). The word count follows the 字数 convention Chinese word processors use rather than whitespace tokens: each CJK character counts once, each run of Latin letters/digits counts once, punctuation counts zero - a whole Chinese paragraph would otherwise read "1 word". `charCount` stays in the payload (the host budgets in characters), it is just no longer what the header prints.

When a note selection and a PDF selection are both available, the more recent one wins: the tracker timestamps both and attaches whichever the user selected last.

### Pulling whole pages with `@pdf:`

A selection is a few hundred characters by design. To get pages into the prompt, use the `@pdf:` context reference that the Hermes plugin registers (`@pdf:` completion also lists the vault's PDFs with their page counts, plus `current`):

| Reference | Expands to |
| --- | --- |
| `@pdf:paper.pdf` | the whole document, capped |
| `@pdf:paper.pdf:84` | page 84 |
| `@pdf:paper.pdf:84-86` | pages 84 to 86 |
| `@pdf:current` | the PDF the last bridge payload pointed at |
| `@pdf:current:85-90` | that PDF, pages 85 to 90 |

Expansion reads the text with `pdftotext` (`pdfinfo` supplies the page count) from poppler, which preserves the line structure of the page and is cleaner than the selection path, where pdf.js spans can run together across a header. A scanned PDF with no text layer answers with an explicit message instead of silence. Paths resolve inside the vault, and a reference pointing outside it is refused.

Each reference reads at most 10 pages and 12000 characters by default (`OBSIDIAN_PDF_REF_MAX_PAGES`, `OBSIDIAN_PDF_REF_MAX_CHARS`), and says so in the text when it hits a cap, so Hermes can ask for the next window instead of assuming the document ended.

The vault root comes from `OBSIDIAN_PDF_VAULT_ROOT` when set, otherwise the `vaultPath` in `context.json`, otherwise the bridge file's own location (three levels up). The `@pdf:` header always prints the vault-relative path, including when the vault root is a symlink.

## Busy/idle status files

For each terminal tab, Hermes Console sets environment variables before spawning the PTY:

```text
OBSIDIAN_HERMES_TAB_ID=terminal-1
OBSIDIAN_HERMES_STATUS_PATH=<vault>/.obsidian/hermes/runtime/terminal-1.json
OBSIDIAN_HERMES_STATUS_DIR=<vault>/.obsidian/hermes/runtime
```

The Hermes plugin writes status JSON on these hooks:

- `pre_llm_call` -> `busy`
- `post_llm_call` -> `idle`
- `on_session_end` -> `idle`
- `on_session_finalize` -> `idle`

Hermes Console watches the status file and uses it for:

- spinner while a Hermes turn is running
- unread dot when a background Hermes tab becomes idle
- optional Obsidian Notice when a background Hermes turn finishes

This replaced the older OSC/prompt-parsing experiment. Terminal output is not the source of truth for Hermes busy state.

## Manual Hermes plugin installation

Most users should use the one-line install:

```bash
hermes plugins install dannyshmueli/obsidian-hermes-console#hermes --enable
```

`#hermes` points at the Hermes-side plugin inside this repository (about 60 KB). `hermes plugins install dannyshmueli/obsidian-hermes-console` installs the repository root as well, but also clones the Obsidian plugin sources and the prebuilt binaries (about 36 MB), and current Hermes builds require `--force` for that form because the install scanner reports those binaries and documentation files as caution findings.

Use manual install only when you run Hermes outside Hermes Console or maintain a custom Hermes profile.

The Hermes plugin files live in this repository under:

```text
hermes/plugin.yaml
hermes/__init__.py
hermes/obsidian_context_bridge.js
hermes/obsidian_status_bridge.py
```

If you copy the plugin manually, install those files as a Hermes plugin named `obsidian-context-bridge`, then enable it in Hermes config.

For context injection, the Hermes process must receive:

```text
OBSIDIAN_CONTEXT_BRIDGE_PATH=/path/to/vault/.obsidian/hermes/context.json
```

For tab busy/idle state, the Hermes process must receive the `OBSIDIAN_HERMES_*` variables listed above.

Hermes Console sets these environment variables automatically for terminal sessions it launches, and they are inherited **only by processes that descend from that shell**. If your turns are served by a long-lived gateway or another supervised process, set the path explicitly in that process's environment. For a Hermes profile that means `$HERMES_HOME/.env`:

```bash
# $HERMES_HOME/.env
OBSIDIAN_CONTEXT_BRIDGE_PATH=/path/to/vault/.obsidian/hermes/context.json
```

Hermes reloads `.env` per turn, so `/reload` inside the session (or a new session) is enough. With the pointer file above this is no longer needed for the normal case; keep it for pinned setups and for pointing Hermes at a specific vault by hand.

## Runtime behavior

- Missing or unreadable context bridge file: no context injected; `obsidian_context()` answers with a structured result instead of `null`:
  `{"context": null, "reason": "bridge_path_unset", "bridge_path": null, "bridge_source": null, "checked_paths": [...], "hint": "..."}`. Possible reasons: `no_turn_yet`, `bridge_path_unset`, `bridge_unreadable`, `bridge_not_an_object`, `payload_invalid`, `payload_stale`, `payload_older_than_accepted`, `payload_already_consumed`, `attach_disabled`, `no_context_in_payload`, `stale`. The plugin logs each new reason once, so a silent no-op shows up in the Hermes log.
- `attach.enabled=false`: no context injected; previously accepted context is cleared. This is the default after plugin reload or Obsidian restart until the user enables the tab's **Send context to Hermes** header toggle or runs **Toggle note context for active Hermes Console tab**.
- Selection context: small selections are injected inline as serialized text.
- Large selections: Hermes gets a preview and can call `obsidian_context()` for the full text.
- Cursor context: Hermes gets file path, cursor position, current line, and nearby lines.
- Freshness window: stale payloads are rejected.
- Reuse guard: the same bridge payload is not injected twice.
- Missing or unreadable status file: no busy/idle UI update for that tab until a fresh status file is written.

## Troubleshooting

If Obsidian writes the bridge file but Hermes does not see context:

1. Confirm the Hermes Plugins screen shows `obsidian-context-bridge` enabled.
2. Ask for the reason: call `obsidian_context()`. `reason: "bridge_path_unset"` means no bridge file was found at all; `payload_stale` means the bridge file is older than the two-minute window (press Enter in the console and retry); `attach_disabled` means the tab's **Send context to Hermes** toggle is off.
3. Confirm the pointer file lists your vault: `cat "${XDG_CONFIG_HOME:-$HOME/.config}/hermes-console/bridge.json"`.
4. If the turn runs outside Hermes Console (gateway, service, container), check that process: `env | grep OBSIDIAN_`, and set `OBSIDIAN_CONTEXT_BRIDGE_PATH` explicitly when it is empty (see Manual installation).
5. Confirm `<vault>/.obsidian/hermes/context.json` updates when you press Enter.
6. Confirm the **Send context to Hermes** header toggle is on for the active terminal tab, or run **Toggle note context for active Hermes Console tab** from the command palette.
7. Restart Hermes Console after changing plugin settings or binaries.

If the tab spinner or background-finished notice does not work:

1. Confirm Hermes was launched from Hermes Console.
2. Confirm the Hermes Plugins screen shows `obsidian-context-bridge` enabled.
3. Confirm the terminal environment contains `OBSIDIAN_HERMES_STATUS_PATH` and `OBSIDIAN_HERMES_TAB_ID`.
4. Confirm `<vault>/.obsidian/hermes/runtime/<tab-id>.json` updates during a Hermes turn.
5. Disable and re-enable Hermes Console, or restart Obsidian, after changing plugin files.

If PDF selections stay out of Hermes:

1. Confirm the PDF is open in Obsidian's own viewer; an external viewer cannot feed the bridge.
2. Select text inside a page and check the console header: `PDF p.…` means the snapshot was taken, a note label means the last selection was in a note.
3. `@pdf:` needs poppler - `which pdftotext pdfinfo`. Without it, references answer that no text layer was found.

Do not install another Obsidian plugin. There is only one Obsidian plugin: Hermes Console.
