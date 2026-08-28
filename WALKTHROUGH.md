# Installing the Lightware LW3 Gateway — picture guide

<style>
/* Print / HTML-export only. GitHub strips <style>, so this is a no-op there. */
.page-break { break-after: page; page-break-after: always; }

/* Screenshot size. Raise or lower the one number below to taste.
   max-width only, deliberately: adding width:100% would upscale the
   narrow captures (01-gear is 420px wide) and make them blurry. */
img { max-width: 860px; height: auto; display: block; }

@media print {
  h2 { break-after: avoid; page-break-after: avoid; }
  img, blockquote { break-inside: avoid; page-break-inside: avoid; }
  a { color: inherit; text-decoration: underline; }
  img { max-width: 15cm; }
}
</style>


## Before you start

You need **Claude Desktop** installed, and you need to be **on the same network
as the Lightware device** — the office network or a wired connection, not a
guest network. If you are connected to a VPN, disconnect it first. The gateway
finds devices by broadcasting on the local network, and a VPN sends that
broadcast to the wrong place.

---

## Step 1 — Download the file

Click here:

**https://github.com/tothandrastata/lw3-mcp/releases/latest/download/lw3-mcp.mcpb**

Your browser saves `lw3-mcp.mcpb` to your Downloads folder.

> **If your browser warns you about the file**, that is expected. It is an
> unfamiliar file type, not a dangerous one. Choose *Keep* or *Download anyway*.

---
<div class="page-break"></div>

## Step 2 — Open Claude Desktop's settings

Open Claude Desktop. Click the **gear icon** to open Settings.

<img src="assets/screenshots/01-gear.png" alt="Claude Desktop with the Settings gear circled" width="300">



In the list on the left, scroll past the first group to the **Desktop app**
heading and click **Extensions** underneath it.

<img src="assets/screenshots/02-settings.png" alt="Extensions" width="460">

<div class="page-break"></div>

## Step 3 — Drag the file in

The Extensions page has a line near the middle reading
**"Drag .MCPB or .DXT files here to install"**. That is the target.

Open your Downloads folder next to the Claude Desktop window, then drag
`lw3-mcp.mcpb` out of Downloads and drop it on that line.

<img src="assets/screenshots/04-drag.png" alt="Dragging the file from Explorer onto the Extensions pane" width="560">

> **If nothing happens when you drop it**, click **Advanced settings** —
> the button just above that line — and look there for the option to install
> an extension from a file, then pick `lw3-mcp.mcpb` from your Downloads
> folder instead.


## Step 4 — Configure permissions

You can avoid allowance of each tool (GET / SET / CALL / ...) separately by allowing all:

<img src="assets/screenshots/05-confirm.png" alt="Allow all tools of the extension" width="220">

<div class="page-break"></div>

## Step 5 — Try it

Start a new chat and type:

> Discover Lightware devices on the network

Claude replies with the devices it found — model name, serial number, and IP
address for each one.

<img src="assets/screenshots/07-first-use.png" alt="A chat showing the discover result with a device listed" width="700">

Then connect to one and ask for whatever you need:


<img src="assets/screenshots/08-videostatus.png" alt="A chat showing the video input status if the discovered device" width="700">

> **If Claude asks for a password**, that is expected — some devices only
> accept a secure connection that needs the device's **admin** password (the
> same one you'd use to log in to the device's own web page). It goes straight
> to the device; this extension does not store it or show it back to you.

<div class="page-break"></div>

## If something goes wrong

**No devices found.** You are probably on a VPN or a guest network. Disconnect
the VPN and try again. If you know the device's IP address, you can skip
discovery entirely — just say *"Connect to 192.168.2.109"* with the real
address.

**"Not connected to a device".** Ask Claude to connect first. The connection
closes when you quit Claude Desktop, so you reconnect each time you restart it.

**It seems stuck when connecting.** The extension tries a couple of ways to
reach the device automatically, so this is rarer than it used to be, but it
can still happen if the address is wrong or a firewall blocks both. Double-check
the IP address and that you are on the office network.

**Anything else** — send a screenshot to Andras Toth.

---

## Getting a newer version

Extensions do not update themselves. When a new version is announced, use the
same download link from Step 1 and drag the new file in the same way. It
replaces what you have.

To see which version you are running, open Settings → Extensions and look at the
number next to Lightware LW3 Gateway.
