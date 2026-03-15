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
 * Fetch work items where the current user was @mentioned.
 * @param {WorkItemProvider} provider
 * @returns {Promise<Array>}
 */
export async function fetchMentions(provider) {
  return provider.getMentions();
}

/**
 * Resolve a prefixed ID into a followedItem object.
 *   '#NNNNN' → Work Item
 *   '!NNNNN' → Pull Request
 *
 * @param {WorkItemProvider} provider
 * @param {string} rawId — must begin with '#' or '!'
 * @returns {Promise<object>} followedItem shape
 */
export async function resolveFollowedItem(provider, rawId) {
  const raw = String(rawId).trim();
  const wiOnly = raw.startsWith('#');
  const prOnly = raw.startsWith('!');
  const id = raw.slice(1);

  if (!wiOnly && !prOnly) {
    throw new ProviderError('Use # for work items or ! for pull requests', { code: 'NOT_FOUND' });
  }

  if (!/^\d+$/.test(id)) {
    throw new ProviderError('ID must be numeric', { code: 'NOT_FOUND' });
  }

  if (wiOnly) {
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
  }

  // prOnly
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
 * Search work items by ID or title keyword.
 * @param {WorkItemProvider} provider
 * @param {string} query
 * @param {number} [maxResults=20]
 * @returns {Promise<Array>}
 */
export async function searchWorkItems(provider, query, maxResults = 20) {
  return provider.searchWorkItems(query, maxResults);
}

/**
 * Undo a time log entry by subtracting hours from CompletedWork.
 * @param {WorkItemProvider} provider
 * @param {string} workItemId
 * @param {number} hours
 * @param {string} [comment]
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function undoTimeLog(provider, workItemId, hours, comment) {
  try {
    return await provider.undoTimeLog(workItemId, hours, comment);
  } catch (err) {
    return { success: false, error: err.message };
  }
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
