/**
 * get_pr_diff — Fetch unified diff for a pull request.
 *
 * 3-tier fallback strategy:
 *   1. Iterations API (Azure DevOps 2019+)
 *   2. Commits diff API (older TFS)
 *   3. Per-commit changes (last resort)
 *
 * Guardrails: 50-file cap, 500-line per-file cap, binary skip, optional single-file filter.
 */

import { formatUnifiedDiff, isBinary } from '../diff-formatter.js';

const MAX_FILES = 50;
const MAX_LINES_PER_FILE = 500;

export const definition = {
  name: 'get_pr_diff',
  description: 'Get the unified diff for a pull request. Returns the full diff or a single file diff. Large PRs are automatically summarized.',
  inputSchema: {
    type: 'object',
    properties: {
      pullRequestId: {
        type: 'number',
        description: 'The pull request ID',
      },
      repositoryId: {
        type: 'string',
        description: 'Repository ID (optional — resolved automatically if omitted)',
      },
      filePath: {
        type: 'string',
        description: 'Filter to a single file path (optional)',
      },
    },
    required: ['pullRequestId'],
  },
};

export async function handler(client, params) {
  const { pullRequestId, filePath } = params;
  const repoId = await client.resolveRepoId(pullRequestId, params.repositoryId);

  // Try each strategy in order
  let changes = null;
  let sourceVersion = null;
  let targetVersion = null;

  // Strategy 1: Iterations API
  try {
    const result = await getChangesViaIterations(client, repoId, pullRequestId);
    changes = result.changes;
    sourceVersion = result.sourceVersion;
    targetVersion = result.targetVersion;
  } catch (err) {
    client._log(`Iterations API failed: ${err.message} — trying commits diff`);
  }

  // Strategy 2: Commits diff
  if (!changes) {
    try {
      const result = await getChangesViaCommitsDiff(client, repoId, pullRequestId);
      changes = result.changes;
      sourceVersion = result.sourceVersion;
      targetVersion = result.targetVersion;
    } catch (err) {
      client._log(`Commits diff failed: ${err.message} — trying per-commit`);
    }
  }

  // Strategy 3: Per-commit changes
  if (!changes) {
    try {
      const result = await getChangesViaCommits(client, repoId, pullRequestId);
      changes = result.changes;
      sourceVersion = result.sourceVersion;
      targetVersion = result.targetVersion;
    } catch (err) {
      return { content: [{ type: 'text', text: `Failed to get diff for PR #${pullRequestId}: ${err.message}` }], isError: true };
    }
  }

  if (!changes || changes.length === 0) {
    return { content: [{ type: 'text', text: `No changes found in PR #${pullRequestId}.` }] };
  }

  // Filter to single file if requested
  if (filePath) {
    const normalized = filePath.startsWith('/') ? filePath : '/' + filePath;
    changes = changes.filter(c => c.path === normalized || c.path === filePath);
    if (changes.length === 0) {
      return { content: [{ type: 'text', text: `File '${filePath}' not found in PR #${pullRequestId}.` }], isError: true };
    }
  }

  // Build diffs
  const totalFiles = changes.length;
  const capped = changes.slice(0, MAX_FILES);
  const skippedCount = totalFiles - capped.length;

  const diffs = [];
  for (const change of capped) {
    const diff = await buildFileDiff(client, repoId, change, sourceVersion, targetVersion);
    diffs.push(diff);
  }

  const lines = [`# Diff for PR #${pullRequestId} (${totalFiles} files)\n`];
  for (const d of diffs) {
    lines.push(d);
  }

  if (skippedCount > 0) {
    lines.push(`\n... and ${skippedCount} more files (use filePath param to drill in)\n`);
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ---------------------------------------------------------------------------
// Strategy 1: Iterations API
// ---------------------------------------------------------------------------

async function getChangesViaIterations(client, repoId, prId) {
  const iterationsUrl = `${client.projectUrl}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations?api-version=${client.apiVersion}`;
  const iterResult = await client._fetch(iterationsUrl);
  const iterations = iterResult?.value || [];
  if (iterations.length === 0) throw new Error('No iterations found');

  const lastIteration = iterations[iterations.length - 1];
  const iterationId = lastIteration.id;

  // Get changes comparing first iteration base to latest
  const changesUrl = `${client.projectUrl}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations/${iterationId}/changes?api-version=${client.apiVersion}&$compareTo=0`;
  const changesResult = await client._fetch(changesUrl);
  const changeEntries = changesResult?.changeEntries || [];

  const sourceVersion = lastIteration.targetRefCommit?.commitId || lastIteration.commonRefCommit?.commitId;
  const targetVersion = lastIteration.sourceRefCommit?.commitId;

  const changes = changeEntries
    .filter(e => e.item?.path && !e.item.isFolder)
    .map(e => ({
      path: e.item.path,
      changeType: normalizeChangeType(e.changeType),
      originalPath: e.originalPath,
    }));

  return { changes, sourceVersion, targetVersion };
}

// ---------------------------------------------------------------------------
// Strategy 2: Commits diff API
// ---------------------------------------------------------------------------

async function getChangesViaCommitsDiff(client, repoId, prId) {
  // Get PR to find source/target refs
  const prUrl = `${client.projectUrl}/_apis/git/repositories/${repoId}/pullRequests/${prId}?api-version=${client.apiVersion}`;
  const prData = await client._fetch(prUrl);

  const sourceBranch = prData.sourceRefName;
  const targetBranch = prData.targetRefName;

  const diffUrl = `${client.projectUrl}/_apis/git/repositories/${repoId}/diffs/commits?api-version=${client.apiVersion}&baseVersion=${encodeURIComponent(targetBranch.replace('refs/heads/', ''))}&targetVersion=${encodeURIComponent(sourceBranch.replace('refs/heads/', ''))}`;
  const diffResult = await client._fetch(diffUrl);

  const sourceVersion = diffResult?.baseCommit;
  const targetVersion = diffResult?.targetCommit;

  const changes = (diffResult?.changes || [])
    .filter(c => c.item?.path && !c.item.isFolder)
    .map(c => ({
      path: c.item.path,
      changeType: normalizeChangeType(c.changeType),
      originalPath: c.sourceServerItem,
    }));

  return { changes, sourceVersion, targetVersion };
}

// ---------------------------------------------------------------------------
// Strategy 3: Per-commit changes
// ---------------------------------------------------------------------------

async function getChangesViaCommits(client, repoId, prId) {
  const commitsUrl = `${client.projectUrl}/_apis/git/repositories/${repoId}/pullRequests/${prId}/commits?api-version=${client.apiVersion}`;
  const commitsResult = await client._fetch(commitsUrl);
  const commits = commitsResult?.value || [];
  if (commits.length === 0) throw new Error('No commits found in PR');

  // Get PR for target branch info
  const prUrl = `${client.projectUrl}/_apis/git/repositories/${repoId}/pullRequests/${prId}?api-version=${client.apiVersion}`;
  const prData = await client._fetch(prUrl);

  const sourceVersion = prData.lastMergeTargetCommit?.commitId;
  const targetVersion = prData.lastMergeSourceCommit?.commitId;

  // Aggregate unique changed files from all commits
  const fileMap = new Map();
  for (const commit of commits.slice(0, 20)) { // cap at 20 commits
    try {
      const changesUrl = `${client.projectUrl}/_apis/git/repositories/${repoId}/commits/${commit.commitId}/changes?api-version=${client.apiVersion}`;
      const changesResult = await client._fetch(changesUrl);
      for (const change of (changesResult?.changes || [])) {
        if (change.item?.path && !change.item.isFolder) {
          fileMap.set(change.item.path, {
            path: change.item.path,
            changeType: normalizeChangeType(change.changeType),
            originalPath: change.sourceServerItem,
          });
        }
      }
    } catch { /* skip individual commit failures */ }
  }

  return { changes: Array.from(fileMap.values()), sourceVersion, targetVersion };
}

// ---------------------------------------------------------------------------
// Diff building
// ---------------------------------------------------------------------------

async function buildFileDiff(client, repoId, change, sourceVersion, targetVersion) {
  if (change.changeType === 'delete') {
    if (!sourceVersion) return `diff --git a${change.path} b${change.path}\ndeleted file\n`;
    const oldContent = await client.fetchFileContent(repoId, change.path, sourceVersion);
    if (isBinary(oldContent)) return `diff --git a${change.path} b${change.path}\nBinary file deleted\n`;
    return truncateDiff(formatUnifiedDiff(change.path, oldContent, null));
  }

  if (change.changeType === 'add') {
    if (!targetVersion) return `diff --git a${change.path} b${change.path}\nnew file\n`;
    const newContent = await client.fetchFileContent(repoId, change.path, targetVersion);
    if (isBinary(newContent)) return `diff --git a${change.path} b${change.path}\nBinary file added\n`;
    return truncateDiff(formatUnifiedDiff(change.path, null, newContent));
  }

  // edit or rename
  const oldPath = change.originalPath || change.path;
  const [oldContent, newContent] = await Promise.all([
    sourceVersion ? client.fetchFileContent(repoId, oldPath, sourceVersion) : Promise.resolve(null),
    targetVersion ? client.fetchFileContent(repoId, change.path, targetVersion) : Promise.resolve(null),
  ]);

  if (isBinary(oldContent) || isBinary(newContent)) {
    return `diff --git a${oldPath} b${change.path}\nBinary file changed\n`;
  }

  // If both contents are null or identical, skip
  if (oldContent === newContent) {
    if (oldPath !== change.path) {
      return `diff --git a${oldPath} b${change.path}\nFile renamed (no content change)\n`;
    }
    return `diff --git a${change.path} b${change.path}\n(no content change)\n`;
  }

  return truncateDiff(formatUnifiedDiff(change.path, oldContent, newContent));
}

function truncateDiff(diff) {
  const lines = diff.split('\n');
  if (lines.length <= MAX_LINES_PER_FILE) return diff;
  return lines.slice(0, MAX_LINES_PER_FILE).join('\n') + `\n... (truncated, ${lines.length - MAX_LINES_PER_FILE} more lines)\n`;
}

function normalizeChangeType(raw) {
  if (!raw) return 'edit';
  const lower = String(raw).toLowerCase();
  if (lower.includes('add')) return 'add';
  if (lower.includes('delete')) return 'delete';
  if (lower.includes('rename')) return 'rename';
  return 'edit';
}
