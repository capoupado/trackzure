/**
 * add_pr_comment — Create a new comment thread or reply to an existing one.
 */

export const definition = {
  name: 'add_pr_comment',
  description: 'Add a comment to a pull request. Creates a new thread (optionally on a specific file/line) or replies to an existing thread.',
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
      content: {
        type: 'string',
        description: 'Comment text (markdown supported)',
      },
      filePath: {
        type: 'string',
        description: 'File path for inline comment (optional — omit for general comment)',
      },
      lineNumber: {
        type: 'number',
        description: 'Start line number for inline comment (requires filePath)',
      },
      lineEndNumber: {
        type: 'number',
        description: 'End line number for inline comment range (optional)',
      },
      threadId: {
        type: 'number',
        description: 'Existing thread ID to reply to (optional — omit to create new thread)',
      },
      parentCommentId: {
        type: 'number',
        description: 'Parent comment ID for nested reply (optional)',
      },
    },
    required: ['pullRequestId', 'content'],
  },
};

export async function handler(client, params) {
  const { pullRequestId, content, filePath, lineNumber, lineEndNumber, threadId, parentCommentId } = params;
  const repoId = await client.resolveRepoId(pullRequestId, params.repositoryId);

  // Reply to existing thread
  if (threadId) {
    const url = `${client.projectUrl}/_apis/git/repositories/${repoId}/pullRequests/${pullRequestId}/threads/${threadId}/comments?api-version=${client.apiVersion}`;
    const body = { content };
    if (parentCommentId) body.parentCommentId = parentCommentId;

    const result = await client._fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    return {
      content: [{
        type: 'text',
        text: `Reply added to thread #${threadId} on PR #${pullRequestId}.\nComment ID: ${result?.id || 'unknown'}`,
      }],
    };
  }

  // Create new thread
  const threadBody = {
    comments: [{ content, commentType: 1 }],
    status: 1, // active
  };

  if (filePath) {
    threadBody.threadContext = {
      filePath: filePath.startsWith('/') ? filePath : '/' + filePath,
      rightFileStart: lineNumber ? { line: lineNumber, offset: 1 } : undefined,
      rightFileEnd: lineNumber ? { line: lineEndNumber || lineNumber, offset: 1 } : undefined,
    };
  }

  const url = `${client.projectUrl}/_apis/git/repositories/${repoId}/pullRequests/${pullRequestId}/threads?api-version=${client.apiVersion}`;
  const result = await client._fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(threadBody),
  });

  const locationStr = filePath
    ? ` on ${filePath}${lineNumber ? `:${lineNumber}` : ''}`
    : '';

  return {
    content: [{
      type: 'text',
      text: `New comment thread created on PR #${pullRequestId}${locationStr}.\nThread ID: ${result?.id || 'unknown'}`,
    }],
  };
}
