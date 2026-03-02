# Work Item Time Tracker — Browser Extension

## Overview

A Chrome/Edge (Manifest V3) browser extension that helps users track work items assigned to them and report elapsed time directly from the browser toolbar. It connects to a project management backend to fetch active (non-Done) work items and lets users start/stop timers and submit time entries without leaving their current tab.

**Primary target**: Azure DevOps Server (on-premises), but the architecture uses a provider abstraction so other backends (Azure DevOps Services / cloud, Jira, Linear, custom APIs) can be added as drop-in modules.

## Tech Stack

- **Manifest**: V3 (required for Chrome & Edge)
- **UI**: Popup built with vanilla HTML/CSS/JS (keep it lightweight)
- **Background**: Service worker (`background.js`)
- **Storage**: `chrome.storage.local` for timer state, cached work items, and settings
- **Auth storage**: `chrome.storage.session` for sensitive tokens (cleared on browser close), with an opt-in "remember me" fallback to `chrome.storage.local`
- **API Communication**: `fetch()` from the service worker
- **Auth**: Personal Access Token (PAT) for Azure DevOps; OAuth 2.0 ready for future providers

## Project Structure

```
extension/
├── manifest.json
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── background.js               # Service worker — alarms, API relay, badge updates
├── options/
│   ├── options.html            # Settings: server URL, PAT, project, provider selection
│   └── options.js
├── providers/
│   ├── provider.js             # Base provider interface / contract
│   ├── azure-devops.js         # Azure DevOps Server & Services implementation
│   └── jira.js                 # Jira stub (future)
├── utils/
│   ├── api.js                  # Provider-agnostic API orchestrator
│   ├── timer.js                # Timer logic — start, stop, pause, elapsed calc
│   └── storage.js              # Wrappers around chrome.storage
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

## Provider Abstraction

All backend communication goes through a provider interface so adding new backends doesn't touch the UI or timer logic.

### Provider Contract (`providers/provider.js`)

Every provider must implement:

```js
class WorkItemProvider {
  /** One-time setup — validate connection, fetch user identity */
  async initialize(config) {}

  /** Return the display name / email of the authenticated user */
  async getCurrentUser() {}

  /**
   * Fetch work items assigned to the current user that are NOT in a terminal state.
   * @returns {Array<{ id: string, title: string, state: string, type: string, url: string }>}
   */
  async getMyActiveWorkItems() {}

  /**
   * Submit a time entry against a work item.
   * @param {string} workItemId
   * @param {number} duration
   * @param {string} [comment]
   * @returns {{ success: boolean, message?: string }}
   */
  async logTime(workItemId, duration, comment) {}

  /** Return the set of terminal states for this provider (used by UI to validate filters) */
  getTerminalStates() {}
}
```

### Registering Providers

`utils/api.js` acts as a factory:

```js
import { AzureDevOpsProvider } from '../providers/azure-devops.js';
// import { JiraProvider } from '../providers/jira.js';  // future

const PROVIDERS = {
  'azure-devops': AzureDevOpsProvider,
  // 'jira': JiraProvider,
};

export function createProvider(type, config) {
  const Provider = PROVIDERS[type];
  if (!Provider) throw new Error(`Unknown provider: ${type}`);
  const instance = new Provider();
  return instance.initialize(config).then(() => instance);
}
```

Adding a new backend = create a new file in `providers/`, implement the contract, register it in the map. Zero changes to popup, timer, or background.

---

## Azure DevOps Server — Provider Details

This is the primary and first-class provider. All specifics below.

### Authentication

Azure DevOps Server supports **Personal Access Tokens (PAT)** as the simplest auth method for on-prem instances.

- Passed via `Authorization: Basic` header: `Basic base64(':' + pat)`.
- The user enters their **server base URL** and **PAT** in the options page.
- Token stored in `chrome.storage.session` by default; optionally in `chrome.storage.local` if the user checks "Remember me".

### API Calls

**Base URL pattern** (on-prem): `https://{server}/{collection}/{project}/_apis/...`

Azure DevOps Services (cloud) differs slightly: `https://dev.azure.com/{org}/{project}/_apis/...`

The provider should detect which format to use based on the URL the user provides, or let them pick "Server (on-prem)" vs "Services (cloud)" in settings.

#### Fetching Assigned, Non-Done Work Items

Use WIQL (Work Item Query Language) via the REST API:

```
POST {baseUrl}/_apis/wit/wiql?api-version=7.0
Content-Type: application/json
Authorization: Basic <base64(:PAT)>

{
  "query": "SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] NOT IN ('Done', 'Closed', 'Removed') ORDER BY [System.ChangedDate] DESC"
}
```

