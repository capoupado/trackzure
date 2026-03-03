/**
 * popup.js — Trackzure popup UI logic.
 *
 * Security: textContent used everywhere user-supplied data is rendered.
 * Never set innerHTML with untrusted data.
 */

import { getElapsedMs, formatElapsed, msToHours, parseManualEntry } from '../utils/timer.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let state = {
  activeTimer: null,
  timeLog: {},
  workItems: [],
  lastFetched: null,
  settings: {},
  pullRequests: { own: [], reviewing: [] },
  followedItems: [],
};

let _tickInterval = null;
let _pendingLogWorkItemId = null;
let _activeIterationFilter = null; // F3
let _openStateDropdownId = null;   // F1

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $list = document.getElementById('work-item-list');
const $emptyState = document.getElementById('empty-state');
const $errorState = document.getElementById('error-state');
const $setupState = document.getElementById('setup-state');
const $errorMsg = document.getElementById('error-msg');
const $authBanner = document.getElementById('auth-banner');
const $authBannerMsg = document.getElementById('auth-banner-msg');
const $dialog = document.getElementById('log-time-dialog');
const $dialogTitle = document.getElementById('dialog-title');
const $dialogItemTitle = document.getElementById('dialog-item-title');
const $dialogDuration = document.getElementById('dialog-duration');
const $dialogComment = document.getElementById('dialog-comment');
const $dialogError = document.getElementById('dialog-error');
const $dialogCancel = document.getElementById('dialog-cancel');
const $dialogSubmit = document.getElementById('dialog-submit');
const $toast = document.getElementById('toast');
const $filterBtn = document.getElementById('btn-filter');   // F3
const $filterPanel = document.getElementById('filter-panel'); // F3
const $filterList = document.getElementById('filter-list');   // F3

// PR panel refs
const $prOwnList = document.getElementById('pr-own-list');
const $prReviewList = document.getElementById('pr-review-list');
const $prEmptyState = document.getElementById('pr-empty-state');
const $prErrorState = document.getElementById('pr-error-state');
const $prSetupState = document.getElementById('pr-setup-state');

// Following panel refs
const $followTypeSelect = document.getElementById('follow-type-select');
const $followInput = document.getElementById('follow-input');
const $btnFollowAdd = document.getElementById('btn-follow-add');
const $btnFollowCurrent = document.getElementById('btn-follow-current');
const $followedList = document.getElementById('followed-list');
const $followingEmptyState = document.getElementById('following-empty-state');
const $followError = document.getElementById('follow-error');
const $tabFollowingBadge = document.getElementById('tab-following-badge');

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  // Tab navigation
  initTabs();

  // Bind static controls
  document.getElementById('btn-refresh').addEventListener('click', triggerRefresh);
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-empty-refresh').addEventListener('click', triggerRefresh);
  document.getElementById('btn-retry').addEventListener('click', triggerRefresh);
  document.getElementById('btn-setup').addEventListener('click', openSettings);
  document.getElementById('auth-banner-settings').addEventListener('click', openSettings);
  document.getElementById('btn-pr-retry')?.addEventListener('click', triggerRefresh);
  $dialogCancel.addEventListener('click', closeDialog);
  $dialogSubmit.addEventListener('click', handleDialogSubmit);

  // Following tab controls
  $btnFollowAdd.addEventListener('click', handleFollowAdd);
  $followInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleFollowAdd(); });
  $btnFollowCurrent.addEventListener('click', handleFollowCurrentPage);

  // F3 — Filter panel
  $filterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFilterPanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFilterPanel();
  });
  document.addEventListener('click', handleOutsideClick);

  // F1 — Close state dropdowns on outside click
  document.addEventListener('click', closeAllStateDropdowns);

  // Close dialog on backdrop click
  $dialog.addEventListener('click', e => {
    if (e.target === $dialog) closeDialog();
  });

  // Start listening for background push messages
  chrome.runtime.onMessage.addListener(handlePushMessage);

  // Load initial state from background
  await refreshState();

  // Start 1-second tick for live elapsed display
  _tickInterval = setInterval(tickElapsed, 1000);
});

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

