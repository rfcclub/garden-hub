import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { createStore } from '../../../tools/ghub-mcp-store.mjs';
import {
  evaluateMergeEligibility,
  mergePullRequest,
  pollWatch,
  submitReview,
} from '../../../tools/ghub-mcp-github.mjs';
import { createMcpServer } from '../../../tools/ghub-mcp-server.mjs';

function stateRoot() {
  return mkdtempSync(join(tmpdir(), 'garden-hub-orca-'));
}

function store(root: string, actor: string) {
  return createStore({
    root,
    actor,
    peers: ['codex', 'claude-code'],
    now: () => new Date('2026-10-13T12:00:00.000Z'),
  });
}

function snapshot({
  head = 'head-a',
  base = 'base-a',
  author = 'coder',
  reviews = [],
  unresolvedThreads = 0,
} = {}) {
  return {
    repo: 'example-org/garden-hub',
    number: 7,
    url: 'https://github.com/example-org/garden-hub/pull/7',
    author,
    head,
    base,
    reviews,
    unresolvedThreads,
  };
}

function approvedSnapshot({ head = 'head-a', base = 'base-a' } = {}) {
  return snapshot({
    head,
    base,
    reviews: [{
      user: { login: 'reviewer' },
      state: 'APPROVED',
      commit_id: head,
      submitted_at: '2026-10-13T12:00:00Z',
    }],
  });
}

