import { writeFileSync } from 'node:fs';

export default function observeInput(pi) {
  let sessionId;
  const messages = [];
  pi.on('session_start', (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    writeFileSync(process.env.GHUB_TEST_READY, 'ready');
  });
  pi.on('message_end', ({ message }) => {
    messages.push({
      role: message.role,
      ...(message.role === 'user' ? { content: message.content } : {}),
      ...(message.role === 'assistant' ? {
        provider: message.provider, model: message.model,
        toolCalls: message.content.filter(part => part.type === 'toolCall').map(part => part.name),
      } : {}),
      ...(message.role === 'toolResult' ? { toolName: message.toolName, isError: message.isError } : {}),
    });
  });
  pi.on('agent_end', () => {
    writeFileSync(process.env.GHUB_TEST_RECEIPT, JSON.stringify({
      sessionId, messages,
    }));
  });
}