async function refreshState() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (!status) {
      showSetupState();
      return;
    }
    state = { ...state, ...status };
    render();
    renderPRs(state.pullRequests);
    renderFollowedItems(state.followedItems);
    updateFollowingTabBadge(state.followedItems);

    // Trigger a fresh fetch if data is stale (> refreshIntervalMin)
    const intervalMs = (state.settings?.refreshIntervalMin ?? 5) * 60_000;
    const age = state.lastFetched ? Date.now() - state.lastFetched : Infinity;
    if (age > intervalMs) {
      triggerRefresh();
    }
  } catch (err) {
    console.error('[popup] refreshState error:', err);
    showErrorState('Could not connect to the extension background. Try reloading.');
  }
}

async function triggerRefresh() {
  try {
    await chrome.runtime.sendMessage({ type: 'FETCH_ITEMS' });
    await refreshState();
  } catch (err) {
    console.error('[popup] triggerRefresh error:', err);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  const { workItems } = state;

  // Determine if the extension is configured
  if (workItems === null || workItems === undefined) {
    showSetupState();
    return;
  }

  hideAllStates();

  const allowedTypes = state.settings?.allowedWorkItemTypes;
  const filteredItems = (allowedTypes && allowedTypes.length > 0)
    ? workItems.filter(wi => allowedTypes.includes(wi.type))
    : workItems;

  // F3 — Iteration filter
  const iterationFiltered = _activeIterationFilter
    ? filteredItems.filter(wi => wi.iterationPath === _activeIterationFilter)
    : filteredItems;

  if (iterationFiltered.length === 0) {
    $emptyState.hidden = false;
    return;
  }

  renderWorkItems(iterationFiltered, state.activeTimer, state.timeLog);
}

const STATE_ORDER = {
  'In Progress': 0,
  'Active': 1,
  'New': 2,
};

function getStateOrder(stateStr) {
  return STATE_ORDER[stateStr] ?? 99;
}

function renderWorkItems(workItems, activeTimer, timeLog) {
  const sorted = [...workItems].sort((a, b) => {
    const diff = getStateOrder(a.state) - getStateOrder(b.state);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });

  // Clear and rebuild list
  $list.textContent = '';

  for (const item of sorted) {
    const li = buildWorkItemRow(item, activeTimer, timeLog);
    $list.appendChild(li);
  }
}

function buildWorkItemRow(item, activeTimer, timeLog) {
  const isRunning = activeTimer?.workItemId === item.id;
  const logEntry = timeLog?.[item.id] || { elapsedMs: 0 };
  const accumulatedMs = logEntry.elapsedMs || 0;
  const displayMs = isRunning ? getElapsedMs(activeTimer) + accumulatedMs : accumulatedMs;

  const li = document.createElement('li');
  li.className = 'work-item';
  li.dataset.id = item.id;

  // Info section
  const infoDiv = document.createElement('div');
  infoDiv.className = 'work-item-info';

  // Title row
  const titleRow = document.createElement('div');
  titleRow.className = 'work-item-title-row';

  const idLink = document.createElement('span');
  idLink.className = 'work-item-id';
  idLink.textContent = `#${item.id}`;
  idLink.title = `Open #${item.id} in Azure DevOps`;
  idLink.addEventListener('click', () => {
    if (item.url) window.open(item.url, '_blank');
  });

  const title = document.createElement('span');
  title.className = 'work-item-title';
  title.textContent = item.title;
  title.title = item.title;

  titleRow.appendChild(idLink);
  titleRow.appendChild(title);

  // Meta row
  const metaRow = document.createElement('div');
  metaRow.className = 'work-item-meta';

  // F1 — Badge wrapper for state dropdown
  const badgeWrapper = document.createElement('div');
  badgeWrapper.className = 'badge-wrapper';

  const badge = document.createElement('span');
  badge.className = `badge ${getStateBadgeClass(item.state)} badge--clickable`;
  badge.textContent = item.state;
  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleStateDropdown(item, badgeWrapper, badge);
  });

  badgeWrapper.appendChild(badge);

  const type = document.createElement('span');
  type.className = 'work-item-type';
  type.textContent = item.type;

  const elapsed = document.createElement('span');
  elapsed.className = `elapsed${isRunning ? ' active' : ''}`;
  elapsed.dataset.itemId = item.id;
  elapsed.textContent = displayMs > 0 ? formatElapsed(displayMs) : '';

  metaRow.appendChild(badgeWrapper);
  metaRow.appendChild(type);
  metaRow.appendChild(elapsed);

  infoDiv.appendChild(titleRow);

  // F2 — Parent link
  if (item.parentId) {
    const parentRow = document.createElement('div');
    parentRow.className = 'work-item-parent';
    const parentText = item.parentTitle ? `↳ ${item.parentTitle}` : `↳ #${item.parentId}`;
    parentRow.textContent = parentText;
    parentRow.title = parentText;
    if (item.parentUrl) {
      parentRow.classList.add('work-item-parent--link');
      parentRow.addEventListener('click', () => window.open(item.parentUrl, '_blank'));
    }
    infoDiv.appendChild(parentRow);
  }

  infoDiv.appendChild(metaRow);

  // Actions section
  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'work-item-actions';

  const timerBtn = document.createElement('button');
  timerBtn.className = `btn-timer${isRunning ? ' running' : ''}`;
  timerBtn.textContent = isRunning ? '⏹ Stop' : '▶ Start';
  timerBtn.setAttribute('aria-label', isRunning ? `Stop timer for #${item.id}` : `Start timer for #${item.id}`);
  timerBtn.addEventListener('click', () => handleTimerToggle(item));

  const logBtn = document.createElement('button');
  logBtn.className = 'btn-log';
  logBtn.textContent = 'Log';
  logBtn.setAttribute('aria-label', `Log time for #${item.id}`);
  logBtn.addEventListener('click', () => openLogDialog(item, displayMs));

  actionsDiv.appendChild(timerBtn);
  actionsDiv.appendChild(logBtn);

  li.appendChild(infoDiv);
  li.appendChild(actionsDiv);

  return li;
}

