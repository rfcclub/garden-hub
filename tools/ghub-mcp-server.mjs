#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, watch } from 'node:fs';

import { createStore } from './ghub-mcp-store.mjs';
import {
  CLAUDE_CHANNEL_CAPABILITY,
  createWakePublisher,
  resolveWakeAdapter,
  WAKE_CAPABILITY,
  WAKE_MODES,
} from './ghub-mcp-wake.mjs';
import {
  createPullRequest,
  getPullRequestSnapshot,
  mergePullRequest,
  parsePullRequestUrl,
  pollWatch,
  submitReview,
} from './ghub-mcp-github.mjs';

const PROTOCOL_VERSION = '2025-11-25';

const tools = [
  {
    name: 'message_send',
    description: 'Send a durable threaded message to the configured peer.',
    inputSchema: {
      type: 'object',
      required: ['to', 'body'],
      properties: {
        to: { type: 'string', enum: ['codex', 'claude-code'] },
        body: { type: 'string' },
        threadId: { type: 'string' },
      },
    },
  },
  {
    name: 'message_inbox',
    description: 'Read unacknowledged messages addressed to this configured actor.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'message_ack',
    description: 'Acknowledge one message addressed to this configured actor.',
    inputSchema: {
      type: 'object',
      required: ['messageId'],
      properties: { messageId: { type: 'string' } },
    },
  },
  {
    name: 'message_reply',
    description: 'Reply to an inbox message, preserving its thread ID.',
    inputSchema: {
      type: 'object',
      required: ['messageId', 'body'],
      properties: { messageId: { type: 'string' }, body: { type: 'string' } },
    },
  },
  {
    name: 'pr_watch',
    description: 'Durably watch a GitHub PR as its author or reviewer and return the current state.',
    inputSchema: {
      type: 'object',
      required: ['prUrl', 'mode'],
      properties: {
        prUrl: { type: 'string' },
        mode: { type: 'string', enum: ['author', 'reviewer'] },
      },
    },
  },
  {
    name: 'pr_create',
    description: 'Create a GitHub PR and immediately start an author watch.',
    inputSchema: {
      type: 'object',
      required: ['repo', 'head', 'base', 'title'],
      properties: {
        repo: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
    },
  },
  {
    name: 'pr_poll',
    description: 'Refresh one durable PR watch and report the next safe action.',
    inputSchema: {
      type: 'object',
      required: ['prUrl'],
      properties: { prUrl: { type: 'string' } },
    },
  },
  {
    name: 'pr_review',
    description: 'Submit a comment, change request, or approval as the configured GitHub login.',
    inputSchema: {
      type: 'object',
      required: ['prUrl', 'event'],
      properties: {
        prUrl: { type: 'string' },
        event: { type: 'string', enum: ['comment', 'request_changes', 'approve'] },
        body: { type: 'string' },
      },
    },
  },
  {
    name: 'pr_merge',
    description: 'Merge only after a freshly verified current-head/current-base non-author approval.',
    inputSchema: {
      type: 'object',
      required: ['prUrl'],
      properties: { prUrl: { type: 'string' } },
    },
  },
];

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function protocolError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function textResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function watchKey(ref, actor) {
  return `${ref.repo}#${ref.number}:${actor}`;
}

export function createMcpServer({
  root = process.env.GHUB_MCP_STATE_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '.garden-hub-mcp'),
  actor = process.env.GHUB_MCP_ACTOR,
  peers = (process.env.GHUB_MCP_PEERS || 'codex,claude-code').split(',').filter(Boolean),
  wakeAdapter = process.env.GHUB_MCP_WAKE_ADAPTER,
  emitNotification = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`),
  onWakeError = (error) => process.stderr.write(`garden-hub wake failed: ${error.message}\n`),
  github = {
    createPullRequest,
    getPullRequestSnapshot,
    mergePullRequest,
    parsePullRequestUrl,
    pollWatch,
    submitReview,
  },
} = {}) {
  const wakeMode = wakeAdapter || 'auto';
  if (!WAKE_MODES.includes(wakeMode)) {
    throw new Error(`GHUB_MCP_WAKE_ADAPTER must be one of ${WAKE_MODES.join(', ')}, or empty for auto`);
  }
  const store = createStore({ root, actor, peers });
  let adapter = '';
  let negotiated = false;
  let initialized = false;
  let watcher;
  let closed = false;
  const publish = createWakePublisher({ inbox: store.inbox, emit: emitNotification, adapter: () => adapter });
  function scan() {
    if (closed) return;
    try {
      publish();
    } catch (error) {
      onWakeError(error);
    }
  }
  function startWake() {
    if (!negotiated || initialized || closed) return;
    initialized = true;
    const messagesDir = join(root, 'messages');
    try {
      mkdirSync(messagesDir, { recursive: true, mode: 0o700 });
      watcher = watch(messagesDir, scan);
      watcher.on('error', onWakeError);
      scan();
    } catch (error) {
      onWakeError(error);
    }
  }
  function close() {
    closed = true;
    watcher?.close();
  }

  function snapshotFor(ref) {
    return github.getPullRequestSnapshot({ pullRequest: ref });
  }

  function ensureWatch(ref) {
    const watch = store.loadWatch(watchKey(ref, actor));
    if (!watch) throw new Error('PR is not watched by this actor; call pr_watch first');
    return watch;
  }

  function callTool(name, args = {}) {
    switch (name) {
      case 'message_send':
        return store.sendMessage(args);
      case 'message_inbox':
        return store.inbox();
      case 'message_ack':
        return store.ackMessage(args);
      case 'message_reply':
        return store.replyMessage(args);
      case 'pr_watch': {
        if (!['author', 'reviewer'].includes(args.mode)) throw new Error('mode must be author or reviewer');
        const ref = github.parsePullRequestUrl(args.prUrl);
        const existing = store.loadWatch(watchKey(ref, actor));
        const watch = existing ?? {
          key: watchKey(ref, actor),
          repo: ref.repo,
          number: ref.number,
          url: ref.url,
          actor,
          mode: args.mode,
          createdAt: new Date().toISOString(),
        };
        return github.pollWatch({ store, watch, snapshot: snapshotFor(ref) });
      }
      case 'pr_create': {
        const ref = github.createPullRequest(args);
        const watch = {
          key: watchKey(ref, actor),
          repo: ref.repo,
          number: ref.number,
          url: ref.url,
          actor,
          mode: 'author',
          createdAt: new Date().toISOString(),
        };
        return github.pollWatch({ store, watch, snapshot: snapshotFor(ref) });
      }
      case 'pr_poll': {
        const ref = github.parsePullRequestUrl(args.prUrl);
        return github.pollWatch({ store, watch: ensureWatch(ref), snapshot: snapshotFor(ref) });
      }
      case 'pr_review': {
        const ref = github.parsePullRequestUrl(args.prUrl);
        const review = github.submitReview({
          pullRequest: snapshotFor(ref),
          event: args.event,
          body: args.body,
        });
        store.audit('pr_review', `${ref.repo}#${ref.number}`);
        return review;
      }
      case 'pr_merge': {
        const ref = github.parsePullRequestUrl(args.prUrl);
        const merged = github.mergePullRequest({
          watch: ensureWatch(ref),
          snapshot: snapshotFor(ref),
        });
        store.audit('pr_merge', `${ref.repo}#${ref.number}`, merged.ok);
        return merged;
      }
      default:
        throw new Error(`unknown tool "${name}"`);
    }
  }

  function handle(request) {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return protocolError(request?.id, -32600, 'invalid JSON-RPC request');
    }
    const { id, method, params } = request;
    if (method === 'notifications/initialized') {
      startWake();
      return undefined;
    }
    if (method === 'initialize') {
      adapter = resolveWakeAdapter(wakeMode, params);
      negotiated = Boolean(adapter);
      // Forced common advertises the capability even when the client did not negotiate it.
      const advertised = adapter || (wakeMode === 'common' ? 'common' : '');
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          ...(advertised ? { experimental: {
            [WAKE_CAPABILITY]: { version: 1 },
            ...(adapter === 'claude' ? { [CLAUDE_CHANNEL_CAPABILITY]: {} } : {}),
          } } : {}),
        },
        serverInfo: { name: 'garden-hub', version: '0.1.0' },
      });
    }
    if (method === 'tools/list') return result(id, { tools });
    if (method === 'tools/call') {
      try {
        return result(id, textResult(callTool(params?.name, params?.arguments)));
      } catch (error) {
        return result(id, textResult({ error: error.message }, true));
      }
    }
    return protocolError(id, -32601, `method not found: ${method}`);
  }

  return { actor, handle, tools, close };
}

export function runStdio(server = createMcpServer()) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('close', () => server.close());
  lines.on('line', (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify(protocolError(null, -32700, 'parse error'))}\n`);
      return;
    }
    const response = server.handle(request);
    if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}

function isMainInvocation() {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isMainInvocation()) {
  try {
    runStdio();
  } catch (error) {
    process.stderr.write(`garden-hub MCP failed to start: ${error.message}\n`);
    process.exitCode = 1;
  }
}
