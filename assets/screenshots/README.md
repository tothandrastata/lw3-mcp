# Screenshots for WALKTHROUGH.md

Seven captures, named exactly as below — `WALKTHROUGH.md` references these
filenames directly, so a rename breaks the guide.

| File | What it must show |
|---|---|
| `01-download.png` | The browser's download bar or dialog with `lw3-mcp.mcpb` visible, including the *Keep* / *Download anyway* option if your browser shows one. That warning is the first place a non-technical user stops. |
| `02-settings.png` | The Claude Desktop main window with the Settings gear circled or arrowed. Do not crop so tightly that the surrounding window is unrecognisable — the reader needs to locate it in *their* window. |
| `03-extensions.png` | The Settings window with **Extensions** selected in the left sidebar, showing the pane before anything is installed. |
| `04-drag.png` | The actual drag: Explorer on one side with `lw3-mcp.mcpb` selected, the Extensions pane on the other, mid-drag if you can catch it. |
| `05-confirm.png` | Whatever confirmation dialog Claude Desktop shows on install. |
| `06-installed.png` | The Extensions list with **Lightware LW3 Gateway** present and its version number legible. |
| `07-first-use.png` | A chat where *"Discover Lightware devices on the network"* has returned at least one device. |

## Before you capture

- **Sign out or use a clean profile.** Screenshots leak whatever is on screen:
  other MCP servers, chat history, customer names, internal hostnames.
- **Check the device details you expose.** Serial numbers and internal IPs are
  visible in `07-first-use.png`. Use a lab device, or blur them.
- Capture at 100% zoom on a normal-sized window. A maximised 4K window shrinks
  to something unreadable in the guide.
- PNG, not JPEG. Text stays crisp.

## After you add them

Check that every image resolves:

```bash
grep -o '(assets/screenshots/[^)]*)' ../../WALKTHROUGH.md | tr -d '()' |
  while read -r f; do [ -f "../../$f" ] || echo "MISSING: $f"; done
```

These files are excluded from the `.mcpb` by `.mcpbignore` — the guide is for
GitHub, and image weight has no business inside the bundle.
