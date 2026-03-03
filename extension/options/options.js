/**
 * options.js — Settings page logic.
 */

import {
  getSettings,
  saveSettings,
  getProviderConfig,
  saveProviderConfig,
  getToken,
  saveToken,
  DEFAULT_SETTINGS,
} from '../utils/storage.js';
import { testConnection } from '../utils/api.js';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $version = document.getElementById('ext-version');
const $provider = document.getElementById('provider-select');
const $serverUrl = document.getElementById('server-url');
const $project = document.getElementById('project-name');
const $pat = document.getElementById('pat-input');
const $patToggle = document.getElementById('pat-toggle');
const $remember = document.getElementById('remember-token');
const $refreshInterval = document.getElementById('refresh-interval');
const $terminalStates = document.getElementById('terminal-states');
const $allowedTypes = document.getElementById('allowed-work-item-types');
const $btnTest = document.getElementById('btn-test');
const $btnSave = document.getElementById('btn-save');
const $btnReset = document.getElementById('btn-reset');
const $statusArea = document.getElementById('status-area');
const $connectionResult = document.getElementById('connection-result');

// Notification checkboxes
const $notifyWiAdded    = document.getElementById('notify-wi-added');
const $notifyWiRemoved  = document.getElementById('notify-wi-removed');
const $notifyWiState    = document.getElementById('notify-wi-state');
const $notifyPrAssigned = document.getElementById('notify-pr-assigned');
const $notifyPrMerged   = document.getElementById('notify-pr-merged');
const $notifyPrAbandoned = document.getElementById('notify-pr-abandoned');
const $notifyPrComment  = document.getElementById('notify-pr-comment');
const $notifyNewMention = document.getElementById('notify-new-mention');
const $notifyFollowedComment = document.getElementById('notify-followed-comment');

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  // Show version
  try {
    const manifest = chrome.runtime.getManifest();
    $version.textContent = `v${manifest.version}`;
  } catch {
    // ignore
  }

  await populateForm();

  $patToggle.addEventListener('click', togglePat);
  $btnTest.addEventListener('click', handleTestConnection);
  $btnSave.addEventListener('click', handleSave);
  $btnReset.addEventListener('click', handleReset);
});

async function populateForm() {
  const [{ type, config }, settings, token] = await Promise.all([
    getProviderConfig(),
    getSettings(),
    getToken(),
  ]);

  // Provider & connection
  if (type) $provider.value = type;
  if (config?.baseUrl) $serverUrl.value = config.baseUrl;
  if (config?.project) $project.value = config.project;
  if (token) $pat.value = token;

  $remember.checked = settings.rememberToken ?? false;

  // Behavior
  $refreshInterval.value = settings.refreshIntervalMin ?? DEFAULT_SETTINGS.refreshIntervalMin;
  $terminalStates.value = (settings.terminalStates ?? DEFAULT_SETTINGS.terminalStates).join(', ');
  $allowedTypes.value = (settings.allowedWorkItemTypes ?? DEFAULT_SETTINGS.allowedWorkItemTypes).join(', ');

  const badgeDisplay = settings.badgeDisplay ?? DEFAULT_SETTINGS.badgeDisplay;
  const badgeRadio = document.querySelector(`input[name="badge-display"][value="${badgeDisplay}"]`);
  if (badgeRadio) badgeRadio.checked = true;

  const n = { ...DEFAULT_SETTINGS.notifications, ...(settings.notifications ?? {}) };
  $notifyWiAdded.checked    = n.workItemAdded;
  $notifyWiRemoved.checked  = n.workItemRemoved;
  $notifyWiState.checked    = n.workItemStateChanged;
  $notifyPrAssigned.checked = n.prReviewAssigned;
  $notifyPrMerged.checked   = n.prMerged;
  $notifyPrAbandoned.checked = n.prAbandoned;
  $notifyPrComment.checked  = n.prNewComment;
  $notifyNewMention.checked = n.newMention;
  $notifyFollowedComment.checked = n.followedItemComment;
}

// ---------------------------------------------------------------------------
// PAT show/hide
// ---------------------------------------------------------------------------