function getStateBadgeClass(stateStr) {
  const s = (stateStr || '').toLowerCase().replace(/\s+/g, '-');
  if (s === 'in-progress') return 'badge--in-progress';
  if (s === 'active') return 'badge--active';
  if (s === 'new') return 'badge--new';
  if (s === 'resolved' || s === 'done' || s === 'closed') return 'badge--resolved';
  return 'badge--default';
}

// ---------------------------------------------------------------------------
// Live tick — update elapsed display every second
// ---------------------------------------------------------------------------

function tickElapsed() {
  const { activeTimer, timeLog } = state;
  if (!activeTimer) return;

  const { workItemId } = activeTimer;
  const liveMs = getElapsedMs(activeTimer);
  const logEntry = timeLog?.[workItemId] || { elapsedMs: 0 };
  const totalMs = liveMs + (logEntry.elapsedMs || 0);

  const elapsedSpan = document.querySelector(`.elapsed[data-item-id="${workItemId}"]`);
  if (elapsedSpan) {
    elapsedSpan.textContent = formatElapsed(totalMs);
  }
}

// ---------------------------------------------------------------------------
// Timer controls
// ---------------------------------------------------------------------------

async function handleTimerToggle(item) {
  const { activeTimer } = state;
  const isRunning = activeTimer?.workItemId === item.id;

  if (isRunning) {
    const result = await chrome.runtime.sendMessage({ type: 'STOP_TIMER' });
    if (result?.success) {
      showToast(`Stopped timer for #${item.id}`);
    }
  } else {
    const result = await chrome.runtime.sendMessage({ type: 'START_TIMER', workItemId: item.id });
    if (result?.success) {
      if (result.previousItemId) {
        showToast(`Switched from #${result.previousItemId} to #${item.id}`);
      } else {
        showToast(`Started timer for #${item.id}`);
      }
    }
  }

  await refreshState();
}

// ---------------------------------------------------------------------------
// F1 — State dropdown
// ---------------------------------------------------------------------------

async function toggleStateDropdown(item, wrapperEl, badgeEl) {
  // If this dropdown is already open, close it
  if (_openStateDropdownId === item.id) {
    closeAllStateDropdowns();
    return;
  }

  // Close any existing dropdown first
  closeAllStateDropdowns();

  badgeEl.classList.add('badge--loading');

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'GET_STATE_OPTIONS',
      workItemType: item.type,
    });

    if (result?.success && result.states) {
      _openStateDropdownId = item.id;
      renderStateDropdown(item, wrapperEl, badgeEl, result.states);
    } else {
      showToast(result?.error || 'Could not load states', 'error');
    }
  } catch (err) {
    showToast(`Error loading states: ${err.message}`, 'error');
  } finally {
    badgeEl.classList.remove('badge--loading');
  }
}

