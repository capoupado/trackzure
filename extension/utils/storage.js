/**
 * storage.js — Wrappers around chrome.storage (local + session)
 * All functions are async. All chrome.* calls are in try/catch.
 */

export const DEFAULT_SETTINGS = {
  refreshIntervalMin: 5,
  terminalStates: ['Done', 'Closed', 'Removed'],
  allowedWorkItemTypes: [], // empty = show all types
  rememberToken: false,
  badgeDisplay: 'elapsed', // 'elapsed' | 'itemId' | 'off' | 'prRequired'
  notifications: {
    workItemAdded: true,       // new work item assigned to me
    workItemRemoved: true,     // work item resolved / removed
    workItemStateChanged: true, // work item state change
    prReviewAssigned: true,    // new PR review request
    prMerged: true,            // own PR merged
    prAbandoned: true,         // own PR abandoned
    prNewComment: true,        // new comment on own PR
  },
};

// ---------------------------------------------------------------------------
// Raw local / session wrappers
// ---------------------------------------------------------------------------

export async function getLocal(keys) {
  try {
    return await chrome.storage.local.get(keys);
  } catch (err) {
    console.error('[storage] getLocal error:', err);
    return {};
  }
}

export async function setLocal(data) {
  try {
    await chrome.storage.local.set(data);
  } catch (err) {
    console.error('[storage] setLocal error:', err);
  }
}

export async function removeLocal(keys) {
  try {
    await chrome.storage.local.remove(keys);
  } catch (err) {
    console.error('[storage] removeLocal error:', err);
  }
}

export async function getSession(keys) {
  try {
    return await chrome.storage.session.get(keys);
  } catch (err) {
    console.error('[storage] getSession error:', err);
    return {};
  }
}

export async function setSession(data) {
  try {
    await chrome.storage.session.set(data);
  } catch (err) {
    console.error('[storage] setSession error:', err);
  }
}

export async function removeSession(keys) {
  try {
    await chrome.storage.session.remove(keys);
  } catch (err) {
    console.error('[storage] removeSession error:', err);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings() {
  const { settings } = await getLocal('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(s) {
  await setLocal({ settings: s });
}

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------

export async function getWorkItems() {
  const { workItems, workItemsLastFetched } = await getLocal(['workItems', 'workItemsLastFetched']);
  return { workItems: workItems || [], workItemsLastFetched: workItemsLastFetched || null };
}

export async function saveWorkItems(items) {
  await setLocal({ workItems: items, workItemsLastFetched: Date.now() });
}

// ---------------------------------------------------------------------------
// Active timer
// ---------------------------------------------------------------------------

export async function getActiveTimer() {
  const { activeTimer } = await getLocal('activeTimer');
  return activeTimer || null;
}

export async function saveActiveTimer(t) {
  await setLocal({ activeTimer: t });
}

export async function clearActiveTimer() {
  await removeLocal('activeTimer');
}

// ---------------------------------------------------------------------------
// Time log
// ---------------------------------------------------------------------------

export async function getTimeLog() {
  const { timeLog } = await getLocal('timeLog');
  return timeLog || {};
}

export async function saveTimeLog(log) {
  await setLocal({ timeLog: log });
}

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

export async function getProviderConfig() {
  const { provider, providerConfig } = await getLocal(['provider', 'providerConfig']);
  return { type: provider || null, config: providerConfig || null };
}

export async function saveProviderConfig(type, config) {
  await setLocal({ provider: type, providerConfig: config });
}

// ---------------------------------------------------------------------------
// Token — session first, local fallback
// ---------------------------------------------------------------------------

export async function getToken() {
  const sessionData = await getSession('pat');
  if (sessionData.pat) return sessionData.pat;

  // Fallback to local if rememberToken was enabled
  const settings = await getSettings();
  if (settings.rememberToken) {
    const localData = await getLocal('pat');
    return localData.pat || null;
  }

  return null;
}

export async function saveToken(pat, remember) {
  // Always save to session
  await setSession({ pat });

  // Also persist locally if remember is enabled
  if (remember) {
    await setLocal({ pat });
  } else {
    // Clear local copy if remember was toggled off
    await removeLocal('pat');
  }
}

export async function clearToken() {
  await removeSession('pat');
  await removeLocal('pat');
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export async function getPullRequests() {
  const { pullRequests } = await getLocal('pullRequests');
  return pullRequests || { own: [], reviewing: [] };
}

export async function savePullRequests(prs) {
  await setLocal({ pullRequests: prs, pullRequestsLastFetched: Date.now() });
}

// ---------------------------------------------------------------------------
// PR notification state
// ---------------------------------------------------------------------------

export async function getPRNotificationState() {
  const { prNotificationState } = await getLocal('prNotificationState');
  return prNotificationState || { seenReviewPRIds: [], ownPRStatuses: {}, ownPRThreadCounts: {} };
}

export async function savePRNotificationState(state) {
  await setLocal({ prNotificationState: state });
}

// ---------------------------------------------------------------------------
// Followed items
// ---------------------------------------------------------------------------

export async function getFollowedItems() {
  const { followedItems } = await getLocal('followedItems');
  return followedItems || [];
}

export async function saveFollowedItems(items) {
  await setLocal({ followedItems: items });
}

export async function updateFollowedItem(id, updater) {
  const items = await getFollowedItems();
  const updated = items.map(item => item.id === id ? updater(item) : item);
  await saveFollowedItems(updated);
}
