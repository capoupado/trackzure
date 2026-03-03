/**
 * background.js — Service worker for Trackzure.
 *
 * MV3 constraint: the service worker is killed between events.
 * ALL persistent state lives in chrome.storage. Never rely on in-memory
 * variables surviving across alarm ticks.
 */

import { createProvider, fetchWorkItems, submitTimeLog, fetchPullRequests, fetchMentions, resolveFollowedItem, refreshFollowedItems } from './utils/api.js';
import {
  getSettings,
  getActiveTimer,
  saveActiveTimer,
  clearActiveTimer,
  getTimeLog,
  saveTimeLog,
  getWorkItems,
  saveWorkItems,
  getPullRequests,
  savePullRequests,
  getPRNotificationState,
  savePRNotificationState,
  getFollowedItems,
  saveFollowedItems,
  getMentions,
  saveMentions,
  getProviderConfig,
  getToken,
  getSession,
  setSession,
} from './utils/storage.js';
import { getElapsedMs, stopTimer, startTimer, formatElapsedForBadge } from './utils/timer.js';

const REFRESH_ALARM = 'REFRESH_ALARM';
const TIMER_ALARM = 'TIMER_ALARM';
const BADGE_COLOR_NORMAL = '#0078D4';
const BADGE_COLOR_ERROR = '#D83B01';

// ---------------------------------------------------------------------------
// Provider — ephemeral, rebuilt on each wake
// ---------------------------------------------------------------------------

let _provider = null;

async function initProvider() {
  if (_provider) return _provider;

  try {
    const { type, config } = await getProviderConfig();
    if (!type || !config) return null;

    const pat = await getToken();
    if (!pat) return null;

    _provider = await createProvider(type, { ...config, pat });
    return _provider;
  } catch (err) {
    console.error('[bg] initProvider failed:', err.message);
    _provider = null;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Badge helpers
// ---------------------------------------------------------------------------

function setBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text: String(text ?? '') });
    chrome.action.setBadgeBackgroundColor({ color: color || BADGE_COLOR_NORMAL });
  } catch (err) {
    console.error('[bg] setBadge error:', err);
  }
}

function clearBadge() {
  setBadge('', BADGE_COLOR_NORMAL);
}

// ---------------------------------------------------------------------------
// Push message to popup (fire-and-forget — popup may not be open)
// ---------------------------------------------------------------------------

function pushToPopup(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {
      // Popup is closed — that's fine
    });
  } catch {
    // Ignore
  }
}

// ---------------------------------------------------------------------------
// Alarm setup
// ---------------------------------------------------------------------------