function renderStateDropdown(item, wrapperEl, badgeEl, states) {
  const ul = document.createElement('ul');
  ul.className = 'state-dropdown';

  for (const s of states) {
    const li = document.createElement('li');
    li.className = `state-dropdown__item${s.name === item.state ? ' state-dropdown__item--current' : ''}`;

    const dot = document.createElement('span');
    dot.className = 'state-dropdown__dot';
    dot.style.background = s.color ? `#${s.color}` : '#888';

    const label = document.createElement('span');
    label.textContent = s.name;

    li.appendChild(dot);
    li.appendChild(label);
    li.addEventListener('click', (e) => {
      e.stopPropagation();
      selectNewState(item, s.name);
    });

    ul.appendChild(li);
  }

  // Append hidden first so we can measure actual height before positioning
  ul.style.visibility = 'hidden';
  document.body.appendChild(ul);

  const rect = wrapperEl.getBoundingClientRect();
  const dropH = ul.offsetHeight;
  const spaceBelow = window.innerHeight - rect.bottom - 4;
  const spaceAbove = rect.top - 4;

  let top;
  if (dropH <= spaceBelow) {
    top = rect.bottom + 4;
  } else if (dropH <= spaceAbove) {
    top = rect.top - dropH - 4;
  } else if (spaceBelow >= spaceAbove) {
    ul.style.maxHeight = `${spaceBelow}px`;
    ul.style.overflowY = 'auto';
    top = rect.bottom + 4;
  } else {
    ul.style.maxHeight = `${spaceAbove}px`;
    ul.style.overflowY = 'auto';
    top = 4;
  }

  ul.style.top = `${top}px`;
  ul.style.left = `${Math.min(rect.left, window.innerWidth - 148)}px`;
  ul.style.visibility = '';
}

