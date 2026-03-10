/**
 * azure-devops.js — Azure DevOps Server & Services provider implementation.
 */

import { WorkItemProvider, ProviderError } from './provider.js';

const API_VERSIONS = ['7.0', '6.0-preview', '5.1-preview'];
// Comment API uses a distinct preview suffix — must stay in sync with API_VERSIONS by index.
const COMMENT_API_VERSIONS = ['7.0-preview.3', '6.0-preview.3', '5.1-preview.3'];

export class AzureDevOpsProvider extends WorkItemProvider {
  constructor() {
    super();
    this.config = null;
    this.pat = null;
    this.authHeader = null;
    this.user = null;
    this.apiVersion = API_VERSIONS[0];
    this._versionIndex = 0;
    this._userId = null;
  }

  // ---------------------------------------------------------------------------
  // initialize
  // ---------------------------------------------------------------------------

  async initialize(config) {
    if (!config || !config.baseUrl || !config.pat) {
      throw new ProviderError('Server URL and PAT are required', { code: 'AUTH_FAILURE' });
    }

    this.config = {
      ...config,
      baseUrl: config.baseUrl.replace(/\/$/, ''), // strip trailing slash
    };

    // Normalize project to plain text — the stored value may already be URL-encoded
    // double-encoding when we later call encodeURIComponent(project).
    if (this.config.project) {
      try { this.config.project = decodeURIComponent(this.config.project); } catch { /* leave as-is */ }
    }
    this.pat = config.pat;
    this._versionIndex = Math.max(0, API_VERSIONS.indexOf(config.apiVersion || API_VERSIONS[0]));
    this.apiVersion = API_VERSIONS[this._versionIndex];

    // Build Basic auth header: Base64(':' + PAT)
    const credentials = btoa(':' + this.pat);
    this.authHeader = `Basic ${credentials}`;

    // Verify credentials immediately
    this.user = await this.getCurrentUser();
  }

  // ---------------------------------------------------------------------------
  // getCurrentUser
  // ---------------------------------------------------------------------------

  async getCurrentUser() {
    const url = `${this.config.baseUrl}/_apis/connectionData?api-version=${this.apiVersion}`;
    const data = await this._fetch(url);
    // Store user ID (GUID) for PR search criteria
    this._userId = data?.authenticatedUser?.id || null;
    const displayName =
      data?.authenticatedUser?.providerDisplayName ||
      data?.authenticatedUser?.subjectDescriptor ||
      'Unknown User';
    const email = data?.authenticatedUser?.properties?.Mail?.['$value'] || undefined;
    return { displayName, email };
  }

  // ---------------------------------------------------------------------------
  // getMyActiveWorkItems
  // ---------------------------------------------------------------------------

