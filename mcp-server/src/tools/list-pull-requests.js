/**
 * list_pull_requests — Fetch own + reviewing PRs for the authenticated user.
 */

export const definition = {
  name: 'list_pull_requests',
  description: 'List pull requests created by or assigned for review to the authenticated user.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['active', 'completed', 'abandoned'],
        description: 'PR status filter (default: active)',
      },
    },
  },
};

export async function handler(client, params) {
  const status = params.status || 'active';

  if (!client.userId) {
    return { content: [{ type: 'text', text: 'Error: not authenticated — userId not available' }], isError: true };
  }

  const fetchPRList = async (searchParams) => {
    const qs = new URLSearchParams({
      'api-version': client.apiVersion,
      '$top': '50',
      ...searchParams,
    }).toString();

    try {
      return await client._fetch(`${client.projectUrl}/_apis/git/pullrequests?${qs}`);
    } catch (err) {
      if (err.httpStatus === 404) {
        return client._fetch(`${client.baseUrl}/_apis/git/pullrequests?${qs}`);
      }
      throw err;
    }
  };

  const [ownRaw, reviewRaw] = await Promise.all([
    fetchPRList({ 'searchCriteria.creatorId': client.userId, 'searchCriteria.status': status }),
    fetchPRList({ 'searchCriteria.reviewerId': client.userId, 'searchCriteria.status': status }),
  ]);

  const ownList = ownRaw?.value || [];
  const reviewList = reviewRaw?.value || [];

  const mapPR = (pr) => {
    const repo = pr.repository || {};
    return {
      id: pr.pullRequestId,
      title: pr.title || '(no title)',
      status: pr.status || 'active',
      isDraft: pr.isDraft || false,
      repository: repo.name || '',
      sourceBranch: (pr.sourceRefName || '').replace('refs/heads/', ''),
      targetBranch: (pr.targetRefName || '').replace('refs/heads/', ''),
      createdDate: pr.creationDate || null,
      createdBy: pr.createdBy?.displayName || '',
      reviewers: (pr.reviewers || []).map(r => ({
        name: r.displayName,
        vote: voteLabel(r.vote),
        isRequired: r.isRequired || false,
      })),
    };
  };

  const own = ownList.map(mapPR);
  const ownIds = new Set(own.map(p => p.id));
  const reviewing = reviewList.filter(pr => !ownIds.has(pr.pullRequestId)).map(mapPR);

  const lines = [];
  if (own.length > 0) {
    lines.push(`## My Pull Requests (${own.length})\n`);
    for (const pr of own) {
      lines.push(formatPR(pr));
    }
  } else {
    lines.push(`## My Pull Requests\nNone.\n`);
  }

  if (reviewing.length > 0) {
    lines.push(`\n## Reviewing (${reviewing.length})\n`);
    for (const pr of reviewing) {
      lines.push(formatPR(pr));
    }
  } else {
    lines.push(`\n## Reviewing\nNone.\n`);
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function formatPR(pr) {
  const reviewerStr = pr.reviewers.length > 0
    ? pr.reviewers.map(r => `${r.name} (${r.vote}${r.isRequired ? ', required' : ''})`).join(', ')
    : 'no reviewers';
  const draft = pr.isDraft ? ' [DRAFT]' : '';
  return `- **#${pr.id}** ${pr.title}${draft}\n  ${pr.sourceBranch} → ${pr.targetBranch} | ${pr.repository} | ${reviewerStr}\n  Created by ${pr.createdBy} on ${pr.createdDate}\n`;
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
