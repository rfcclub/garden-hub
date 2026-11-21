import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

function assertString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJsonAtomically(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}

export function createStore({ root, actor, peers, now = () => new Date() }) {
  assertString(root, 'root');
  assertString(actor, 'actor');
  if (!Array.isArray(peers) || !peers.every((peer) => typeof peer === 'string')) {
    throw new Error('peers must be an array of actor names');
  }
  const peerSet = new Set(peers);
  if (!peerSet.has(actor)) {
    throw new Error(`actor "${actor}" is not allowed`);
  }

  const messagesDir = join(root, 'messages');
  const acknowledgementsDir = join(root, 'acknowledgements');
  const watchesDir = join(root, 'watches');
  const auditPath = join(root, 'audit.jsonl');

  function ensureDir(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  function audit(action, target, ok = true) {
    ensureDir(root);
    const record = {
      id: randomUUID(),
      at: now().toISOString(),
      actor,
      action,
      target,
      ok,
    };
    appendFileSync(auditPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  function allMessages() {
    if (!existsSync(messagesDir)) return [];
    return readdirSync(messagesDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson(join(messagesDir, name)))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  function messageById(messageId) {
    assertString(messageId, 'messageId');
    const path = join(messagesDir, `${messageId}.json`);
    if (!existsSync(path)) throw new Error(`message "${messageId}" was not found`);
    return readJson(path);
  }

  function acknowledgementPath(messageId, acknowledgementActor) {
    return join(acknowledgementsDir, `${messageId}.${acknowledgementActor}.json`);
  }

  function sendMessage({ to, body, threadId = randomUUID(), replyTo } = {}) {
    assertString(to, 'to');
    assertString(body, 'body');
    assertString(threadId, 'threadId');
    if (!peerSet.has(to)) throw new Error(`recipient "${to}" is not allowed`);
    if (to === actor) throw new Error('cannot send a message to the same actor');
    if (body.length > 20_000) throw new Error('message body exceeds 20000 characters');
    if (replyTo !== undefined) assertString(replyTo, 'replyTo');

    const message = {
      id: randomUUID(),
      threadId,
      from: actor,
      to,
      body,
      createdAt: now().toISOString(),
      ...(replyTo === undefined ? {} : { replyTo }),
    };
    ensureDir(messagesDir);
    writeJsonAtomically(join(messagesDir, `${message.id}.json`), message);
    audit('message_send', to);
    return message;
  }

  function inbox() {
    return allMessages().filter(
      (message) =>
        message.to === actor && !existsSync(acknowledgementPath(message.id, actor)),
    );
  }

  function ackMessage({ messageId } = {}) {
    const message = messageById(messageId);
    if (message.to !== actor) {
      throw new Error('only the recipient can acknowledge a message');
    }
    ensureDir(acknowledgementsDir);
    const path = acknowledgementPath(message.id, actor);
    if (!existsSync(path)) {
      writeJsonAtomically(path, {
        messageId: message.id,
        actor,
        acknowledgedAt: now().toISOString(),
      });
      audit('message_ack', message.id);
    }
    return { messageId: message.id, actor, acknowledged: true };
  }

  function replyMessage({ messageId, body } = {}) {
    const original = messageById(messageId);
    if (original.to !== actor) {
      throw new Error('only the recipient can reply to a message');
    }
    return sendMessage({
      to: original.from,
      body,
      threadId: original.threadId,
      replyTo: original.id,
    });
  }

  function watchPath(key) {
    return join(watchesDir, `${encodeURIComponent(key)}.json`);
  }

  function saveWatch(watch) {
    assertString(watch?.key, 'watch.key');
    ensureDir(watchesDir);
    writeJsonAtomically(watchPath(watch.key), watch);
    audit('pr_watch', watch.key);
    return watch;
  }

  function loadWatch(key) {
    assertString(key, 'watch key');
    const path = watchPath(key);
    return existsSync(path) ? readJson(path) : null;
  }

  return {
    actor,
    peers: [...peerSet],
    ackMessage,
    audit,
    inbox,
    loadWatch,
    replyMessage,
    saveWatch,
    sendMessage,
  };
}
