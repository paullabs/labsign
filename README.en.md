# labsign

Sign PDFs with your own signature without leaving Claude, Codex or the terminal. Local, no account, no cloud.

[Português](README.md)

You say "sign this contract". A screen opens: you draw your signature (or pick a saved one), drag it into place and confirm. A signed copy appears next to the original. Nobody edits the document and you don't have to ask the AI to redo anything. Your signatures stay on your computer, like on the iPhone.

## What it does

- **Draw** with a mouse, trackpad or finger. You can hold and drag (the default) or use click-to-write (one click puts the pen down, another lifts it). Three pen sizes and three inks: navy, blue and black.
- **Signature set:** save as many as you like, reuse the last one with a click, delete the ones you no longer need.
- **Real preview:** the PDF page is shown with the signature on top. Drag it, resize it (keyboard works too), change page or remove it. What you see is what ends up in the PDF.
- **Finds the spot:** looks for the text of your signature block (e.g. `CONTRATANTE`, `Signature`) and proposes the line right above it. If it isn't found, it proposes the last page and you drag.
- **Never touches the original:** writes `contract.assinado.pdf` (or `.assinado-2.pdf`…) and never overwrites anything. Saves incrementally, so digital signatures already in the PDF stay valid.
- **Evidence record:** for each signature, it logs the date and time and the SHA-256 of the original and the signed file, in a hash-chained log.
- **Send or keep:** after signing, download, show in folder, share (Mail, Messages, AirDrop… where the system allows), email (Gmail or your app) or WhatsApp. For email and WhatsApp the message opens ready to go, and you attach the PDF.
- **English and Portuguese:** the screen follows your system language.

## Install

### Claude Desktop

1. Download `labsign-<version>.mcpb` from Releases, or build it yourself (see [Development](#development)).
2. Double-click it (or drag it into **Settings → Extensions**) and click **Install**.
3. In a conversation, ask: _"sign the contract at ~/Downloads/contract.pdf"_. If you only attached the PDF to the conversation, say _"I want to sign this PDF"_: the screen asks you to drop the file on it, because Claude doesn't hand attachments to extensions.

The screen opens inside the conversation in Claude Desktop versions that support MCP Apps, and in the browser otherwise. If Claude Desktop asks for Node.js, install the LTS version from [nodejs.org](https://nodejs.org).

### Claude Code

For now, from the source (installing straight from GitHub comes with the npm release):

```bash
git clone <repository> labsign && cd labsign
npm ci && npm run mcpb
claude plugin marketplace add "$(pwd)"
claude plugin install labsign@labsign
```

The plugin brings the MCP server and a skill that teaches Claude Code how to use labsign. Claude Code runs in the terminal, so the screen opens in the browser.

### Codex

```bash
codex mcp add labsign -- node /path/to/labsign/dist/labsign.js mcp
cp -R /path/to/labsign/plugin/skills/labsign ~/.agents/skills/
```

Codex stops tools after 60 seconds, so labsign answers within 45 seconds and then follows the signing through `labsign_status`.

### Terminal (and any other app)

```bash
npm ci && npm run build && npm link   # from the source: creates the labsign command
labsign sign contract.pdf --anchor Signature
```

| Command | What it does |
| --- | --- |
| `labsign sign <file.pdf> [--anchor TEXT]` | Opens the screen to sign and waits until you finish |
| `labsign sign` | Opens the screen asking for the PDF (drop the file on it) |
| `labsign add` | Opens the screen to draw and save signatures |
| `labsign list` | Lists saved signatures (names only) |
| `labsign doctor` | Checks the setup and prints the exact command to connect each app. Changes nothing |
| `labsign mcp` | MCP server (stdio), for apps that speak MCP (Cursor, etc.) |

Requires Node.js 22.13 or newer.

### Configuration (optional)

| Variable | What for |
| --- | --- |
| `LABSIGN_HOME` | Vault folder (default: `~/.labsign`) |
| `LABSIGN_OUTPUT_DIR` | Where the signed copy of a PDF dropped on the screen goes (default: `~/Downloads`) |
| `LABSIGN_LANG` | `pt` or `en`, in the terminal and on the screen |
| `LABSIGN_BROWSER` | Program that opens the screen instead of the default browser |
| `LABSIGN_NO_OPEN=1` | Opens no browser or folder: the terminal prints the link for you to open |
| `LABSIGN_UI` | `auto` (default), `inline` or `browser`: forces where the screen shows up in chat apps |

## Privacy and security

- **Everything happens on your computer.** The screen is served on `127.0.0.1`, on a random port, through a one-time link. Nothing goes to the internet and there is no telemetry.
- **labsign never shows your signature to the AI.** It only opens the screen and gets the result (the signed file's name). The link that opens the screen goes straight to your browser; the screen's internal tools require a token that only the screen receives.
- **Nothing is signed without your click.** An agent with terminal access (Claude Code, Codex) runs as you: see the limits in [SECURITY.md](SECURITY.md).
- **Vault in `~/.labsign`**, readable only by your user: the signatures (the strokes), preferences and `audit.log`.

Details and limits in [SECURITY.md](SECURITY.md).

## Legal note

labsign produces a simple electronic signature: the image of your signature on the PDF, plus an evidence record (date and time, SHA-256 of the original and the signed file). Whether that is enough depends on your jurisdiction and on what the parties accept. It is not a certificate-based (qualified/advanced) digital signature. This is not legal advice.

## Development

```bash
npm ci
npm run build       # dist/labsign.js (CLI + MCP) and dist/ui.html, dist/ui-app.html (the screen)
npm test            # build + tests (needs Node 24; poppler is optional and enables pixel checks)
npm run typecheck
npm run mcpb        # dist/labsign-<version>.mcpb and plugin/server/
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. Bundled libraries and their licenses are listed in `dist/THIRD_PARTY_LICENSES.txt`.
