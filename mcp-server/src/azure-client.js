/**
 * azure-client.js — Azure DevOps REST client for the MCP server.
 *
 * Ported from extension/providers/azure-devops.js with Node.js adaptations:
 *  - Buffer.from() instead of btoa()
 *  - All logging to stderr (stdout reserved for MCP protocol)
 *  - Same _fetch() pattern with auth header, version downgrade, error mapping
 */

const API_VERSIONS = ['7.0', '6.0-preview', '5.1-preview'];

export class AzureClientError extends Error {
  constructor(message, { code, httpStatus, retryable = false } = {}) {
    super(message);
    this.name = 'AzureClientError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
  }
}

export class AzureClient {
  constructor({ baseUrl, pat, project, apiVersion }) {
    if (!baseUrl || !pat || !project) {
      throw new AzureClientError('AZURE_DEVOPS_URL, AZURE_DEVOPS_PAT, and AZURE_DEVOPS_PROJECT are required', { code: 'AUTH_FAILURE' });
    }

    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.project = project;
    try { this.project = decodeURIComponent(this.project); } catch { /* leave as-is */ }

    this.authHeader = `Basic ${Buffer.from(':' + pat).toString('base64')}`;
    this._versionIndex = Math.max(0, API_VERSIONS.indexOf(apiVersion || API_VERSIONS[0]));
    this.apiVersion = API_VERSIONS[this._versionIndex];
    this._userId = null;
    this._user = null;
  }

  /** Verify credentials and cache user identity. */
  async initialize() {
    const url = `${this.baseUrl}/_apis/connectionData?api-version=${this.apiVersion}`;
    const data = await this._fetch(url);
    this._userId = data?.authenticatedUser?.id || null;
    this._user = {
      displayName: data?.authenticatedUser?.providerDisplayName || data?.authenticatedUser?.subjectDescriptor || 'Unknown User',
      email: data?.authenticatedUser?.properties?.Mail?.['$value'] || undefined,
    };
    this._log(`Authenticated as ${this._user.displayName} (${this._userId})`);
    return this._user;
  }

  get userId() { return this._userId; }
  get user() { return this._user; }

  /** Project-scoped URL prefix. */
  get projectUrl() {
    return `${this.baseUrl}/${encodeURIComponent(this.project)}`;
  }

  // ---------------------------------------------------------------------------
  // PR helpers
  // ---------------------------------------------------------------------------

  /**
   * Search for a PR by ID across the project to resolve its repositoryId.
   * Returns the raw PR object or null.
   */
  async resolvePr(prId) {
    const qs = new URLSearchParams({
      'searchCriteria.pullRequestId': String(prId),
      '$top': '1',
      'api-version': this.apiVersion,
    }).toString();

    try {
      const result = await this._fetch(`${this.projectUrl}/_apis/git/pullrequests?${qs}`);
      return (result?.value || [])[0] || null;
    } catch (err) {
      if (err.httpStatus === 404) {
        // Fall back to collection-level
        const result = await this._fetch(`${this.baseUrl}/_apis/git/pullrequests?${qs}`);
        return (result?.value || [])[0] || null;
      }
      throw err;
    }
  }

  /**
   * Resolve repository ID for a PR. Uses provided repoId or searches the project.
   */
  async resolveRepoId(prId, repoId) {
    if (repoId) return repoId;
    const pr = await this.resolvePr(prId);
    if (!pr) throw new AzureClientError(`PR #${prId} not found`, { code: 'NOT_FOUND', httpStatus: 404 });
    return pr.repository?.id;
  }

  // ---------------------------------------------------------------------------
  // Core fetch with auth, error mapping, version downgrade
  // ---------------------------------------------------------------------------

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
      throw new AzureClientError(`Network error: ${err.message}`, { code: 'NETWORK', retryable: true });
    }

    if (response.status === 401 || response.status === 403) {
      throw new AzureClientError('Authentication failed. Check your PAT.', { code: 'AUTH_FAILURE', httpStatus: response.status });
    }

    if (response.status === 400 || response.status === 404) {
      const body = await response.text();
      const isVersionError = body.includes('api-version') || body.includes('not supported') || response.status === 400;

      if (isVersionError && this._versionIndex < API_VERSIONS.length - 1) {
        this._versionIndex++;
        this.apiVersion = API_VERSIONS[this._versionIndex];
        return this._fetch(url.replace(/api-version=[^&]+/, `api-version=${this.apiVersion}`), options);
      }

      let errorMessage = `HTTP ${response.status}`;
      try {
        const json = JSON.parse(body);
        errorMessage = json.message || json.value?.Message || errorMessage;
      } catch { /* body wasn't JSON */ }

      throw new AzureClientError(errorMessage, { httpStatus: response.status });
    }

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;
      try {
        const json = await response.json();
        errorMessage = json.message || json.value?.Message || errorMessage;
      } catch { /* ignore */ }
      throw new AzureClientError(errorMessage, { httpStatus: response.status, retryable: response.status >= 500 });
    }

    if (response.status === 204) return null;

    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  /**
   * Fetch raw file content from a Git repo by path and version.
   * Returns the text content or null on 404.
   */
  async fetchFileContent(repoId, path, version, versionType = 'commit') {
    const qs = new URLSearchParams({
      path,
      'versionDescriptor.version': version,
      'versionDescriptor.versionType': versionType,
      'api-version': this.apiVersion,
    }).toString();
    const url = `${this.projectUrl}/_apis/git/repositories/${repoId}/items?${qs}`;

    const headers = {
      Authorization: this.authHeader,
      Accept: 'text/plain',
    };

    let response;
    try {
      response = await fetch(url, { headers });
    } catch {
      return null;
    }

    if (!response.ok) return null;
    return response.text();
  }

  _log(msg) {
    process.stderr.write(`[trakzure-mcp] ${msg}\n`);
  }
}
