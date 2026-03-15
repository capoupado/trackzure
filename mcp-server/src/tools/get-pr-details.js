/**
 * get_pr_details — Fetch full PR metadata: description, reviewers, labels, work items.
 */

export const definition = {
  name: 'get_pr_details',
  description: 'Get detailed information about a pull request including description, reviewers with vote status, labels, and linked work items.',
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
    },
    required: ['pullRequestId'],
  },
};

export async function handler(client, params) {
  const { pullRequestId } = params;
  let repoId = params.repositoryId;

  // Resolve PR and repo
  let prData;
  if (repoId) {
    const url = `${client.projectUrl}/_apis/git/repositories/${repoId}/pullRequests/${pullRequestId}?api-version=${client.apiVersion}`;
    prData = await client._fetch(url);
  } else {
    prData = await client.resolvePr(pullRequestId);
    if (!prData) {
      return { content: [{ type: 'text', text: `PR #${pullRequestId} not found` }], isError: true };
    }
    repoId = prData.repository?.id;
  }

  // Fetch work items linked to the PR (non-fatal)
  let workItems = [];
  try {
    const wiUrl = `${client.projectUrl}/_apis/git/repositories/${repoId}/pullRequests/${pullRequestId}/workitems?api-version=${client.apiVersion}`;
    const wiResult = await client._fetch(wiUrl);
    workItems = (wiResult?.value || []).map(wi => ({
      id: wi.id,
      url: wi.url,
    }));
  } catch { /* non-fatal */ }

  // Fetch thread count (non-fatal)
  let threadCount = 0;
  let activeThreadCount = 0;
  try {
    const threadsUrl = `${client.projectUrl}/_apis/git/repositories/${repoId}/pullRequests/${pullRequestId}/threads?api-version=${client.apiVersion}`;
    const threadsResult = await client._fetch(threadsUrl);
    const threads = threadsResult?.value || [];
    threadCount = threads.filter(t => !t.isDeleted && t.comments?.some(c => c.commentType === 'text')).length;
    activeThreadCount = threads.filter(t => !t.isDeleted && t.status === 'active').length;
  } catch { /* non-fatal */ }

  const repo = prData.repository || {};
  const reviewers = (prData.reviewers || []).map(r => ({
    name: r.displayName,
    vote: voteLabel(r.vote),
    isRequired: r.isRequired || false,
  }));

  const lines = [
    `# PR #${prData.pullRequestId}: ${prData.title || '(no title)'}`,
    '',
    `**Status:** ${prData.status}${prData.isDraft ? ' (DRAFT)' : ''}`,
    `**Repository:** ${repo.name || 'unknown'}`,
    `**Source:** ${(prData.sourceRefName || '').replace('refs/heads/', '')}`,
    `**Target:** ${(prData.targetRefName || '').replace('refs/heads/', '')}`,
    `**Created by:** ${prData.createdBy?.displayName || 'unknown'} on ${prData.creationDate || 'unknown'}`,
    `**Merge status:** ${prData.mergeStatus || 'unknown'}`,
    `**Threads:** ${threadCount} total, ${activeThreadCount} active`,
    '',
  ];

  if (prData.description) {
    lines.push('## Description', '', prData.description, '');
  }

  if (reviewers.length > 0) {
    lines.push('## Reviewers', '');
    for (const r of reviewers) {
      lines.push(`- ${r.name}: **${r.vote}**${r.isRequired ? ' (required)' : ''}`);
    }
    lines.push('');
  }

  if (prData.labels?.length > 0) {
    lines.push('## Labels', '');
    lines.push(prData.labels.map(l => l.name).join(', '));
    lines.push('');
  }

  if (workItems.length > 0) {
    lines.push('## Linked Work Items', '');
    for (const wi of workItems) {
      lines.push(`- #${wi.id}`);
    }
    lines.push('');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function voteLabel(vote) {
  switch (vote) {
    case 10: return 'approved';
    case 5: return 'approved with suggestions';
    case 0: return 'no vote';
    case -5: return 'waiting for author';
    case -10: return 'rejected';
    default: return `vote:${vote}`;
  }
}
