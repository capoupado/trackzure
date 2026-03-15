/**
 * provider.js — Base provider interface and shared error class.
 *
 * All providers must extend WorkItemProvider and implement every method.
 */

export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, retryable?: boolean, httpStatus?: number }} [options]
   *   code: 'AUTH_FAILURE' | 'NETWORK' | 'API_VERSION' | 'NOT_FOUND'
   */
  constructor(message, { code, retryable = false, httpStatus } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
  }
}

export class WorkItemProvider {
  /**
   * One-time setup — validate connection, fetch user identity.
   * @param {object} config
   * @returns {Promise<void>}
   */
  async initialize(config) {
    throw new Error('WorkItemProvider.initialize() must be implemented');
  }

  /**
   * Return the display name / email of the authenticated user.
   * @returns {Promise<{ displayName: string, email?: string }>}
   */
  async getCurrentUser() {
    throw new Error('WorkItemProvider.getCurrentUser() must be implemented');
  }

  /**
   * Fetch work items assigned to the current user that are NOT in a terminal state.
   * @returns {Promise<Array<{ id: string, title: string, state: string, type: string, url: string }>>}
   */
  async getMyActiveWorkItems() {
    throw new Error('WorkItemProvider.getMyActiveWorkItems() must be implemented');
  }

  /**
   * Submit a time entry against a work item.
   * @param {string} workItemId
   * @param {number} durationHours
   * @param {string} [comment]
   * @returns {Promise<{ success: boolean, message?: string, warning?: string }>}
   */
  async logTime(workItemId, durationHours, comment) {
    throw new Error('WorkItemProvider.logTime() must be implemented');
  }

  /**
   * Return the set of terminal states for this provider.
   * These states are excluded from the active work items query.
   * @returns {string[]}
   */
  getTerminalStates() {
    throw new Error('WorkItemProvider.getTerminalStates() must be implemented');
  }

  /**
   * Return all valid states for a given work item type.
   * @param {string} typeName
   * @returns {Promise<Array<{ name: string, color: string, stateCategory: string }>>}
   */
  async getWorkItemTypeStates(typeName) {
    throw new Error('WorkItemProvider.getWorkItemTypeStates() must be implemented');
  }

  /**
   * Update the state of a work item.
   * @param {string} workItemId
   * @param {string} newState
   * @returns {Promise<{ success: boolean }>}
   */
  async updateWorkItemState(workItemId, newState) {
    throw new Error('WorkItemProvider.updateWorkItemState() must be implemented');
  }

  /**
   * Fetch the user's own active PRs and PRs assigned for review.
   * @returns {Promise<{ own: Array, reviewing: Array }>}
   */
  async getMyPullRequests() {
    throw new Error('WorkItemProvider.getMyPullRequests() must be implemented');
  }

  /**
   * Fetch a single work item by ID.
   * @param {string} workItemId
   * @returns {Promise<{ id: string, title: string, state: string, type: string, url: string }>}
   */
  async getWorkItemById(workItemId) {
    throw new ProviderError(`getWorkItemById not implemented for this provider`, { code: 'NOT_FOUND' });
  }

  /**
   * Fetch a single pull request by ID.
   * @param {string} prId
   * @param {string} [repoId] — optional, speeds up lookup when cached
   * @returns {Promise<object>}
   */
  async getPullRequestById(prId, repoId) {
    throw new ProviderError(`getPullRequestById not implemented for this provider`, { code: 'NOT_FOUND' });
  }

  /**
   * Fetch work items where the current user was @mentioned in comments or history.
   * Providers that do not support this return an empty array by default.
   * @returns {Promise<Array<{ id: string, title: string, state: string, type: string, url: string }>>}
   */
  async getMentions() {
    return [];
  }

  /**
   * Search work items by ID (exact) or title keyword (CONTAINS). No assignee or state filter.
   * @param {string} query — numeric string for ID search, otherwise title substring
   * @param {number} [maxResults=20]
   * @returns {Promise<Array<{ id: string, title: string, state: string, type: string, url: string }>>}
   */
  async searchWorkItems(query, maxResults = 20) {
    throw new Error('WorkItemProvider.searchWorkItems() must be implemented');
  }

  /**
   * Undo a time log entry — subtract hours from CompletedWork (floored at 0).
   * @param {string} workItemId
   * @param {number} hours
   * @param {string} [comment]
   * @returns {Promise<{ success: boolean, message?: string }>}
   */
  async undoTimeLog(workItemId, hours, comment) {
    throw new Error('WorkItemProvider.undoTimeLog() must be implemented');
  }
}
