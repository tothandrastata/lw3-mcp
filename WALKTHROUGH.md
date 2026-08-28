# Installing the Lightware LW3 Gateway — picture guide

For anyone who would rather see it than read it. Takes about two minutes.

If you are comfortable with software installs, [INSTALL.md](INSTALL.md) says the
same thing in a quarter of the space.

---

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

![Screenshot 1: the browser download bar showing lw3-mcp.mcpb, with the Keep option visible](assets/screenshots/01-download.png)

---

## Step 2 — Open Claude Desktop's settings

Open Claude Desktop. Click the **gear icon** to open Settings.

![Screenshot 2: Claude Desktop with the Settings gear circled](assets/screenshots/02-settings.png)

---

## Step 3 — Go to Extensions

In the Settings window, choose **Extensions** from the list on the left.

![Screenshot 3: the Settings window with Extensions selected in the sidebar](assets/screenshots/03-extensions.png)

---

## Step 4 — Drag the file in

Open your Downloads folder next to the Claude Desktop window. Drag
`lw3-mcp.mcpb` out of Downloads and drop it onto the Extensions page.

![Screenshot 4: dragging the file from Explorer onto the Extensions pane](assets/screenshots/04-drag.png)

> **If nothing happens when you drop it**, look on the Extensions page for a
> button that installs an extension from a file, and use that to pick
> `lw3-mcp.mcpb` from your Downloads folder instead.

---

## Step 5 — Confirm

Claude Desktop asks you to confirm. Accept it.

![Screenshot 5: the install confirmation prompt](assets/screenshots/05-confirm.png)

---

## Step 6 — Check that it worked

**Lightware LW3 Gateway** now appears in your Extensions list with a version
number next to it. That is the whole installation.

![Screenshot 6: the Extensions list showing Lightware LW3 Gateway installed](assets/screenshots/06-installed.png)

---

## Step 7 — Try it

Start a new chat and type:

> Discover Lightware devices on the network

Claude replies with the devices it found — model name, serial number, and IP
address for each one.

![Screenshot 7: a chat showing the discover result with a device listed](assets/screenshots/07-first-use.png)

Then connect to one and ask for whatever you need:

> Connect to 192.168.2.109
>
> Show me the root structure
>
> What is the hostname of this device?

---

## If something goes wrong

**No devices found.** You are probably on a VPN or a guest network. Disconnect
the VPN and try again. If you know the device's IP address, you can skip
discovery entirely — just say *"Connect to 192.168.2.109"* with the real
address.

**"Not connected to a device".** Ask Claude to connect first. The connection
closes when you quit Claude Desktop, so you reconnect each time you restart it.

**It seems stuck when connecting.** The address is probably wrong, or a firewall
is blocking it. Double-check the IP address and that you are on the office
network.

**Anything else** — send a screenshot to Andras Toth.

---

## Getting a newer version

Extensions do not update themselves. When a new version is announced, use the
same download link from Step 1 and drag the new file in the same way. It
replaces what you have.

To see which version you are running, open Settings → Extensions and look at the
number next to Lightware LW3 Gateway.
