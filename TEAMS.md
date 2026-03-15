# Trackzure — Work Item Time Tracker

Chrome/Edge extension to track time against your Azure DevOps work items directly from the toolbar. No tab switching, no spreadsheets.

---

**What it does**
- Lists your assigned, non-done work items with state, type, and time tracked today
- Start/stop a timer per item — only one runs at a time, switching auto-pauses the previous
- Timer keeps running in the background even when the popup is closed
- Log time directly to the Completed Work field in Azure DevOps, with an optional comment

---

## How to Install

1. Download/clone the repo
2. Go to `chrome://extensions` → enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder
4. Pin the Trackzure icon to your toolbar

---

## How to Configure

Right-click the toolbar icon → **Options** (or click the gear inside the popup).

**1. Provider**
Select **Azure DevOps Server** (on-prem) or **Azure DevOps Services** (cloud).

**2. Server URL**
- On-prem: `https://tfs.yourcompany.com/DefaultCollection`
- Cloud: `https://dev.azure.com/yourorg`

**3. Project**
Enter the exact project name as it appears in Azure DevOps (case-sensitive).

**4. Personal Access Token (PAT)**
Create one in Azure DevOps:
- Profile picture → **Personal access tokens** → **New Token**
- Name it (e.g. `Trackzure`), set an expiry
- Scopes: **Work Items → Read & Write**
- Copy and paste the token into the PAT field in Options

**5. Remember Token** *(optional)*
Keeps your token saved across browser restarts. Only enable on a personal/trusted machine.

**6. Test Connection**
Hit **Test Connection** — it will confirm your credentials and show your display name on success.

> **On-prem only:** If the connection fails with a network error, your browser may not trust the server certificate. Navigate to your server URL in Chrome/Edge and accept the certificate warning once.

---

Once connected, open the popup, hit **▶ Start** on any work item, and click **Log Time** when done.
