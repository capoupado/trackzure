# Trackzure — Work Item Time Tracker

A Chrome/Edge browser extension for tracking time against your assigned Azure DevOps work items, directly from the toolbar. No context switching, no manual spreadsheets.

---

## Features

### Work Items
- Displays all your assigned, non-done Azure DevOps work items in the toolbar popup
- Each item shows the ID (as a clickable link to Azure DevOps), title, state badge, work item type, and time tracked today
- Loads from cache instantly on popup open, then refreshes from the API in the background
- Auto-refresh runs on a configurable interval (default: every 5 minutes)

### Timer
- Each work item has a Start / Stop toggle — only one timer can run at a time
- Starting a new timer automatically stops the previous one and shows a toast notification ("Switched to #1234")
- Timer state persists across popup close/reopen; the background service worker keeps it ticking even when the popup is closed
- The extension badge on the toolbar icon shows either the elapsed time or the active work item ID (configurable)

### Time Logging
- Each work item has a **Log Time** button, enabled once any time has been tracked
- Before submitting, a confirmation dialog lets you review and edit the duration
- Time is logged to the **Completed Work** field on the Azure DevOps work item, and a comment is posted with the logged duration
- On success, the local timer resets; on failure, your time data is preserved so nothing is lost

### Notifications & Feedback
- Toast notifications for timer switches, successful time logs, and errors
- The toolbar badge changes to ⚠ on authentication failures, with an inline prompt to update your token in Settings
- Network and server errors show an inline banner in the popup with a retry button
- If a connection fails on an HTTPS on-premises URL, help text explains the likely certificate trust issue

---

## Installation

> The extension is not published to the Chrome Web Store. It must be loaded manually as an unpacked extension.

1. Download or clone this repository to your machine.
2. Open Chrome or Edge and navigate to `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `extension/` folder from this repository.
5. The Trackzure icon will appear in your toolbar. Pin it for easy access.

---

## Configuration

Open the extension options by right-clicking the Trackzure toolbar icon and selecting **Options**, or by clicking the gear icon inside the popup.

### 1. Choose Your Provider

Select your project management backend from the **Provider** dropdown:

- **Azure DevOps Server** — for on-premises TFS/Azure DevOps Server instances
- **Azure DevOps Services** — for cloud-hosted `dev.azure.com` organisations

### 2. Enter Your Server URL

| Provider | URL Format | Example |
|---|---|---|
| Azure DevOps Server (on-prem) | `https://{server}/{collection}` | `https://tfs.company.com/DefaultCollection` |
| Azure DevOps Services (cloud) | `https://dev.azure.com/{organisation}` | `https://dev.azure.com/myorg` |

> **On-premises note:** If your server uses a self-signed or internal CA certificate, you may need to trust it at the browser level before the extension can connect. Navigate to your server URL in Chrome/Edge and accept the certificate warning — this is a one-time step.

### 3. Enter Your Project Name

Type the exact name of your Azure DevOps project. This is case-sensitive and must match the project as it appears in Azure DevOps.

### 4. Create and Enter a Personal Access Token (PAT)

The extension authenticates using a Personal Access Token (PAT).

**To create a PAT in Azure DevOps:**

1. Sign in to your Azure DevOps instance.
2. Click your profile picture (top-right) → **Personal access tokens**.
3. Click **New Token**.
4. Give it a name (e.g., `Trackzure`).
5. Set an expiry date — choose a duration that suits your security policy.
6. Under **Scopes**, select at minimum:
   - **Work Items** → Read & Write
7. Click **Create** and copy the token — it will not be shown again.

Paste the token into the **PAT / Auth Token** field in the extension options.

### 5. Token Persistence (Remember Me)

By default, your token is stored in session storage and is cleared when the browser closes. If you want to stay authenticated across browser restarts, enable **Remember Token**. Be aware this stores the token in local extension storage — only use this on a trusted personal machine.

### 6. Test Your Connection

Click the **Test Connection** button. The extension will validate your URL and token, and display the name of the authenticated user on success. If it fails, check:
- The server URL and collection path are correct
- The PAT has not expired and has Work Item read/write scope
- Your browser trusts the server's certificate (on-prem)

### 7. Additional Settings

| Setting | Description | Default |
|---|---|---|
| **Refresh Interval** | How often (in minutes) the work item list is re-fetched in the background | 5 |
| **Terminal States** | Work item states to exclude from the list (e.g. Done, Closed, Removed) | Done, Closed, Removed |
| **Badge Display** | What to show on the toolbar icon badge: elapsed time, active item ID, or nothing | Elapsed time |

---

## Usage

1. Click the Trackzure icon in the toolbar to open the popup.
2. Your assigned, active work items are listed automatically.
3. Click **▶ Start** on a work item to begin tracking time.
4. Click **⏹ Stop** when you're done (or start a different item — the previous timer pauses automatically).
5. When ready to log, click **Log Time**, confirm or adjust the duration, and submit.
6. The time is posted to Azure DevOps and the local timer resets.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Badge shows ⚠ | Authentication failure | Open Settings, check/renew your PAT |
| No work items shown | Wrong project name or terminal state filter | Verify project name in Settings; check terminal states config |
| Connection test fails on on-prem | Untrusted certificate | Navigate to your server URL in the browser and accept the certificate |
| Time log fails | PAT missing Write scope | Recreate the PAT with Work Items → Read & Write |
| Items not refreshing | Refresh interval too long or network issue | Reduce the refresh interval or check network connectivity |
