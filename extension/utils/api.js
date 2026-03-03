/**
 * api.js — Provider factory and provider-agnostic API orchestrator.
 * Import providers only here. All other modules go through this file.
 */

import { AzureDevOpsProvider } from '../providers/azure-devops.js';
import { JiraProvider } from '../providers/jira.js';
import { ProviderError } from '../providers/provider.js';

const PROVIDERS = {
  'azure-devops': AzureDevOpsProvider,
  'jira': JiraProvider,
};

/**
 * Create and initialize a provider instance.
 * @param {string} type  — key from PROVIDERS map
 * @param {object} config — provider-specific config including `pat`
 * @returns {Promise<WorkItemProvider>}
 */
export async function createProvider(type, config) {
  const ProviderClass = PROVIDERS[type];
  if (!ProviderClass) throw new Error(`Unknown provider: ${type}`);
  const instance = new ProviderClass();
  await instance.initialize(config);
  return instance;
}

/**
 * Fetch active work items from the given provider.
 * @param {WorkItemProvider} provider
 * @returns {Promise<Array>}
 */
export async function fetchWorkItems(provider) {
  return provider.getMyActiveWorkItems();
}

/**
 * Submit a time log entry.
 * @param {WorkItemProvider} provider
 * @param {string} workItemId
 * @param {number} durationHours
 * @param {string} [comment]
 * @returns {Promise<{ success: boolean, error?: string, warning?: string }>}
 */
export async function submitTimeLog(provider, workItemId, durationHours, comment) {
  try {
    const result = await provider.logTime(workItemId, durationHours, comment);
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Fetch the user's own PRs and review PRs.
 * @param {WorkItemProvider} provider
 * @returns {Promise<{ own: Array, reviewing: Array }>}
 */
export async function fetchPullRequests(provider) {
  return provider.getMyPullRequests();
}

/**
 * Resolve a raw ID (work item or PR) into a followedItem object.
 * Tries work item first; falls back to PR on NOT_FOUND.
 * @param {WorkItemProvider} provider
 * @param {string} rawId — numeric string, may include leading '#'
 * @returns {Promise<object>} followedItem shape
 */
export async function resolveFollowedItem(provider, rawId) {
  const id = String(rawId).replace(/^#/, '').trim();
  if (!/^\d+$/.test(id)) {
    throw new ProviderError('Invalid ID — must be numeric', { code: 'NOT_FOUND' });
  }

  // Try work item first
  try {
    const wi = await provider.getWorkItemById(id);
    return {
      id: wi.id,
      type: 'workItem',
      title: wi.title,
      state: wi.state,
      workItemType: wi.type,
      url: wi.url,
      addedAt: Date.now(),
    };
  } catch (err) {
    if (err.code !== 'NOT_FOUND') throw err;
  }

  // Fall back to PR
  try {
    const pr = await provider.getPullRequestById(id, undefined);
    return {
      id: String(pr.id),
      type: 'pullRequest',
      title: pr.title,
      status: pr.status,
      isDraft: pr.isDraft,
      repository: pr.repository,
      repoId: pr.repoId,
      sourceBranch: pr.sourceBranch,
      targetBranch: pr.targetBranch,
      threadCount: pr.threadCount ?? 0,
      lastSeenThreadCount: pr.threadCount ?? 0,
      hasNewComments: false,
      url: pr.url,
      addedAt: Date.now(),
    };
  } catch (err) {
    if (err.code !== 'NOT_FOUND') throw err;
  }

  throw new ProviderError(`No work item or PR found with ID #${id}`, { code: 'NOT_FOUND' });
}

/**
 * Refresh all followed items from the provider.
 * Per-item errors are non-fatal — returns the item unchanged on error.
 * @param {WorkItemProvider} provider
 * @param {Array} currentItems
 * @returns {Promise<{ items: Array, anyNewComments: boolean }>}
 */
export async function refreshFollowedItems(provider, currentItems) {
  const updated = await Promise.all(currentItems.map(async (item) => {
    try {
      if (item.type === 'workItem') {
        const wi = await provider.getWorkItemById(item.id);
        return { ...item, title: wi.title, state: wi.state, url: wi.url };
      } else if (item.type === 'pullRequest') {
        const pr = await provider.getPullRequestById(item.id, item.repoId);
        const newCount = pr.threadCount ?? 0;
        const hasNewComments = item.hasNewComments || (newCount > (item.lastSeenThreadCount ?? 0));
        return {
          ...item,
          title: pr.title,
          status: pr.status,
          isDraft: pr.isDraft,
          threadCount: newCount,
          hasNewComments,
          url: pr.url,
        };
      }
    } catch {
      // Non-fatal — return item unchanged
    }
    return item;
  }));

  const anyNewComments = updated.some(i => i.type === 'pullRequest' && i.hasNewComments);
  return { items: updated, anyNewComments };
}

/**
 * Test a connection without persisting anything.
 * @param {string} type
 * @param {object} config
 * @returns {Promise<{ success: boolean, user?: { displayName: string }, error?: string }>}
 */
export async function testConnection(type, config) {
  try {
    const provider = await createProvider(type, config);
    const user = await provider.getCurrentUser();
    return { success: true, user };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
