/**
 * get_pr_comments — Fetch PR comment threads with file context.
 */

export const definition = {
  name: 'get_pr_comments',
  description: 'Get comment threads on a pull request, optionally filtered by status. Returns threads with file context, line ranges, and all replies.',
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
      status: {
        type: 'string',
        enum: ['active', 'fixed', 'closed', 'all'],
        description: 'Filter threads by status (default: all)',
      },
    },
    required: ['pullRequestId'],
  },
};

export async function handler(client, params) {
  const { pullRequestId, status } = params;
  const repoId = await client.resolveRepoId(pullRequestId, params.repositoryId);

  const threadsUrl = `${client.projectUrl}/_apis/git/repositories/${repoId}/pullRequests/${pullRequestId}/threads?api-version=${client.apiVersion}`;
  const result = await client._fetch(threadsUrl);
  let threads = result?.value || [];

  // Filter out system/deleted threads — keep only threads with at least one text comment
  threads = threads.filter(t => !t.isDeleted && t.comments?.some(c => c.commentType === 'text'));

  // Filter by status
  if (status && status !== 'all') {
    threads = threads.filter(t => t.status === status);
  }

  if (threads.length === 0) {
    return { content: [{ type: 'text', text: `No ${status && status !== 'all' ? status + ' ' : ''}comment threads on PR #${pullRequestId}.` }] };
  }

  const lines = [`# Comments on PR #${pullRequestId} (${threads.length} threads)\n`];

  for (const thread of threads) {
    const ctx = thread.threadContext;
    const filePath = ctx?.filePath || null;
    const lineRange = ctx?.rightFileStart
      ? `L${ctx.rightFileStart.line}${ctx.rightFileEnd ? `-L${ctx.rightFileEnd.line}` : ''}`
      : ctx?.leftFileStart
        ? `L${ctx.leftFileStart.line} (deleted)${ctx.leftFileEnd ? `-L${ctx.leftFileEnd.line}` : ''}`
        : null;

    const statusBadge = thread.status ? `[${thread.status}]` : '';
    const location = filePath ? `${filePath}${lineRange ? `:${lineRange}` : ''}` : 'General';

    lines.push(`## Thread ${statusBadge} — ${location}\n`);

    const textComments = thread.comments.filter(c => c.commentType === 'text' && !c.isDeleted);
    for (const comment of textComments) {
      const author = comment.author?.displayName || 'Unknown';
      const date = comment.publishedDate ? new Date(comment.publishedDate).toISOString().slice(0, 16).replace('T', ' ') : '';
      lines.push(`**${author}** (${date}):`);
      lines.push(comment.content || '(empty)');
      lines.push('');
    }

    lines.push('---\n');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