async function selectNewState(item, newState) {
  closeAllStateDropdowns();
  if (newState === item.state) return;

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'UPDATE_STATE',
      workItemId: item.id,
      newState,
      workItemType: item.type,
    });

    if (result?.success) {
      showToast(`#${item.id} → ${newState}`);
      await refreshState();
    } else {
      showToast(result?.error || 'Failed to update state', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

function closeAllStateDropdowns() {
  document.querySelectorAll('.state-dropdown').forEach(el => el.remove());
  _openStateDropdownId = null;
}

// ---------------------------------------------------------------------------
// F3 — Iteration filter panel
// ---------------------------------------------------------------------------

function toggleFilterPanel() {
  if ($filterPanel.hidden) {
    openFilterPanel();
  } else {
    closeFilterPanel();
  }
}

function openFilterPanel() {
  buildFilterList();
  $filterPanel.hidden = false;
  $filterBtn.setAttribute('aria-expanded', 'true');
}

function closeFilterPanel() {
  $filterPanel.hidden = true;
  $filterBtn.setAttribute('aria-expanded', 'false');
}

function buildFilterList() {
  const paths = [...new Set(
    (state.workItems || []).map(wi => wi.iterationPath).filter(Boolean)
  )].sort();

  $filterList.textContent = '';

  // "All iterations" option
  const allLi = document.createElement('li');
  allLi.className = `filter-option${_activeIterationFilter === null ? ' filter-option--active' : ''}`;
  allLi.textContent = 'All iterations';
  allLi.setAttribute('role', 'option');
  allLi.addEventListener('click', (e) => {
    e.stopPropagation();
    _activeIterationFilter = null;
    updateFilterBadge();
    closeFilterPanel();
    render();
  });
  $filterList.appendChild(allLi);

  for (const path of paths) {
    const li = document.createElement('li');
    li.className = `filter-option${_activeIterationFilter === path ? ' filter-option--active' : ''}`;
    // Display last segment of the backslash-separated path
    const segments = path.split('\\');
    const label = segments[segments.length - 1];
    li.textContent = label;
    li.title = path;
    li.setAttribute('role', 'option');
    li.addEventListener('click', (e) => {
      e.stopPropagation();
      _activeIterationFilter = path;
      updateFilterBadge();
      closeFilterPanel();
      render();
    });
    $filterList.appendChild(li);
  }
}

function updateFilterBadge() {
  if (_activeIterationFilter) {
    $filterBtn.classList.add('btn-icon--active');
  } else {
    $filterBtn.classList.remove('btn-icon--active');
  }
}

function handleOutsideClick(e) {
  if (!$filterPanel.hidden && !$filterPanel.contains(e.target) && !$filterBtn.contains(e.target)) {
    closeFilterPanel();
  }
}

// ---------------------------------------------------------------------------
// Log Time dialog
// ---------------------------------------------------------------------------

function openLogDialog(item, displayMs) {
  _pendingLogWorkItemId = item.id;

  $dialogTitle.textContent = 'Log Time';
  $dialogItemTitle.textContent = `#${item.id} — ${item.title}`;
  $dialogDuration.value = displayMs > 0 ? String(msToHours(displayMs)) : '';
  $dialogComment.value = '';
  $dialogError.className = 'dialog-error';
  $dialogError.textContent = '';
  $dialogSubmit.disabled = false;

  $dialog.showModal();
  $dialogDuration.focus();
}

function closeDialog() {
  $dialog.close();
  _pendingLogWorkItemId = null;
}

async function handleDialogSubmit() {
  const durationStr = $dialogDuration.value.trim();
  const comment = $dialogComment.value.trim();

  const durationHours = parseManualEntry(durationStr);
  if (!durationHours || durationHours <= 0) {
    $dialogError.textContent = 'Please enter a valid duration (e.g. 1.5 or 90m).';
    $dialogError.className = 'dialog-error visible';
    return;
  }

  $dialogSubmit.disabled = true;
  $dialogError.className = 'dialog-error';

  const commentText = comment
    ? `${comment} (logged via Trackzure)`
    : 'Time logged via Trackzure';

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'LOG_TIME',
      workItemId: _pendingLogWorkItemId,
      durationHours,
      comment: commentText,
    });

    if (result?.success) {
      closeDialog();
      showToast(result.warning ? `Logged — ${result.warning}` : 'Time logged successfully!');
      await refreshState();
    } else {
      $dialogError.textContent = result?.error || 'Failed to log time. Please try again.';
      $dialogError.className = 'dialog-error visible';
      $dialogSubmit.disabled = false;
    }
  } catch (err) {
    $dialogError.textContent = `Error: ${err.message}`;
    $dialogError.className = 'dialog-error visible';
    $dialogSubmit.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Background push message handler
// ---------------------------------------------------------------------------

function handlePushMessage(message) {
  if (message.type === 'ITEMS_UPDATED') {
    refreshState();
  } else if (message.type === 'PRS_UPDATED') {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, status => {
      if (status?.pullRequests) {
        state.pullRequests = status.pullRequests;
        renderPRs(status.pullRequests);
      }
    });
  } else if (message.type === 'FOLLOWED_UPDATED') {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, status => {
      if (status?.followedItems) {
        state.followedItems = status.followedItems;
        renderFollowedItems(status.followedItems);
        updateFollowingTabBadge(status.followedItems);
      }
    });
  } else if (message.type === 'AUTH_ERROR') {
    $authBannerMsg.textContent = `Authentication failed (HTTP ${message.httpStatus || ''}) — update your token in Settings.`;
    $authBanner.classList.add('visible');
  } else if (message.type === 'REFRESH_ERROR') {
    showToast(`Refresh failed: ${message.error}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// UI state helpers
// ---------------------------------------------------------------------------

function hideAllStates() {
  $emptyState.hidden = true;
  $errorState.hidden = true;
  $setupState.hidden = true;
  $list.textContent = '';
}

function showErrorState(msg) {
  hideAllStates();
  $errorMsg.textContent = msg || 'Could not load work items.';
  $errorState.hidden = false;
}

function showSetupState() {
  hideAllStates();
  $setupState.hidden = false;
}

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    const active = b.dataset.tab === tabId;
    b.classList.toggle('tab-btn--active', active);
    b.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.hidden = p.id !== `panel-${tabId}`;
  });
  if (tabId === 'following') {
    handleFollowingTabOpened();
  }
}

function handleFollowingTabOpened() {
  // Optimistically clear new-comment flags in local state
  state.followedItems = state.followedItems.map(item =>
    item.type === 'pullRequest' ? { ...item, hasNewComments: false } : item
  );
  updateFollowingTabBadge(state.followedItems);
  renderFollowedItems(state.followedItems);

  // Persist to background
  chrome.runtime.sendMessage({ type: 'MARK_FOLLOWED_SEEN' }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Pull Requests rendering
// ---------------------------------------------------------------------------

function renderPRs(pullRequests) {
  const own = pullRequests?.own || [];
  const reviewing = pullRequests?.reviewing || [];

  // Hide all PR states
  $prEmptyState.hidden = true;
  $prErrorState.hidden = true;
  $prSetupState.hidden = true;
  $prOwnList.textContent = '';
  $prReviewList.textContent = '';

  const ownSection = $prOwnList.closest('.pr-section');
  const reviewSection = $prReviewList.closest('.pr-section');

  if (own.length === 0 && reviewing.length === 0) {
    $prEmptyState.hidden = false;
    if (ownSection) ownSection.hidden = true;
    if (reviewSection) reviewSection.hidden = true;
    return;
  }

  if (ownSection) ownSection.hidden = own.length === 0;
  if (reviewSection) reviewSection.hidden = reviewing.length === 0;

  // Sort own: active first, then alphabetical
  const sortedOwn = [...own].sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (a.status !== 'active' && b.status === 'active') return 1;
    return a.title.localeCompare(b.title);
  });

  for (const pr of sortedOwn) {
    $prOwnList.appendChild(buildOwnPRRow(pr));
  }

  // Sort reviewing: Required first, then by createdDate desc
  const sortedReview = [...reviewing].sort((a, b) => {
    if (a.isRequired && !b.isRequired) return -1;
    if (!a.isRequired && b.isRequired) return 1;
    return new Date(b.createdDate || 0) - new Date(a.createdDate || 0);
  });

  for (const pr of sortedReview) {
    $prReviewList.appendChild(buildReviewPRRow(pr));
  }
}

function buildOwnPRRow(pr) {
  const li = document.createElement('li');
  li.className = 'pr-item';

  const main = document.createElement('div');
  main.className = 'pr-main';

  const idLink = document.createElement('a');
  idLink.className = 'pr-id';
  idLink.textContent = `#${pr.id}`;
  idLink.title = `Open PR #${pr.id}`;
  idLink.href = '#';
  idLink.addEventListener('click', e => { e.preventDefault(); window.open(pr.url, '_blank'); });

  const title = document.createElement('span');
  title.className = 'pr-title';
  title.textContent = pr.title;
  title.title = pr.title;

  main.appendChild(idLink);
  main.appendChild(title);

  if (pr.isDraft) {
    const draft = document.createElement('span');
    draft.className = 'pr-draft-tag';
    draft.textContent = 'Draft';
    main.appendChild(draft);
  }

  const meta = document.createElement('div');
  meta.className = 'pr-meta';

  const approvals = document.createElement('span');
  approvals.textContent = `${pr.approvedCount}/${pr.reviewerCount} approved`;
  meta.appendChild(approvals);

  if (pr.sourceBranch || pr.targetBranch) {
    const branch = document.createElement('span');
    branch.className = 'pr-branch';
    branch.textContent = `${pr.sourceBranch} → ${pr.targetBranch}`;
    meta.appendChild(branch);
  }

  li.appendChild(main);
  li.appendChild(meta);
  return li;
}

function buildReviewPRRow(pr) {
  const li = document.createElement('li');
  li.className = 'pr-item';

  const main = document.createElement('div');
  main.className = 'pr-main';

  const idLink = document.createElement('a');
  idLink.className = 'pr-id';
  idLink.textContent = `#${pr.id}`;
  idLink.title = `Open PR #${pr.id}`;
  idLink.href = '#';
  idLink.addEventListener('click', e => { e.preventDefault(); window.open(pr.url, '_blank'); });

  const title = document.createElement('span');
  title.className = 'pr-title';
  title.textContent = pr.title;
  title.title = pr.title;

  const reviewerBadge = document.createElement('span');
  reviewerBadge.className = `reviewer-badge reviewer-badge--${pr.isRequired ? 'required' : 'optional'}`;
  reviewerBadge.textContent = pr.isRequired ? 'Required' : 'Optional';

  main.appendChild(idLink);
  main.appendChild(title);
  main.appendChild(reviewerBadge);

  if (pr.isDraft) {
    const draft = document.createElement('span');
    draft.className = 'pr-draft-tag';
    draft.textContent = 'Draft';
    main.appendChild(draft);
  }

  const meta = document.createElement('div');
  meta.className = 'pr-meta';

  const voteBadge = document.createElement('span');
  voteBadge.className = `vote-badge ${getVoteBadgeClass(pr.vote)}`;
  voteBadge.textContent = getVoteLabel(pr.vote);
  meta.appendChild(voteBadge);

  if (pr.createdBy) {
    const by = document.createElement('span');
    by.textContent = `by ${pr.createdBy}`;
    meta.appendChild(by);
  }

  if (pr.sourceBranch || pr.targetBranch) {
    const branch = document.createElement('span');
    branch.className = 'pr-branch';
    branch.textContent = `${pr.sourceBranch} → ${pr.targetBranch}`;
    meta.appendChild(branch);
  }

  li.appendChild(main);
  li.appendChild(meta);
  return li;
}

function getVoteBadgeClass(vote) {
  if (vote === 10) return 'vote-badge--approved';
  if (vote === -10) return 'vote-badge--rejected';
  if (vote === 5) return 'vote-badge--suggestions';
  return 'vote-badge--pending';
}

function getVoteLabel(vote) {
  if (vote === 10) return '✓ Approved';
  if (vote === -10) return '✗ Rejected';
  if (vote === 5) return '~ Suggestions';
  return '○ No vote';
}

// ---------------------------------------------------------------------------
// Following tab
// ---------------------------------------------------------------------------

async function handleFollowAdd() {
  const num = $followInput.value.trim();
  if (!num) return;

  const prefix = $followTypeSelect.value === 'pr' ? '!' : '#';
  const rawId = `${prefix}${num}`;

  hideFollowError();
  $btnFollowAdd.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({ type: 'FOLLOW_ITEM', rawId });
    if (result?.success) {
      $followInput.value = '';
      state.followedItems = [...state.followedItems, result.item];
      renderFollowedItems(state.followedItems);
      showToast(`Following #${result.item.id}`);
    } else {
      showFollowError(result?.error || 'Could not follow that item.');
    }
  } catch (err) {
    showFollowError(`Error: ${err.message}`);
  } finally {
    $btnFollowAdd.disabled = false;
  }
}

