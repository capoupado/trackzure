#!/usr/bin/env node

/**
 * Trakzure MCP Server — Azure DevOps PR review tools.
 *
 * Exposes PR diff, comments, details, and listing via MCP protocol (stdio transport).
 * Configure via environment variables:
 *   AZURE_DEVOPS_URL     — Base URL incl. collection (required)
 *   AZURE_DEVOPS_PAT     — Personal Access Token (required)
 *   AZURE_DEVOPS_PROJECT — Project name (required)
 *   AZURE_DEVOPS_API_VERSION — Starting API version (default: 7.0)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AzureClient } from './azure-client.js';

// Import tool modules
import * as listPullRequests from './tools/list-pull-requests.js';
import * as getPrDetails from './tools/get-pr-details.js';
import * as getPrDiff from './tools/get-pr-diff.js';
import * as getPrComments from './tools/get-pr-comments.js';
import * as addPrComment from './tools/add-pr-comment.js';

const log = (msg) => process.stderr.write(`[trakzure-mcp] ${msg}\n`);

async function main() {
  // Read config from env
  const config = {
    baseUrl: process.env.AZURE_DEVOPS_URL,
    pat: process.env.AZURE_DEVOPS_PAT,
    project: process.env.AZURE_DEVOPS_PROJECT,
    apiVersion: process.env.AZURE_DEVOPS_API_VERSION || '7.0',
  };

  if (!config.baseUrl || !config.pat || !config.project) {
    log('ERROR: AZURE_DEVOPS_URL, AZURE_DEVOPS_PAT, and AZURE_DEVOPS_PROJECT environment variables are required.');
    process.exit(1);
  }

  // Initialize Azure client
  const client = new AzureClient(config);
  try {
    await client.initialize();
  } catch (err) {
    log(`ERROR: Failed to authenticate: ${err.message}`);
    process.exit(1);
  }

  // Create MCP server
  const server = new McpServer({
    name: 'trakzure',
    version: '1.0.0',
  });

  // Register tools — each tool module exports { definition, handler }
  const tools = [listPullRequests, getPrDetails, getPrDiff, getPrComments, addPrComment];

  for (const tool of tools) {
    const def = tool.definition;
    // Convert JSON Schema properties to Zod for McpServer.tool()
    const zodShape = jsonSchemaToZod(def.inputSchema);
    server.tool(def.name, def.description, zodShape, async (params) => {
      try {
        return await tool.handler(client, params);
      } catch (err) {
        log(`Tool ${def.name} error: ${err.message}`);
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    });
  }

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP server running on stdio');
}

/**
 * Convert a simple JSON Schema object to a Zod shape for McpServer.tool().
 * Handles the subset we use: string, number, boolean, enums, required.
 */
function jsonSchemaToZod(schema) {
  if (!schema || !schema.properties) return {};

  const required = new Set(schema.required || []);
  const shape = {};

  for (const [key, prop] of Object.entries(schema.properties)) {
    let zodType;

    if (prop.enum) {
      zodType = z.enum(prop.enum);
    } else {
      switch (prop.type) {
        case 'number':
        case 'integer':
          zodType = z.number();
          break;
        case 'boolean':
          zodType = z.boolean();
          break;
        case 'string':
        default:
          zodType = z.string();
          break;
      }
    }

    if (prop.description) {
      zodType = zodType.describe(prop.description);
    }

    if (!required.has(key)) {
      zodType = zodType.optional();
    }

    shape[key] = zodType;
  }

  return shape;
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
