/**
 * jira.js — Jira provider stub (future implementation).
 */

import { WorkItemProvider, ProviderError } from './provider.js';

export class JiraProvider extends WorkItemProvider {
  async initialize(_config) {
    throw new ProviderError('Jira provider not yet implemented', { code: 'NOT_FOUND' });
  }

  async getCurrentUser() {
    throw new ProviderError('Jira provider not yet implemented', { code: 'NOT_FOUND' });
  }

  async getMyActiveWorkItems() {
    throw new ProviderError('Jira provider not yet implemented', { code: 'NOT_FOUND' });
  }

  async logTime(_workItemId, _durationHours, _comment) {
    throw new ProviderError('Jira provider not yet implemented', { code: 'NOT_FOUND' });
  }

  getTerminalStates() {
    return ['Done'];
  }

  async getWorkItemTypeStates(_typeName) {
    throw new ProviderError('Jira provider not yet implemented', { code: 'NOT_FOUND' });
  }

  async updateWorkItemState(_workItemId, _newState) {
    throw new ProviderError('Jira provider not yet implemented', { code: 'NOT_FOUND' });
  }
}