function togglePat() {
  const isPassword = $pat.type === 'password';
  $pat.type = isPassword ? 'text' : 'password';
  $patToggle.textContent = isPassword ? 'Hide' : 'Show';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateForm() {
  const url = $serverUrl.value.trim();
  const project = $project.value.trim();
  const pat = $pat.value.trim();

  const errors = [];

  if (!url) {
    errors.push('Server URL is required.');
  } else if (!url.startsWith('https://')) {
    errors.push('Server URL must start with https://');
  }

  if (!project) {
    errors.push('Project name is required.');
  }

  if (!pat) {
    errors.push('Personal Access Token is required.');
  }

  const intervalVal = parseInt($refreshInterval.value, 10);
  if (isNaN(intervalVal) || intervalVal < 1) {
    errors.push('Refresh interval must be at least 1 minute.');
  }

  return errors;
}

function gatherFormValues() {
  const badgeDisplay =
    document.querySelector('input[name="badge-display"]:checked')?.value ?? 'elapsed';

  const terminalStates = $terminalStates.value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const allowedWorkItemTypes = $allowedTypes.value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  return {
    type: $provider.value,
    config: {
      baseUrl: $serverUrl.value.trim().replace(/\/$/, ''),
      project: $project.value.trim(),
    },
    pat: $pat.value.trim(),
    remember: $remember.checked,
    settings: {
      refreshIntervalMin: parseInt($refreshInterval.value, 10),
      terminalStates,
      allowedWorkItemTypes,
      rememberToken: $remember.checked,
      badgeDisplay,
      notifications: {
        workItemAdded:      $notifyWiAdded.checked,
        workItemRemoved:    $notifyWiRemoved.checked,
        workItemStateChanged: $notifyWiState.checked,
        prReviewAssigned:   $notifyPrAssigned.checked,
        prMerged:           $notifyPrMerged.checked,
        prAbandoned:        $notifyPrAbandoned.checked,
        prNewComment:       $notifyPrComment.checked,
        newMention:         $notifyNewMention.checked,
        followedItemComment: $notifyFollowedComment.checked,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Test Connection
// ---------------------------------------------------------------------------

async function handleTestConnection() {
  $connectionResult.className = 'info';
  $connectionResult.innerHTML = '<span class="spinner"></span> Testing connection…';
  $connectionResult.style.display = 'block';
  $btnTest.disabled = true;

  const url = $serverUrl.value.trim().replace(/\/$/, '');
  const project = $project.value.trim();
  const pat = $pat.value.trim();

  if (!url || !pat) {
    $connectionResult.className = 'error';
    $connectionResult.textContent = 'Please fill in the Server URL and PAT before testing.';
    $btnTest.disabled = false;
    return;
  }

  try {
    const result = await testConnection($provider.value, { baseUrl: url, project, pat });

    if (result.success) {
      $connectionResult.className = 'success';
      $connectionResult.textContent = `Connected as: ${result.user?.displayName ?? 'Unknown'}`;
    } else {
      $connectionResult.className = 'error';
      $connectionResult.textContent = `Connection failed: ${result.error}`;
    }
  } catch (err) {
    $connectionResult.className = 'error';
    $connectionResult.textContent = `Error: ${err.message}`;
  } finally {
    $btnTest.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

async function handleSave() {
  const errors = validateForm();
  if (errors.length > 0) {
    showStatus('error', errors.join(' '));
    return;
  }

  $btnSave.disabled = true;
  const { type, config, pat, remember, settings } = gatherFormValues();

  try {
    await Promise.all([
      saveProviderConfig(type, config),
      saveToken(pat, remember),
      saveSettings(settings),
    ]);

    // Notify background to rebuild provider and refresh alarms
    try {
      await chrome.runtime.sendMessage({ type: 'SETTINGS_CHANGED' });
    } catch {
      // Background may not be ready — that's OK
    }

    showStatus('success', 'Settings saved successfully.');
  } catch (err) {
    showStatus('error', `Failed to save settings: ${err.message}`);
  } finally {
    $btnSave.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

async function handleReset() {
  if (!confirm('Reset all settings to their defaults? Your connection details will not be cleared.')) {
    return;
  }

  await saveSettings({ ...DEFAULT_SETTINGS });
  await populateForm();
  showStatus('success', 'Settings reset to defaults.');
}

// ---------------------------------------------------------------------------
// Status helper
// ---------------------------------------------------------------------------

function showStatus(type, message) {
  $statusArea.className = type;
  $statusArea.textContent = message;
  // Auto-hide after 5s
  clearTimeout($statusArea._hideTimer);
  $statusArea._hideTimer = setTimeout(() => {
    $statusArea.className = '';
    $statusArea.style.display = 'none';
  }, 5000);
}