async function ensureAlarms() {
  const settings = await getSettings();

  const existingAlarms = await chrome.alarms.getAll();
  const alarmNames = existingAlarms.map(a => a.name);

  if (!alarmNames.includes(REFRESH_ALARM)) {
    await chrome.alarms.create(REFRESH_ALARM, {
      periodInMinutes: settings.refreshIntervalMin,
      delayInMinutes: settings.refreshIntervalMin,
    });
  }

  if (!alarmNames.includes(TIMER_ALARM)) {
    await chrome.alarms.create(TIMER_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
  }
}

async function recreateRefreshAlarm() {
  await chrome.alarms.clear(REFRESH_ALARM);
  const settings = await getSettings();
  await chrome.alarms.create(REFRESH_ALARM, {
    periodInMinutes: settings.refreshIntervalMin,
    delayInMinutes: settings.refreshIntervalMin,
  });
}

// ---------------------------------------------------------------------------
// Refresh work items with retry / backoff
// ---------------------------------------------------------------------------

const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

async function doRefreshWorkItems(retryCount = 0) {
  const provider = await initProvider();
  if (!provider) return; // not configured yet

  try {
    const [{ workItems: oldItems }, settings] = await Promise.all([getWorkItems(), getSettings()]);
    const items = await fetchWorkItems(provider);

    if (Array.isArray(oldItems) && oldItems.length > 0) {
      try { await notifyWorkItemChanges(oldItems, items, settings); } catch { /* non-fatal */ }
    }

    await saveWorkItems(items);
    pushToPopup({ type: 'ITEMS_UPDATED', count: items.length });
    setBadge('', BADGE_COLOR_NORMAL); // clear any error badge on success
  } catch (err) {
    console.error('[bg] refresh failed:', err.message);

    if (err.code === 'AUTH_FAILURE') {
      setBadge('!', BADGE_COLOR_ERROR);
      pushToPopup({ type: 'AUTH_ERROR', httpStatus: err.httpStatus });
      return;
    }

    if (err.retryable && retryCount < RETRY_DELAYS_MS.length) {
      setTimeout(() => doRefreshWorkItems(retryCount + 1), RETRY_DELAYS_MS[retryCount]);
    } else {
      setBadge('!', BADGE_COLOR_ERROR);
      pushToPopup({ type: 'REFRESH_ERROR', error: err.message });
    }
  }
}

// ---------------------------------------------------------------------------
// Refresh pull requests with retry / backoff
// ---------------------------------------------------------------------------

async function doRefreshPRs(retryCount = 0) {
  const provider = await initProvider();
  if (!provider) return;

  try {
    const [prs, oldState, settings] = await Promise.all([
      fetchPullRequests(provider),
      getPRNotificationState(),
      getSettings(),
    ]);

    await notifyPRChanges(oldState, prs.own || [], prs.reviewing || [], settings);
    await savePullRequests(prs);

    // Update badge immediately if configured to show required PRs
    if (settings.badgeDisplay === 'prRequired') {
      const count = (prs.reviewing || []).filter(pr => pr.isRequired && pr.vote === 0).length;
      setBadge(count > 0 ? String(count) : '', BADGE_COLOR_NORMAL);
    }

    // Build new notification state
    const newState = {
      seenReviewPRIds: [
        ...new Set([
          ...oldState.seenReviewPRIds,
          ...(prs.reviewing || []).map(pr => String(pr.id)),
        ]),
      ],
      ownPRStatuses: Object.fromEntries((prs.own || []).map(pr => [String(pr.id), pr.status])),
      ownPRThreadCounts: Object.fromEntries((prs.own || []).map(pr => [String(pr.id), pr.threadCount ?? 0])),
    };
    await savePRNotificationState(newState);

    pushToPopup({ type: 'PRS_UPDATED' });
  } catch (err) {
    console.error('[bg] PR refresh failed:', err.message);

    if (err.code === 'AUTH_FAILURE') {
      setBadge('!', BADGE_COLOR_ERROR);
      pushToPopup({ type: 'AUTH_ERROR', httpStatus: err.httpStatus });
      return;
    }

    if (err.retryable && retryCount < RETRY_DELAYS_MS.length) {
      setTimeout(() => doRefreshPRs(retryCount + 1), RETRY_DELAYS_MS[retryCount]);
    }
    // PR refresh failure is non-fatal — don't surface error badge
  }
}

// ---------------------------------------------------------------------------
// Refresh followed items
// ---------------------------------------------------------------------------

async function doRefreshFollowedItems() {
  const provider = await initProvider();
  if (!provider) return;

  const currentItems = await getFollowedItems();
  if (currentItems.length === 0) return;

  try {
    const { items, anyNewComments } = await refreshFollowedItems(provider, currentItems);
    await saveFollowedItems(items);
    pushToPopup({ type: 'FOLLOWED_UPDATED', anyNewComments });
  } catch (err) {
    console.error('[bg] followed items refresh failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Refresh mentions with retry / backoff
// ---------------------------------------------------------------------------

async function doRefreshMentions(retryCount = 0) {
  const provider = await initProvider();
  if (!provider) return;

  try {
    const items = await fetchMentions(provider);
    await saveMentions(items);
    pushToPopup({ type: 'MENTIONS_UPDATED', count: items.length });
  } catch (err) {
    console.error('[bg] mentions refresh failed:', err.message);

    if (err.code === 'AUTH_FAILURE') {
      setBadge('!', BADGE_COLOR_ERROR);
      pushToPopup({ type: 'AUTH_ERROR', httpStatus: err.httpStatus });
      return;
    }

    if (err.retryable && retryCount < RETRY_DELAYS_MS.length) {
      setTimeout(() => doRefreshMentions(retryCount + 1), RETRY_DELAYS_MS[retryCount]);
    }
    // Mentions refresh failure is non-fatal — don't surface error badge
  }
}

async function notifyPRChanges(oldState, own, reviewing, settings) {
  const n = settings.notifications ?? {};

  const seenIds = new Set((oldState.seenReviewPRIds || []).map(String));
  const oldStatuses = oldState.ownPRStatuses || {};
  const oldThreadCounts = oldState.ownPRThreadCounts || {};

  // New review assignments
  if (n.prReviewAssigned !== false) {
    for (const pr of reviewing) {
      const id = String(pr.id);
      if (!seenIds.has(id)) {
        const suffix = pr.isRequired ? ' [Required]' : '';
        sendNotification(`pr-review-${id}`, 'New PR review assigned', `#${id}: ${pr.title}${suffix}`);
      }
    }
  }

  // Own PR status changes and new comments
  for (const pr of own) {
    const id = String(pr.id);
    const prevStatus = oldStatuses[id];
    const prevThreadCount = oldThreadCounts[id] ?? pr.threadCount;

    if (prevStatus === 'active' && pr.status === 'completed' && n.prMerged !== false) {
      sendNotification(`pr-completed-${id}`, 'Your PR was merged', `#${id}: ${pr.title}`);
    } else if (prevStatus === 'active' && pr.status === 'abandoned' && n.prAbandoned !== false) {
      sendNotification(`pr-completed-${id}`, 'Your PR was abandoned', `#${id}: ${pr.title}`);
    }

    if ((pr.threadCount ?? 0) > prevThreadCount && n.prNewComment !== false) {
      sendNotification(`pr-comment-${id}`, 'New comment on your PR', `#${id}: ${pr.title}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Timer tick — update badge
// ---------------------------------------------------------------------------

async function doTimerTick() {
  const [activeTimer, settings] = await Promise.all([getActiveTimer(), getSettings()]);

  if (settings.badgeDisplay === 'prRequired') {
    const prs = await getPullRequests();
    const count = (prs.reviewing || []).filter(pr => pr.isRequired && pr.vote === 0).length;
    setBadge(count > 0 ? String(count) : '', BADGE_COLOR_NORMAL);
    return;
  }

  if (!activeTimer) {
    clearBadge();
    return;
  }

  const elapsedMs = getElapsedMs(activeTimer);

  if (settings.badgeDisplay === 'elapsed') {
    setBadge(formatElapsedForBadge(elapsedMs), BADGE_COLOR_NORMAL);
  } else if (settings.badgeDisplay === 'itemId') {
    const id = activeTimer.workItemId;
    setBadge(id.length <= 4 ? id : id.slice(-4), BADGE_COLOR_NORMAL);
  } else {
    clearBadge();
  }
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

async function handleGetStatus() {
  const [activeTimer, timeLog, { workItems, workItemsLastFetched }, settings, pullRequests, followedItems, { mentions, mentionsLastFetched }] = await Promise.all([
    getActiveTimer(),
    getTimeLog(),
    getWorkItems(),
    getSettings(),
    getPullRequests(),
    getFollowedItems(),
    getMentions(),
  ]);
  return { activeTimer, timeLog, workItems, lastFetched: workItemsLastFetched, settings, pullRequests, followedItems, mentions, mentionsLastFetched };
}

async function handleStartTimer({ workItemId }) {
  const [activeTimer, timeLog] = await Promise.all([getActiveTimer(), getTimeLog()]);

  let previousItemId = null;

  // Auto-stop previous timer and accumulate into time log
  if (activeTimer && activeTimer.workItemId !== workItemId) {
    previousItemId = activeTimer.workItemId;
    const { elapsedMs } = stopTimer(activeTimer);
    const updatedLog = { ...timeLog };
    const existing = updatedLog[previousItemId] || { elapsedMs: 0 };
    updatedLog[previousItemId] = {
      elapsedMs: existing.elapsedMs + elapsedMs,
      lastReset: existing.lastReset || Date.now(),
    };
    await saveTimeLog(updatedLog);
  }

  const newTimer = startTimer(workItemId);
  await saveActiveTimer(newTimer);
  await ensureAlarms();

  return { success: true, previousItemId };
}

async function handleStopTimer() {
  const [activeTimer, timeLog] = await Promise.all([getActiveTimer(), getTimeLog()]);
  if (!activeTimer) return { success: true, elapsedMs: 0 };

  const { workItemId, elapsedMs } = stopTimer(activeTimer);

  const updatedLog = { ...timeLog };
  const existing = updatedLog[workItemId] || { elapsedMs: 0 };
  updatedLog[workItemId] = {
    elapsedMs: existing.elapsedMs + elapsedMs,
    lastReset: existing.lastReset || Date.now(),
  };

  await Promise.all([saveTimeLog(updatedLog), clearActiveTimer()]);
  clearBadge();

  return { success: true, elapsedMs: updatedLog[workItemId].elapsedMs };
}

async function handleFetchItems() {
  await Promise.all([doRefreshWorkItems(), doRefreshPRs(), doRefreshMentions()]);
  return { success: true };
}

async function handleLogTime({ workItemId, durationHours, comment }) {
  const provider = await initProvider();
  if (!provider) return { success: false, error: 'Provider not configured. Please check Settings.' };

  const result = await submitTimeLog(provider, workItemId, durationHours, comment);

  if (result.success) {
    // Clear the time log entry for this work item
    const timeLog = await getTimeLog();
    const updatedLog = { ...timeLog };
    delete updatedLog[workItemId];
    await saveTimeLog(updatedLog);

    // Also clear active timer if it was for this item
    const activeTimer = await getActiveTimer();
    if (activeTimer && activeTimer.workItemId === workItemId) {
      await clearActiveTimer();
      clearBadge();
    }
  }

  return result;
}

async function handleFollowItem({ rawId }) {
  const provider = await initProvider();
  if (!provider) return { success: false, error: 'Provider not configured. Please check Settings.' };

  try {
    const item = await resolveFollowedItem(provider, rawId);

    const existing = await getFollowedItems();
    if (existing.some(i => i.id === item.id && i.type === item.type)) {
      return { success: false, error: `#${item.id} is already being followed.` };
    }

    await saveFollowedItems([...existing, item]);
    return { success: true, item };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleUnfollowItem({ id, itemType }) {
  try {
    const existing = await getFollowedItems();
    const filtered = existing.filter(i => !(i.id === id && i.type === itemType));
    await saveFollowedItems(filtered);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleMarkFollowedSeen() {
  try {
    const items = await getFollowedItems();
    const updated = items.map(item => {
      if (item.type !== 'pullRequest') return item;
      return { ...item, lastSeenThreadCount: item.threadCount ?? 0, hasNewComments: false };
    });
    await saveFollowedItems(updated);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleSettingsChanged() {
  _provider = null; // Force provider rebuild
  await recreateRefreshAlarm();
  doRefreshPRs(); // kick off PR refresh in background (no await)
  return { success: true };
}

// F1 — Get valid states for a work item type (cached in session storage)
async function handleGetStateOptions({ workItemType }) {
  const cacheKey = `stateCache_${workItemType}`;
  const cached = await getSession(cacheKey);
  if (cached[cacheKey]) {
    return { success: true, states: cached[cacheKey] };
  }

  const provider = await initProvider();
  if (!provider) return { success: false, error: 'Provider not configured.' };

  try {
    const states = await provider.getWorkItemTypeStates(workItemType);
    await setSession({ [cacheKey]: states });
    return { success: true, states };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// F1 — Update a work item's state and refresh the cache
async function handleUpdateState({ workItemId, newState }) {
  const provider = await initProvider();
  if (!provider) return { success: false, error: 'Provider not configured.' };

  try {
    await provider.updateWorkItemState(workItemId, newState);

    // Optimistically update the cached work items list
    const { workItems } = await getWorkItems();
    if (Array.isArray(workItems)) {
      const updated = workItems.map(wi => wi.id === workItemId ? { ...wi, state: newState } : wi);
      await saveWorkItems(updated);
      pushToPopup({ type: 'ITEMS_UPDATED', count: updated.length });
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// F5 — Diff old vs new work items and send browser notifications
async function notifyWorkItemChanges(oldItems, newItems, settings) {
  const n = settings.notifications ?? {};

  const oldMap = new Map(oldItems.map(wi => [wi.id, wi]));
  const newMap = new Map(newItems.map(wi => [wi.id, wi]));

  const changes = [];

  for (const [id, wi] of newMap) {
    if (!oldMap.has(id)) {
      if (n.workItemAdded !== false) changes.push({ type: 'added', wi });
    } else if (oldMap.get(id).state !== wi.state) {
      if (n.workItemStateChanged !== false) changes.push({ type: 'stateChanged', wi, oldState: oldMap.get(id).state });
    }
  }
  for (const [id, wi] of oldMap) {
    if (!newMap.has(id)) {
      if (n.workItemRemoved !== false) changes.push({ type: 'removed', wi });
    }
  }

  if (changes.length === 0) return;

  if (changes.length > 2) {
    sendNotification('trackzure-summary', 'Trackzure — Work Items Updated', `${changes.length} work items changed since last refresh.`);
    return;
  }

  for (const change of changes) {
    const { wi } = change;
    if (change.type === 'added') {
      sendNotification(`trackzure-added-${wi.id}`, `New item assigned: #${wi.id}`, wi.title);
    } else if (change.type === 'removed') {
      sendNotification(`trackzure-removed-${wi.id}`, `Item resolved/removed: #${wi.id}`, wi.title);
    } else if (change.type === 'stateChanged') {
      sendNotification(`trackzure-state-${wi.id}`, `#${wi.id} — ${change.oldState} → ${wi.state}`, wi.title);
    }
  }
}

function sendNotification(id, title, message) {
  try {
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title,
      message,
    });
  } catch {
    // Non-fatal — notifications permission may have been revoked
  }
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[bg] onInstalled');
  await ensureAlarms();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[bg] onStartup');
  await ensureAlarms();
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === REFRESH_ALARM) {
    await Promise.all([doRefreshWorkItems(), doRefreshPRs(), doRefreshFollowedItems(), doRefreshMentions()]);
  }
  if (alarm.name === TIMER_ALARM) await doTimerTick();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Must return true to signal async response
  handleMessage(message).then(sendResponse).catch(err => {
    console.error('[bg] message handler error:', err);
    sendResponse({ success: false, error: err.message });
  });
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case 'GET_STATUS':
      return handleGetStatus();
    case 'START_TIMER':
      return handleStartTimer(message);
    case 'STOP_TIMER':
      return handleStopTimer();
    case 'FETCH_ITEMS':
      return handleFetchItems();
    case 'LOG_TIME':
      return handleLogTime(message);
    case 'SETTINGS_CHANGED':
      return handleSettingsChanged();
    case 'GET_STATE_OPTIONS':
      return handleGetStateOptions(message);
    case 'UPDATE_STATE':
      return handleUpdateState(message);
    case 'FOLLOW_ITEM':
      return handleFollowItem(message);
    case 'UNFOLLOW_ITEM':
      return handleUnfollowItem(message);
    case 'MARK_FOLLOWED_SEEN':
      return handleMarkFollowedSeen();
    default:
      return { success: false, error: `Unknown message type: ${message.type}` };
  }
}