async function handleFollowCurrentPage() {
  hideFollowError();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';

    const wiMatch = url.match(/\/_workitems\/edit\/(\d+)/);
    const prMatch = url.match(/\/pullrequest\/(\d+)/);

    if (wiMatch) {
      $followTypeSelect.value = 'wi';
      $followInput.value = wiMatch[1];
    } else if (prMatch) {
      $followTypeSelect.value = 'pr';
      $followInput.value = prMatch[1];
    } else {
      showFollowError('Current page is not an Azure DevOps work item or pull request.');
      return;
    }

    await handleFollowAdd();
  } catch (err) {
    showFollowError(`Could not read current tab: ${err.message}`);
  }
}

async function handleUnfollow(item) {
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'UNFOLLOW_ITEM',
      id: item.id,
      itemType: item.type,
    });
    if (result?.success) {
      state.followedItems = state.followedItems.filter(i => !(i.id === item.id && i.type === item.type));
      renderFollowedItems(state.followedItems);
      updateFollowingTabBadge(state.followedItems);
      showToast(`Unfollowed #${item.id}`);
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

function renderFollowedItems(items) {
  $followedList.textContent = '';

  if (!items || items.length === 0) {
    $followingEmptyState.hidden = false;
    return;
  }

  $followingEmptyState.hidden = true;

  // Sort: new-comments first, then addedAt desc
  const sorted = [...items].sort((a, b) => {
    const aNew = a.hasNewComments ? 1 : 0;
    const bNew = b.hasNewComments ? 1 : 0;
    if (bNew !== aNew) return bNew - aNew;
    return (b.addedAt || 0) - (a.addedAt || 0);
  });

  for (const item of sorted) {
    $followedList.appendChild(buildFollowedItemRow(item));
  }
}

function buildFollowedItemRow(item) {
  const li = document.createElement('li');
  li.className = `followed-item${item.hasNewComments ? ' followed-item--new-comments' : ''}`;

  const infoDiv = document.createElement('div');
  infoDiv.className = 'followed-item-info';

  // Title row
  const titleRow = document.createElement('div');
  titleRow.className = 'followed-item-title-row';

  const idLink = document.createElement('span');
  idLink.className = 'work-item-id';
  idLink.textContent = `#${item.id}`;
  idLink.title = `Open #${item.id}`;
  idLink.addEventListener('click', () => { if (item.url) window.open(item.url, '_blank'); });

  const typeTag = document.createElement('span');
  typeTag.className = `followed-type-tag followed-type-tag--${item.type === 'workItem' ? 'wi' : 'pr'}`;
  typeTag.textContent = item.type === 'workItem' ? 'WI' : 'PR';

  const titleSpan = document.createElement('span');
  titleSpan.className = 'work-item-title';
  titleSpan.textContent = item.title;
  titleSpan.title = item.title;

  titleRow.appendChild(idLink);
  titleRow.appendChild(typeTag);
  titleRow.appendChild(titleSpan);

  // Meta row
  const metaRow = document.createElement('div');
  metaRow.className = 'followed-item-meta';

  if (item.type === 'workItem') {
    const stateBadge = document.createElement('span');
    stateBadge.className = `badge ${getStateBadgeClass(item.state)}`;
    stateBadge.textContent = item.state;
    metaRow.appendChild(stateBadge);

    if (item.workItemType) {
      const wiType = document.createElement('span');
      wiType.className = 'work-item-type';
      wiType.textContent = item.workItemType;
      metaRow.appendChild(wiType);
    }
  } else {
    // PR
    const statusBadge = document.createElement('span');
    statusBadge.className = `badge ${getPRStatusBadgeClass(item.status)}`;
    statusBadge.textContent = item.status || 'active';
    metaRow.appendChild(statusBadge);

    if (item.isDraft) {
      const draft = document.createElement('span');
      draft.className = 'pr-draft-tag';
      draft.textContent = 'Draft';
      metaRow.appendChild(draft);
    }

    if (item.repository) {
      const repo = document.createElement('span');
      repo.className = 'followed-thread-count';
      repo.textContent = item.repository;
      metaRow.appendChild(repo);
    }

    const threads = document.createElement('span');
    threads.className = 'followed-thread-count';
    threads.textContent = `${item.threadCount ?? 0} comment${(item.threadCount ?? 0) === 1 ? '' : 's'}`;
    metaRow.appendChild(threads);

    if (item.hasNewComments) {
      const newBadge = document.createElement('span');
      newBadge.className = 'new-comment-badge';
      newBadge.textContent = 'New';
      metaRow.appendChild(newBadge);
    }
  }

  infoDiv.appendChild(titleRow);
  infoDiv.appendChild(metaRow);

  // Actions
  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'followed-item-actions';

  const unfollowBtn = document.createElement('button');
  unfollowBtn.className = 'btn-unfollow';
  unfollowBtn.textContent = 'Unfollow';
  unfollowBtn.setAttribute('aria-label', `Unfollow #${item.id}`);
  unfollowBtn.addEventListener('click', () => handleUnfollow(item));

  actionsDiv.appendChild(unfollowBtn);

  li.appendChild(infoDiv);
  li.appendChild(actionsDiv);
  return li;
}

function getPRStatusBadgeClass(status) {
  if (status === 'active') return 'badge--active';
  if (status === 'completed') return 'badge--resolved';
  if (status === 'abandoned') return 'badge--default';
  return 'badge--default';
}

function updateFollowingTabBadge(items) {
  const hasNew = (items || []).some(i => i.type === 'pullRequest' && i.hasNewComments);
  $tabFollowingBadge.hidden = !hasNew;
}

function showFollowError(msg) {
  $followError.textContent = msg;
  $followError.hidden = false;
}

function hideFollowError() {
  $followError.textContent = '';
  $followError.hidden = true;
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

function openSettings() {
  chrome.runtime.openOptionsPage();
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let _toastTimer = null;

function showToast(message, type = 'info') {
  $toast.textContent = message;
  $toast.classList.toggle('toast--error', type === 'error');
  $toast.classList.add('visible');

  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    $toast.classList.remove('visible');
  }, 3000);
}
