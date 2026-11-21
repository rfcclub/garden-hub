import { INBOX_INSTRUCTION, isWakeEnvelope, WAKE_METHOD } from '../tools/ghub-mcp-wake.mjs';

// Loading this extension and configuring the server's omp adapter are opt-in.
export default function gardenHubWake(pi) {
  const seen = new Set();
  pi.on('mcp_notification', (event) => {
    if (event.server !== 'garden-hub' || event.method !== WAKE_METHOD ||
        !isWakeEnvelope(event.params) || event.params.recipient !== 'codex') return;
    const { messageId } = event.params;
    if (seen.has(messageId)) return;
    pi.sendUserMessage(INBOX_INSTRUCTION, { deliverAs: 'aside' });
    seen.add(messageId);
  });
}