This returns only work item IDs. Follow up with a batch details call:

```
GET {baseUrl}/_apis/wit/workitems?ids={id1},{id2},...&fields=System.Id,System.Title,System.State,System.WorkItemType&api-version=7.0
```

**Important on-prem notes**:
- The collection name is part of the URL (e.g., `DefaultCollection`). The options page must let the user specify it.
- Some on-prem instances use self-signed or internal CA certificates. The extension's `fetch()` respects the OS/browser trust store, so the user may need to trust the cert at the browser level — this is outside the extension's control but worth mentioning in the options page help text.
- API version availability varies by server version. Default to `api-version=7.0` but fall back to `6.0` or `5.1` if the server returns a version error. The provider should handle this gracefully.

#### Logging Time (Completed Work Field)

Azure DevOps doesn't have a dedicated "worklog" API like Jira. The standard approach is to update the **Completed Work** field on the work item:

```
PATCH {baseUrl}/_apis/wit/workitems/{id}?api-version=7.0
Content-Type: application/json-patch+json
Authorization: Basic <base64(:PAT)>

[
  {
    "op": "add",
    "path": "/fields/Microsoft.VSTS.Scheduling.CompletedWork",
    "value": <newTotalHours>
  }
]
```

**Logic**: Read the current `CompletedWork` value, add the new elapsed hours, PATCH the sum back. This must be an atomic read-then-write in the provider to avoid race conditions (though true atomicity isn't possible via REST — at minimum, re-read before write).

Optionally also update the **Activity** or add a **comment** via the work item comments API:

```
POST {baseUrl}/_apis/wit/workitems/{id}/comments?api-version=7.0-preview.3

{ "text": "Logged 1.5h via Trackzure extension (by Carlos Poupado)" }
```

### Work Item State Mapping

Terminal states for Azure DevOps (default process templates):

| Process   | Terminal States              |
| --------- | ---------------------------- |
| Agile     | Done, Closed, Removed        |
| Scrum     | Done, Removed                |
| CMMI      | Closed, Removed              |
| Basic     | Done                         |

The provider's `getTerminalStates()` should ideally auto-detect the process template, or the user can configure it in settings. A safe default is to exclude `Done`, `Closed`, and `Removed`.

---

## Core Features

### 1. Work Item List (Popup)

- On popup open, display cached work items immediately, then refresh from the API in the background.
- Show per item: **ID** (as clickable link to the work item in Azure DevOps), **title**, **state** badge, **type** icon/label, and **elapsed time today**.
- Sort by state priority: In Progress → Active → New (configurable).
- Empty state: "No active work items assigned to you — enjoy the calm."
- Error state: Inline banner with retry button.

### 2. Timer / Time Tracking

- Each work item row has a **▶ Start / ⏹ Stop** toggle.
- **Only one timer active at a time** — starting a new one auto-stops the previous (with a brief toast: "Switched to #1234").
- Elapsed time persists across popup close/reopen via `chrome.storage.local`.
- `background.js` uses `chrome.alarms` (1-minute interval) to increment the timer even when the popup is closed.
- Extension badge shows the active work item ID or elapsed time (user-configurable).

### 3. Time Reporting

- **"Log Time"** button per work item — enabled when elapsed > 0.
- Confirmation dialog showing: work item ID, title, and duration (editable before submit).
- On success: reset the local timer for that item, show a success toast.
- On failure: show error, keep timer data intact so no time is lost.
- Support manual time entry (type a duration directly without having used the timer).
- Time is ALWAYS reported in hours (60min <=> 1.0h)

### 4. Settings (Options Page)

| Setting              | Description                                                   | Default                |
| -------------------- | ------------------------------------------------------------- | ---------------------- |
| Provider             | Dropdown: Azure DevOps Server, Azure DevOps Services, (Jira)  | Azure DevOps Server    |
| Server URL           | Base URL, e.g. `https://tfs.company.com/DefaultCollection`    | —                      |
| Project              | Project name or selection (fetched after URL + auth are set)  | —                      |
| PAT / Auth Token     | Personal Access Token                                         | —                      |
| Remember Token       | Persist token across browser sessions                         | Off                    |
| Refresh Interval     | Minutes between automatic work item re-fetch                  | 5                      |
| Terminal States      | Which states to exclude (auto-detected or manual override)    | Done, Closed, Removed  |
| Badge Display        | What to show on the icon badge: item ID, elapsed time, or off | Elapsed time           |

Include a **"Test Connection"** button that calls `provider.initialize()` + `provider.getCurrentUser()` and shows the result.

---

## manifest.json

```json
{
  "manifest_version": 3,
  "name": "Trackzure",
  "version": "1.0.0",
  "description": "Track time against your assigned work items. Azure DevOps, Jira, and more.",
  "permissions": [
    "storage",
    "alarms"
  ],
  "host_permissions": [
    "https://*/*"
  ],
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "options_page": "options/options.html",
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

> **Note on `host_permissions`**: Using `https://*/*` is broad. For internal company distribution this is fine. For public store submission, narrow it to the user's configured domain dynamically using `chrome.permissions.request()` at runtime after the user enters their server URL in settings.

---

## Timer Architecture

```
┌─────────┐         chrome.storage.local          ┌──────────────┐
│ popup.js │ ◄────── reads activeTimer state ────► │ background.js│
│          │                                       │              │
│  [Start] ──writes──► { workItemId, startedAt } ──msg──► creates alarm
│  [Stop]  ──writes──► clears activeTimer        ──msg──► clears alarm
│          │                                       │              │
│  renders │ ◄── reads elapsed on each open        │  alarm fires │
│  elapsed │                                       │  every 60s:  │
│          │                                       │  ► update     │
│          │                                       │    elapsed in │
│          │                                       │    storage    │
│          │                                       │  ► update     │
└──────────┘                                       │    badge text │
                                                   └──────────────┘
```

## State Shape (`chrome.storage.local`)

```json
{
  "provider": "azure-devops",
  "providerConfig": {
    "baseUrl": "https://tfs.company.com/DefaultCollection",
    "project": "MyProject",
    "apiVersion": "7.0",
    "hosting": "server"
  },
  "workItems": [
    { "id": "1234", "title": "Fix login bug", "state": "Active", "type": "Bug", "url": "https://..." },
    { "id": "5678", "title": "Add search feature", "state": "In Progress", "type": "User Story", "url": "https://..." }
  ],
  "workItemsLastFetched": 1710000000000,
  "activeTimer": {
    "workItemId": "1234",
    "startedAt": 1710000000000,
    "accumulatedMs": 0
  },
  "timeLog": {
    "1234": { "elapsedMs": 3600000, "lastReset": 1710000000000 },
    "5678": { "elapsedMs": 900000, "lastReset": 1710000000000 }
  },
  "settings": {
    "refreshIntervalMin": 5,
    "terminalStates": ["Done", "Closed", "Removed"],
    "rememberToken": false,
    "badgeDisplay": "elapsed"
  }
}
```

## Error Handling

- **Network errors / server unreachable**: Inline toast in popup; service worker retries with exponential backoff (max 3 retries, then surface error).
- **Auth failures (401/403)**: Badge shows ⚠, popup shows "Authentication failed — update your token in Settings" with a direct link.
- **Self-signed cert issues**: If fetch fails with a network error on an `https` on-prem URL, show help text explaining the user needs to trust the certificate in their browser.
- **API version mismatch**: Auto-downgrade `api-version` and retry once; if still failing, surface the server's error message.
- **Timer data preservation**: Time log data is NEVER deleted on error. Only an explicit user action (reset or successful log) clears elapsed time.

## Security Considerations

- **Never store raw passwords** — PAT tokens only.
- **Prefer `chrome.storage.session`** for tokens (auto-cleared on browser close).
- **Sanitize all HTML** rendered in the popup — use `textContent` instead of `innerHTML` where possible; if HTML is needed, sanitize with a whitelist.
- **`host_permissions`**: Narrow to only the configured server domain when possible.
- **No remote code execution**: All JS is bundled locally; no `eval()`, no CDN script loading.

## Coding Conventions

- Use ES modules (`"type": "module"` in manifest for the service worker, `type="module"` in popup script tag).
- `async/await` everywhere — no raw `.then()` chains.
- All `chrome.*` calls wrapped in try/catch.
- CSS custom properties for theming; support `prefers-color-scheme: dark` from day one.
- No inline styles in HTML — all styling in `.css` files.
- Keep the popup under 300ms to interactive — lazy-load non-critical features.

## Future Enhancements (Out of Scope for V1)

- Jira provider implementation.
- Browser notifications after a configurable idle timer threshold.
- Daily/weekly time summary dashboard (new tab page or popup tab).
- Offline queue with sync-on-reconnect.
- Content script that detects work item IDs on web pages (e.g., in PR descriptions) and offers quick-track.
- Bulk time logging at end of day.
- Export time log to CSV.