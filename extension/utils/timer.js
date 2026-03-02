/**
 * timer.js — Pure timer logic. No chrome.* or DOM dependencies.
 */

/**
 * Compute elapsed milliseconds from a timer state object.
 * @param {{ startedAt: number, accumulatedMs: number } | null} timerState
 * @returns {number} total elapsed ms
 */
export function getElapsedMs(timerState) {
  if (!timerState) return 0;
  const { startedAt, accumulatedMs } = timerState;
  const live = startedAt ? Date.now() - startedAt : 0;
  return (accumulatedMs || 0) + live;
}

/**
 * Format elapsed ms to a human-readable string: '1h 23m' / '45m' / '0m'
 * @param {number} ms
 * @returns {string}
 */
export function formatElapsed(ms) {
  if (!ms || ms < 0) return '0m';
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

/**
 * Format elapsed ms for the extension badge (max 4 chars).
 * < 1h → '59m'
 * >= 1h → '1:23'
 * @param {number} ms
 * @returns {string}
 */
export function formatElapsedForBadge(ms) {
  if (!ms || ms < 0) return '0m';
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${totalMinutes}m`;
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Convert milliseconds to hours, rounded to 2 decimal places.
 * @param {number} ms
 * @returns {number}
 */
export function msToHours(ms) {
  return Math.round((ms / 3_600_000) * 100) / 100;
}

/**
 * Convert hours to milliseconds (integer).
 * @param {number} hours
 * @returns {number}
 */
export function hoursToMs(hours) {
  return Math.round(hours * 3_600_000);
}

/**
 * Parse a manual time entry string into hours (float) or null on invalid input.
 * Supported formats:
 *   '1.5'     → 1.5 h
 *   '90m'     → 1.5 h
 *   '1h 30m'  → 1.5 h
 *   '1h30m'   → 1.5 h
 *   '1:30'    → 1.5 h
 * @param {string} str
 * @returns {number|null}
 */
export function parseManualEntry(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim().toLowerCase();

  // '1h 30m' or '1h30m'
  const hm = s.match(/^(\d+(?:\.\d+)?)h\s*(?:(\d+(?:\.\d+)?)m)?$/);
  if (hm) {
    return parseFloat(hm[1]) + (hm[2] ? parseFloat(hm[2]) / 60 : 0);
  }

  // '90m'
  const mOnly = s.match(/^(\d+(?:\.\d+)?)m$/);
  if (mOnly) {
    return parseFloat(mOnly[1]) / 60;
  }

  // '1:30'
  const colon = s.match(/^(\d+):(\d{1,2})$/);
  if (colon) {
    return parseInt(colon[1], 10) + parseInt(colon[2], 10) / 60;
  }

  // Plain number → hours
  const plain = s.match(/^(\d+(?:\.\d+)?)$/);
  if (plain) {
    return parseFloat(plain[1]);
  }

  return null;
}

/**
 * Create a new timer state object for the given work item.
 * @param {string} workItemId
 * @returns {{ workItemId: string, startedAt: number, accumulatedMs: number }}
 */
export function startTimer(workItemId) {
  return { workItemId, startedAt: Date.now(), accumulatedMs: 0 };
}

/**
 * Compute elapsed from a running timer without mutating state.
 * Returns data suitable for merging into the time log.
 * @param {{ workItemId: string, startedAt: number, accumulatedMs: number }} activeTimer
 * @returns {{ workItemId: string, elapsedMs: number }}
 */
export function stopTimer(activeTimer) {
  const elapsedMs = getElapsedMs(activeTimer);
  return { workItemId: activeTimer.workItemId, elapsedMs };
}