describe('Garden Hub collaboration MCP', () => {
  test('[the-server-shall-bind-every-tool-call-to-its-configured-actor-mcp-001-message-actor-cannot-be-spoofed] message actor cannot be spoofed', () => {
    const root = stateRoot();
    const server = createMcpServer({ root, actor: 'codex', peers: ['codex', 'claude-code'] });
    const reply = server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'message_send',
        arguments: { to: 'claude-code', body: 'hello', from: 'claude-code' },
      },
    });

    expect(JSON.parse(reply.result.content[0].text).from).toBe('codex');
  });

  test('[the-server-shall-bind-every-tool-call-to-its-configured-actor-mcp-002-unknown-actor-is-rejected] unknown actor is rejected', () => {
    const root = stateRoot();

    expect(() => createMcpServer({
      root,
      actor: 'pretender',
      peers: ['codex', 'claude-code'],
    })).toThrow(/not allowed/i);
    expect(readdirSync(root)).toEqual([]);
  });

  test('[the-server-shall-expose-standard-callable-mcp-tools-mcp-003-two-configured-clients-share-one-state-store] two configured clients share one state store', () => {
    const root = stateRoot();
    const peers = ['codex', 'claude-code'];
    const peerA = createMcpServer({ root, actor: 'codex', peers });
    const claude = createMcpServer({ root, actor: 'claude-code', peers });
    const sent = peerA.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'message_send', arguments: { to: 'claude-code', body: 'review PR 7' } },
    });
    const message = JSON.parse(sent.result.content[0].text);
    const inbox = claude.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'message_inbox', arguments: {} },
    });
    const [received] = JSON.parse(inbox.result.content[0].text);
    expect(received.id).toBe(message.id);
    const acknowledgement = claude.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'message_ack', arguments: { messageId: message.id } },
    });
    expect(JSON.parse(acknowledgement.result.content[0].text)).toMatchObject({
      messageId: message.id,
      actor: 'claude-code',
      acknowledged: true,
    });
  });

  test('[a-pr-watch-shall-retain-responsibility-across-polls-pr-001-new-head-requires-another-review-pass] new head requires another review pass', () => {
    const root = stateRoot();
    const watch = {
      key: 'example-org/garden-hub#7:codex',
      repo: 'example-org/garden-hub',
      number: 7,
      mode: 'reviewer',
      actor: 'codex',
      lastHeadSha: 'head-a',
      approvedHeadSha: 'head-a',
      approvedBaseSha: 'base-a',
    };

    const result = pollWatch({ store: store(root, 'codex'), watch, snapshot: snapshot({ head: 'head-b' }) });
    expect(result.state).toBe('needs_review');
    expect(result.watch.approvedHeadSha).toBeUndefined();
    expect(result.watch.approvedBaseSha).toBeUndefined();
  });

  test('[a-pr-watch-shall-retain-responsibility-across-polls-pr-002-pr-creation-starts-an-author-watch] PR creation starts an author watch', async () => {
    const root = stateRoot();
    const ref = {
      repo: 'example-org/garden-hub',
      number: 7,
      url: 'https://github.com/example-org/garden-hub/pull/7',
    };
    const github = {
      createPullRequest: () => ref,
      getPullRequestSnapshot: () => snapshot(),
      mergePullRequest: () => ({ ok: true }),
      parsePullRequestUrl: () => ref,
      pollWatch: ({ store: activeStore, watch, snapshot: current }) => {
        const saved = activeStore.saveWatch({ ...watch, lastHeadSha: current.head, state: 'awaiting_review' });
        return { state: saved.state, watch: saved };
      },
      submitReview: () => ({ ok: true }),
    };
    const githubApp = {
      describe: () => ({ githubApp: { configured: true } }),
      mintToken: async () => 'ghs_installationtokenvalue0000',
    };
    const server = createMcpServer({ root, actor: 'codex', peers: ['codex', 'claude-code'], githubApp, github });

    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'pr_create',
        arguments: { repo: ref.repo, head: 'feature', base: 'main', title: 'Feature' },
      },
    });

    const result = JSON.parse(response.result.content[0].text);
    expect(result.watch).toMatchObject({
      key: 'example-org/garden-hub#7:codex',
      repo: ref.repo,
      number: ref.number,
      actor: 'codex',
      mode: 'author',
    });
    expect(store(root, 'codex').loadWatch(result.watch.key)).toMatchObject({ mode: 'author' });
  });

  test('[pr-review-shall-never-be-submitted-as-the-pr-author-pr-003-self-review-is-rejected] self-review is rejected', () => {
    const calls: string[][] = [];
    expect(() => submitReview({
      run: (args: string[]) => {
        calls.push(args);
        if (args.join(' ') === 'api user --jq .login') return { stdout: 'coder\n' };
        throw new Error(`unexpected command: ${args.join(' ')}`);
      },
      pullRequest: snapshot({ author: 'coder' }),
      event: 'approve',
      body: 'looks good',
    })).toThrow(/author/i);
    expect(calls).toHaveLength(1);
  });

  test('[pr-merge-shall-fail-closed-on-stale-or-incomplete-review-evidence-pr-004-stale-head-approval-cannot-merge] stale head approval cannot merge', () => {
    const calls: string[][] = [];
    const result = mergePullRequest({
      run: (args: string[]) => calls.push(args),
      watch: { approvedHeadSha: 'head-a', approvedBaseSha: 'base-a' },
      snapshot: approvedSnapshot({ head: 'head-b' }),
    });

    expect(result).toEqual({ ok: false, code: 'approval_stale' });
    expect(calls).toEqual([]);
  });

  test('[pr-merge-shall-fail-closed-on-stale-or-incomplete-review-evidence-pr-005-changed-base-invalidates-approval] changed base invalidates approval', () => {
    const result = evaluateMergeEligibility({
      watch: { approvedHeadSha: 'head-a', approvedBaseSha: 'base-a' },
      snapshot: approvedSnapshot({ base: 'base-b' }),
    });
    expect(result).toEqual({ ok: false, code: 'base_stale' });
  });

  test('[pr-merge-shall-fail-closed-on-stale-or-incomplete-review-evidence-pr-006-eligible-approval-merges-against-expected-head] eligible approval merges against expected head', () => {
    const calls: string[][] = [];
    const pr = approvedSnapshot();
    const result = mergePullRequest({
      run: (args: string[]) => {
        calls.push(args);
        return { stdout: '' };
      },
      watch: { approvedHeadSha: 'head-a', approvedBaseSha: 'base-a' },
      snapshot: pr,
    });

    expect(result).toEqual({ ok: true, head: 'head-a' });
    expect(calls.at(0)).toContain('--match-head-commit');
    expect(calls.at(0)).toContain('head-a');
  });

  test('[messages-shall-remain-deliverable-until-acknowledged-msg-001-offline-recipient-later-receives-the-message] offline recipient later receives the message', () => {
    const root = stateRoot();
    const sent = store(root, 'codex').sendMessage({ to: 'claude-code', body: 'please review' });
    expect(store(root, 'claude-code').inbox()).toEqual([sent]);
  });

  test('[messages-shall-remain-deliverable-until-acknowledged-msg-002-acknowledgement-is-recipient-bound] acknowledgement is recipient-bound', () => {
    const root = stateRoot();
    const sent = store(root, 'codex').sendMessage({ to: 'claude-code', body: 'hello' });
    expect(() => store(root, 'codex').ackMessage({ messageId: sent.id })).toThrow(/recipient/i);
    expect(store(root, 'claude-code').inbox()).toEqual([sent]);
  });

  test('[messages-shall-remain-deliverable-until-acknowledged-msg-003-reply-preserves-the-source-thread] reply preserves the source thread', () => {
    const root = stateRoot();
    const sent = store(root, 'codex').sendMessage({ to: 'claude-code', body: 'ready?' });
    const reply = store(root, 'claude-code').replyMessage({ messageId: sent.id, body: 'ready' });

    expect(reply.threadId).toBe(sent.threadId);
    expect(reply.replyTo).toBe(sent.id);
  });

  test('[messages-shall-remain-deliverable-until-acknowledged-msg-004-audit-records-omit-credentials] audit records omit credentials', () => {
    const root = stateRoot();
    store(root, 'codex').sendMessage({ to: 'claude-code', body: 'token=not-for-audit' });
    const audit = readFileSync(join(root, 'audit.jsonl'), 'utf8');

    expect(audit).not.toContain('not-for-audit');
    expect(JSON.parse(audit.trim())).toMatchObject({
      actor: 'codex',
      action: 'message_send',
      target: 'claude-code',
      ok: true,
    });
  });
});