  async getMyActiveWorkItems() {
    const terminalStates = this.getTerminalStates();
    const stateList = terminalStates.map(s => `'${s}'`).join(', ');
    const query = `SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] NOT IN (${stateList}) ORDER BY [System.ChangedDate] DESC`;

    const project = this.config.project;
    const wiqlBody = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) };

    let wiqlResult;
    if (project) {
      // Try project-scoped URL first; fall back to collection-level on 404
      const projectUrl = `${this.config.baseUrl}/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=${this.apiVersion}`;
      try {
        wiqlResult = await this._fetch(projectUrl, wiqlBody);
      } catch (err) {
        if (err.httpStatus !== 404) throw err;
        // Collection-level fallback
        const collectionUrl = `${this.config.baseUrl}/_apis/wit/wiql?api-version=${this.apiVersion}`;
        wiqlResult = await this._fetch(collectionUrl, wiqlBody);
      }
    } else {
      const collectionUrl = `${this.config.baseUrl}/_apis/wit/wiql?api-version=${this.apiVersion}`;
      wiqlResult = await this._fetch(collectionUrl, wiqlBody);
    }

    const ids = (wiqlResult?.workItems || []).map(wi => wi.id);
    if (ids.length === 0) return [];

    // Batch fetch details in chunks of 200
    const chunks = [];
    for (let i = 0; i < ids.length; i += 200) {
      chunks.push(ids.slice(i, i + 200));
    }

    const fields = [
      'System.Id',
      'System.Title',
      'System.State',
      'System.WorkItemType',
      'System.TeamProject',
      'System.Parent',
      'System.IterationPath',
    ].join(',');

    const rawItems = [];
    for (const chunk of chunks) {
      const detailUrl = `${this.config.baseUrl}/_apis/wit/workitems?ids=${chunk.join(',')}&fields=${encodeURIComponent(fields)}&api-version=${this.apiVersion}`;
      const detailResult = await this._fetch(detailUrl);
      rawItems.push(...(detailResult?.value || []));
    }

    // Fetch parent titles (non-fatal)
    const parentTitleMap = {};
    const parentIds = [...new Set(rawItems.map(wi => wi.fields['System.Parent']).filter(Boolean))];
    if (parentIds.length > 0) {
      const parentChunks = [];
      for (let i = 0; i < parentIds.length; i += 200) {
        parentChunks.push(parentIds.slice(i, i + 200));
      }
      for (const pChunk of parentChunks) {
        try {
          const parentFetchUrl = `${this.config.baseUrl}/_apis/wit/workitems?ids=${pChunk.join(',')}&fields=System.Id,System.Title,System.TeamProject&api-version=${this.apiVersion}`;
          const parentResult = await this._fetch(parentFetchUrl);
          for (const pw of (parentResult?.value || [])) {
            parentTitleMap[pw.id] = {
              title: pw.fields['System.Title'],
              teamProject: pw.fields['System.TeamProject'],
            };
          }
        } catch {
          // Non-fatal — parent info is optional
        }
      }
    }

    const allItems = rawItems.map(wi => {
      const parentInfo = wi.fields['System.Parent'] ? parentTitleMap[wi.fields['System.Parent']] : null;
      return {
        id: String(wi.id),
        title: wi.fields['System.Title'] || '(no title)',
        state: wi.fields['System.State'] || '',
        type: wi.fields['System.WorkItemType'] || '',
        url: this._buildWorkItemUrl(wi.id, wi.fields['System.TeamProject']),
        parentId: wi.fields['System.Parent'] ? String(wi.fields['System.Parent']) : null,
        parentTitle: parentInfo?.title || null,
        parentUrl: parentInfo ? this._buildWorkItemUrl(wi.fields['System.Parent'], parentInfo.teamProject) : null,
        iterationPath: wi.fields['System.IterationPath'] || null,
      };
    });

    return allItems;
  }

  // ---------------------------------------------------------------------------
  // logTime
  // ---------------------------------------------------------------------------

  async logTime(workItemId, durationHours, comment) {
    // Step 1: Read current CompletedWork and RemainingWork values
    const fields = 'Microsoft.VSTS.Scheduling.CompletedWork,Microsoft.VSTS.Scheduling.RemainingWork';
    const getUrl = `${this.config.baseUrl}/_apis/wit/workitems/${workItemId}?fields=${encodeURIComponent(fields)}&api-version=${this.apiVersion}`;
    const current = await this._fetch(getUrl);
    const currentCompleted = current?.fields?.['Microsoft.VSTS.Scheduling.CompletedWork'] ?? 0;
    const currentRemaining = current?.fields?.['Microsoft.VSTS.Scheduling.RemainingWork'];
    const newCompleted = Math.round((currentCompleted + durationHours) * 100) / 100;

    // Step 2: PATCH CompletedWork + optional RemainingWork + optional comment via System.History.
    // System.History is supported on all TFS/AzDO versions; no separate comment endpoint needed.
    const patchUrl = `${this.config.baseUrl}/_apis/wit/workitems/${workItemId}?api-version=${this.apiVersion}`;
    const patchOps = [
      {
        op: 'add',
        path: '/fields/Microsoft.VSTS.Scheduling.CompletedWork',
        value: newCompleted,
      },
    ];
    if (currentRemaining != null) {
      const newRemaining = Math.round(Math.max(0, currentRemaining - durationHours) * 100) / 100;
      patchOps.push({
        op: 'add',
        path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork',
        value: newRemaining,
      });
    }
    if (comment) {
      patchOps.push({ op: 'add', path: '/fields/System.History', value: comment });
    }
    await this._fetch(patchUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify(patchOps),
    });

    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // getTerminalStates
  // ---------------------------------------------------------------------------

  getTerminalStates() {
    return ['Done', 'Closed', 'Removed'];
  }

  // ---------------------------------------------------------------------------
  // getWorkItemTypeStates (F1)
  // ---------------------------------------------------------------------------

  async getWorkItemTypeStates(typeName) {
    const project = this.config.project;
    if (!project) throw new ProviderError('Project is required to fetch work item type states', { code: 'NOT_FOUND' });

    try {
      // Step 1: Resolve the project's process template ID from its capabilities.
      const projectUrl = `${this.config.baseUrl}/_apis/projects/${encodeURIComponent(project)}?includeCapabilities=true&api-version=${this.apiVersion}`;
      const projectData = await this._fetch(projectUrl);
      const processId = projectData?.capabilities?.processTemplate?.templateTypeId;
      if (!processId) throw new ProviderError('Could not determine process template ID', { code: 'NOT_FOUND' });

      // Step 2: Resolve the work item type reference name (e.g. Microsoft.VSTS.WorkItemTypes.Bug).
      const typeUrl = `${this.config.baseUrl}/${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(typeName)}?api-version=${this.apiVersion}`;
      const typeData = await this._fetch(typeUrl);
      const witRefName = typeData?.referenceName;
      if (!witRefName) throw new ProviderError(`Could not resolve reference name for: ${typeName}`, { code: 'NOT_FOUND' });

      // Step 3: Fetch states via the processes API (documented for TFS 4.1+).
      const statesUrl = `${this.config.baseUrl}/_apis/work/processes/${processId}/workItemTypes/${encodeURIComponent(witRefName)}/states?api-version=4.1-preview.1`;
      const data = await this._fetch(statesUrl);
      return (data?.value || []).map(s => ({ name: s.name, color: s.color, stateCategory: s.stateCategory }));
    } catch {
      // Fallback: extract states from the work item type transitions map (available since TFS 2010).
      // State colours are not available via this path.
      const fallbackUrl = `${this.config.baseUrl}/${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(typeName)}?api-version=1.0`;
      const data = await this._fetch(fallbackUrl);
      const transitions = data?.transitions || {};
      const names = [
        ...new Set([
          ...Object.keys(transitions),
          ...Object.values(transitions).flat().map(t => t.to),
        ]),
      ].filter(Boolean);
      return names.map(name => ({ name, color: null, stateCategory: null }));
    }
  }

  // ---------------------------------------------------------------------------
  // updateWorkItemState (F1)
  // ---------------------------------------------------------------------------

  async updateWorkItemState(workItemId, newState) {
    const url = `${this.config.baseUrl}/_apis/wit/workitems/${workItemId}?api-version=${this.apiVersion}`;
    await this._fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify([{ op: 'add', path: '/fields/System.State', value: newState }]),
    });
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // getMyPullRequests
  // ---------------------------------------------------------------------------

  async getMyPullRequests() {
    if (!this._userId) return { own: [], reviewing: [] };

    const project = this.config.project;
    const basePrefix = project
      ? `${this.config.baseUrl}/${encodeURIComponent(project)}`
      : this.config.baseUrl;
    const collectionPrefix = this.config.baseUrl;

    const prApiVersion = '7.0';

    // Helper: fetch PR list with fallback from project-scoped to collection-scoped URL
    const fetchPRList = async (params) => {
      const qs = new URLSearchParams({ 'api-version': prApiVersion, '$top': '50', ...params }).toString();
      if (project) {
        try {
          return await this._fetch(`${basePrefix}/_apis/git/pullrequests?${qs}`);
        } catch (err) {
          if (err.httpStatus !== 404) throw err;
        }
      }
      return this._fetch(`${collectionPrefix}/_apis/git/pullrequests?${qs}`);
    };

    // Fetch own active PRs and review PRs in parallel
    const [ownRaw, reviewRaw] = await Promise.all([
      fetchPRList({ 'searchCriteria.creatorId': this._userId, 'searchCriteria.status': 'active' }),
      fetchPRList({ 'searchCriteria.reviewerId': this._userId, 'searchCriteria.status': 'active' }),
    ]);

    const ownList = ownRaw?.value || [];
    const reviewList = reviewRaw?.value || [];

    // Map own PRs
    const own = ownList.map(pr => this._mapOwnPR(pr));

    // Fetch thread counts for own PRs (up to 5, non-fatal)
    const ownWithThreads = await Promise.all(
      own.slice(0, 5).map(async (pr) => {
        try {
          const repoId = pr.repoId;
          const prId = pr.id;
          const threadsUrl = project
            ? `${basePrefix}/_apis/git/repositories/${repoId}/pullRequests/${prId}/threads?api-version=${prApiVersion}`
            : `${collectionPrefix}/_apis/git/repositories/${repoId}/pullRequests/${prId}/threads?api-version=${prApiVersion}`;
          const result = await this._fetch(threadsUrl);
          const threads = result?.value || [];
          const threadCount = threads.filter(t =>
            t.isDeleted !== true &&
            t.comments?.some(c => c.commentType === 'text')
          ).length;
          return { ...pr, threadCount };
        } catch {
          return pr; // threadCount remains 0
        }
      })
    );
    // Merge thread counts back (PRs beyond index 5 keep threadCount: 0)
    const ownFull = own.map((pr, i) => (i < 5 ? ownWithThreads[i] : pr));

    // Filter reviewing: exclude PRs where user is also the creator
    const ownIds = new Set(own.map(pr => String(pr.id)));
    const reviewing = reviewList
      .filter(pr => !ownIds.has(String(pr.pullRequestId)))
      .map(pr => this._mapReviewPR(pr, this._userId));

    return { own: ownFull, reviewing };
  }

  // ---------------------------------------------------------------------------
  // getWorkItemById
  // ---------------------------------------------------------------------------

  async getWorkItemById(id) {
    const fields = 'System.Id,System.Title,System.State,System.WorkItemType,System.TeamProject';
    const url = `${this.config.baseUrl}/_apis/wit/workitems/${id}?fields=${encodeURIComponent(fields)}&api-version=${this.apiVersion}`;
    let data;
    try {
      data = await this._fetch(url);
    } catch (err) {
      if (err.httpStatus === 404) {
        throw new ProviderError(`Work item #${id} not found`, { code: 'NOT_FOUND', httpStatus: 404 });
      }
      throw err;
    }
    if (!data) throw new ProviderError(`Work item #${id} not found`, { code: 'NOT_FOUND' });
    return {
      id: String(data.id),
      title: data.fields?.['System.Title'] || '(no title)',
      state: data.fields?.['System.State'] || '',
      type: data.fields?.['System.WorkItemType'] || '',
      url: this._buildWorkItemUrl(data.id, data.fields?.['System.TeamProject']),
    };
  }

  // ---------------------------------------------------------------------------
  // getPullRequestById
  // ---------------------------------------------------------------------------

  async getPullRequestById(prId, repoId) {
    const prApiVersion = '7.0';
    const project = this.config.project;
    const basePrefix = project
      ? `${this.config.baseUrl}/${encodeURIComponent(project)}`
      : this.config.baseUrl;

    let prData;
    if (repoId) {
      // Fast path: we know the repo
      const url = `${basePrefix}/_apis/git/repositories/${repoId}/pullRequests/${prId}?api-version=${prApiVersion}`;
      try {
        prData = await this._fetch(url);
      } catch (err) {
        if (err.httpStatus === 404) {
          throw new ProviderError(`PR #${prId} not found`, { code: 'NOT_FOUND', httpStatus: 404 });
        }
        throw err;
      }
    } else {
      // Project-level search — no repo needed
      const qs = new URLSearchParams({
        'searchCriteria.pullRequestId': String(prId),
        '$top': '1',
        'api-version': prApiVersion,
      }).toString();

      let result;
      if (project) {
        try {
          result = await this._fetch(`${basePrefix}/_apis/git/pullrequests?${qs}`);
        } catch (err) {
          if (err.httpStatus !== 404) throw err;
          result = await this._fetch(`${this.config.baseUrl}/_apis/git/pullrequests?${qs}`);
        }
      } else {
        result = await this._fetch(`${this.config.baseUrl}/_apis/git/pullrequests?${qs}`);
      }

      prData = (result?.value || [])[0] || null;
      if (!prData) throw new ProviderError(`PR #${prId} not found`, { code: 'NOT_FOUND' });
    }

    const mapped = this._mapOwnPR(prData);

    // Fetch thread count (non-fatal)
    try {
      const fetchedRepoId = mapped.repoId;
      const threadsUrl = project
        ? `${basePrefix}/_apis/git/repositories/${fetchedRepoId}/pullRequests/${prId}/threads?api-version=${prApiVersion}`
        : `${this.config.baseUrl}/_apis/git/repositories/${fetchedRepoId}/pullRequests/${prId}/threads?api-version=${prApiVersion}`;
      const threadsResult = await this._fetch(threadsUrl);
      const threads = threadsResult?.value || [];
      mapped.threadCount = threads.filter(t =>
        t.isDeleted !== true &&
        t.comments?.some(c => c.commentType === 'text')
      ).length;
    } catch {
      // threadCount stays 0
    }

    return mapped;
  }

  _mapOwnPR(pr) {
    const repo = pr.repository || {};
    return {
      id: pr.pullRequestId,
      title: pr.title || '(no title)',
      status: pr.status || 'active',
      isDraft: pr.isDraft || false,
      repository: repo.name || '',
      repoId: repo.id || '',
      sourceBranch: (pr.sourceRefName || '').replace('refs/heads/', ''),
      targetBranch: (pr.targetRefName || '').replace('refs/heads/', ''),
      url: this._buildPRUrl(repo, pr.pullRequestId),
      createdDate: pr.creationDate || null,
      reviewerCount: Array.isArray(pr.reviewers) ? pr.reviewers.length : 0,
      approvedCount: Array.isArray(pr.reviewers) ? pr.reviewers.filter(r => r.vote === 10).length : 0,
      threadCount: 0, // filled in by thread fetch
    };
  }

  _mapReviewPR(pr, userId) {
    const repo = pr.repository || {};
    const reviewer = Array.isArray(pr.reviewers)
      ? pr.reviewers.find(r => r.id === userId)
      : null;
    return {
      id: pr.pullRequestId,
      title: pr.title || '(no title)',
      status: pr.status || 'active',
      isDraft: pr.isDraft || false,
      repository: repo.name || '',
      repoId: repo.id || '',
      sourceBranch: (pr.sourceRefName || '').replace('refs/heads/', ''),
      targetBranch: (pr.targetRefName || '').replace('refs/heads/', ''),
      url: this._buildPRUrl(repo, pr.pullRequestId),
      createdDate: pr.creationDate || null,
      createdBy: pr.createdBy?.displayName || '',
      isRequired: reviewer?.isRequired ?? false,
      vote: reviewer?.vote ?? 0,
    };
  }

  /**
   * Build the web URL to open a PR in the browser.
   * Prefers repo.webUrl when it is a genuine web URL (not an /_apis/ endpoint).
   * Falls back to constructing from known parts: {baseUrl}/{project}/_git/{repo}/pullrequest/{id}
   */
  _buildPRUrl(repo, prId) {
    const webUrl = repo.webUrl;
    if (webUrl && !webUrl.includes('/_apis/')) {
      return `${webUrl}/pullrequest/${prId}`;
    }
    // webUrl absent or points to an API endpoint — build from parts
    const project = repo.project?.name || this.config.project;
    const repoName = repo.name;
    if (project && repoName) {
      return `${this.config.baseUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repoName)}/pullrequest/${prId}`;
    }
    // Last resort: no repo name available
    return `${this.config.baseUrl}/pullrequest/${prId}`;
  }

  // ---------------------------------------------------------------------------
  // getMentions
  // ---------------------------------------------------------------------------

  async getMentions() {
    if (!this.user?.displayName) return [];

    const terminalStates = this.getTerminalStates();
    const stateList = terminalStates.map(s => `'${s}'`).join(', ');
    // Escape single quotes in display name to avoid WIQL injection
    const escapedName = this.user.displayName.replace(/'/g, "''");
    const query = `SELECT [System.Id] FROM WorkItems WHERE [System.History] CONTAINS '${escapedName}' AND [System.State] NOT IN (${stateList}) ORDER BY [System.ChangedDate] DESC`;

    const project = this.config.project;
    const wiqlBody = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) };

    let wiqlResult;
    if (project) {
      const projectUrl = `${this.config.baseUrl}/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=${this.apiVersion}`;
      try {
        wiqlResult = await this._fetch(projectUrl, wiqlBody);
      } catch (err) {
        if (err.httpStatus !== 404) throw err;
        const collectionUrl = `${this.config.baseUrl}/_apis/wit/wiql?api-version=${this.apiVersion}`;
        wiqlResult = await this._fetch(collectionUrl, wiqlBody);
      }
    } else {
      const collectionUrl = `${this.config.baseUrl}/_apis/wit/wiql?api-version=${this.apiVersion}`;
      wiqlResult = await this._fetch(collectionUrl, wiqlBody);
    }

    const ids = (wiqlResult?.workItems || []).map(wi => wi.id);
    if (ids.length === 0) return [];

    // Batch fetch details in chunks of 200
    const chunks = [];
    for (let i = 0; i < ids.length; i += 200) {
      chunks.push(ids.slice(i, i + 200));
    }

    const fields = [
      'System.Id',
      'System.Title',
      'System.State',
      'System.WorkItemType',
      'System.TeamProject',
      'System.Parent',
      'System.IterationPath',
      'System.ChangedDate',
    ].join(',');

    const rawItems = [];
    for (const chunk of chunks) {
      const detailUrl = `${this.config.baseUrl}/_apis/wit/workitems?ids=${chunk.join(',')}&fields=${encodeURIComponent(fields)}&api-version=${this.apiVersion}`;
      const detailResult = await this._fetch(detailUrl);
      rawItems.push(...(detailResult?.value || []));
    }

    // Fetch parent titles (non-fatal)
    const parentTitleMap = {};
    const parentIds = [...new Set(rawItems.map(wi => wi.fields['System.Parent']).filter(Boolean))];
    if (parentIds.length > 0) {
      const parentChunks = [];
      for (let i = 0; i < parentIds.length; i += 200) {
        parentChunks.push(parentIds.slice(i, i + 200));
      }
      for (const pChunk of parentChunks) {
        try {
          const parentFetchUrl = `${this.config.baseUrl}/_apis/wit/workitems?ids=${pChunk.join(',')}&fields=System.Id,System.Title,System.TeamProject&api-version=${this.apiVersion}`;
          const parentResult = await this._fetch(parentFetchUrl);
          for (const pw of (parentResult?.value || [])) {
            parentTitleMap[pw.id] = {
              title: pw.fields['System.Title'],
              teamProject: pw.fields['System.TeamProject'],
            };
          }
        } catch {
          // Non-fatal — parent info is optional
        }
      }
    }

    // Fetch the revision history for each work item in parallel to find the exact
    // date of the comment that mentioned the user.
    // Strategy: try the Comments API first (AzDO Services / Server 2019+); if it
    // returns a 404 fall back to the Revisions API which works on all TFS versions.
    // Each revision carries System.History (the comment text) + System.ChangedDate.
    const commentApiVersion = COMMENT_API_VERSIONS[this._versionIndex];
    const mentionDateMap = {};
    const name = this.user.displayName;

    await Promise.all(rawItems.map(async (wi) => {
      // --- Attempt 1: Comments API ---
      try {
        const commentsUrl = `${this.config.baseUrl}/_apis/wit/workitems/${wi.id}/comments?api-version=${commentApiVersion}`;
        const result = await this._fetch(commentsUrl);
        const comments = result?.comments || [];
        const matched = comments
          .filter(c => c.text && c.text.includes(name))
          .sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
        if (matched.length > 0) {
          mentionDateMap[wi.id] = matched[0].createdDate;
          return; // found — skip revisions
        }
      } catch {
        // Comments API not available on this server — fall through to revisions
      }

      // --- Attempt 2: Revisions API (all TFS/AzDO versions) ---
      try {
        const revisionsUrl = `${this.config.baseUrl}/_apis/wit/workitems/${wi.id}/revisions?api-version=${this.apiVersion}`;
        const result = await this._fetch(revisionsUrl);
        const revisions = result?.value || [];
        const matched = revisions
          .filter(r => r.fields?.['System.History'] && r.fields['System.History'].includes(name))
          .sort((a, b) => new Date(b.fields['System.ChangedDate']) - new Date(a.fields['System.ChangedDate']));
        if (matched.length > 0) {
          mentionDateMap[wi.id] = matched[0].fields['System.ChangedDate'];
        }
      } catch {
        // Non-fatal — will fall back to work item System.ChangedDate
      }
    }));

    return rawItems.map(wi => {
      const parentInfo = wi.fields['System.Parent'] ? parentTitleMap[wi.fields['System.Parent']] : null;
      return {
        id: String(wi.id),
        title: wi.fields['System.Title'] || '(no title)',
        state: wi.fields['System.State'] || '',
        type: wi.fields['System.WorkItemType'] || '',
        url: this._buildWorkItemUrl(wi.id, wi.fields['System.TeamProject']),
        parentId: wi.fields['System.Parent'] ? String(wi.fields['System.Parent']) : null,
        parentTitle: parentInfo?.title || null,
        parentUrl: parentInfo ? this._buildWorkItemUrl(wi.fields['System.Parent'], parentInfo.teamProject) : null,
        iterationPath: wi.fields['System.IterationPath'] || null,
        mentionDate: mentionDateMap[wi.id] || wi.fields['System.ChangedDate'] || null,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch with automatic auth header, error mapping, and API version downgrade.
   */
  async _fetch(url, options = {}) {
    const headers = {
      Authorization: this.authHeader,
      Accept: 'application/json',
      ...(options.headers || {}),
    };

    let response;
    try {
      response = await fetch(url, { ...options, headers });
    } catch (err) {
      throw new ProviderError(`Network error: ${err.message}`, {
        code: 'NETWORK',
        retryable: true,
      });
    }

    // Auth failures
    if (response.status === 401 || response.status === 403) {
      throw new ProviderError('Authentication failed. Please check your PAT.', {
        code: 'AUTH_FAILURE',
        httpStatus: response.status,
      });
    }

    // API version mismatch — attempt downgrade once
    if (response.status === 400 || response.status === 404) {
      const body = await response.text();
      const isVersionError =
        body.includes('api-version') || body.includes('not supported') || response.status === 400;

      if (isVersionError && this._versionIndex < API_VERSIONS.length - 1) {
        this._versionIndex++;
        this.apiVersion = API_VERSIONS[this._versionIndex];
        return this._fetch(url.replace(/api-version=[^&]+/, `api-version=${this.apiVersion}`), options);
      }

      // Parse and surface actual error message
      let errorMessage = `HTTP ${response.status}`;
      try {
        const json = JSON.parse(body);
        errorMessage = json.message || json.value?.Message || errorMessage;
      } catch {
        // body wasn't JSON
      }
      throw new ProviderError(errorMessage, { httpStatus: response.status });
    }

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;
      try {
        const json = await response.json();
        errorMessage = json.message || json.value?.Message || errorMessage;
      } catch {
        // ignore
      }
      throw new ProviderError(errorMessage, { httpStatus: response.status, retryable: response.status >= 500 });
    }

    // Empty body (e.g., 204 No Content on PATCH)
    if (response.status === 204) return null;

    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  /**
   * Build the web URL to open a work item in the browser.
   */
  _buildWorkItemUrl(id, teamProject) {
    const project = teamProject || this.config.project || '';
    if (project) {
      return `${this.config.baseUrl}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
    }
    return `${this.config.baseUrl}/_workitems/edit/${id}`;
  }
}
