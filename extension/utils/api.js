/**
 * api.js — Provider factory and provider-agnostic API orchestrator.
 * Import providers only here. All other modules go through this file.
 */

import { AzureDevOpsProvider } from '../providers/azure-devops.js';
import { JiraProvider } from '../providers/jira.js';

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
