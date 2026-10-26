// T3place fixture: the node owns its disposable store. No external model transport.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { target } from './hub.mjs';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';

const fromTarget = path => import(pathToFileURL(join(target, 'apps/ampi', path)).href);
const [{ runDaemon }, { openModels }, { simProvider }, { TestClient }] = await Promise.all([
  fromTarget('src/node/daemon.ts'), fromTarget('src/node/models.ts'),
  fromTarget('src/node/sim.ts'), fromTarget('test/helpers.ts'),
]);
const [, dir] = process.argv.slice(2);
const home = join(dir, 'home'), agentDir = join(dir, 'agent'), cwd = join(dir, 'work');
for (const path of [home, agentDir, cwd]) mkdirSync(path, { recursive: true });
const models = openModels({ home, agentDir });
models.clearProviders();
models.setProvider(simProvider({ tokensPerSecond: 80, contextWindow: 1000000 }));
const reports = [];
const daemon = await runDaemon({ home, agentDir, models, report: error => reports.push(String(error)) });
const client = await TestClient.connect(daemon.socket);
const { threadId } = await client.req('thread.create', {
  requestId: 'reading-place', cwd, model: { provider: 'ampi-sim', modelId: 'sim-1' },
  place: { workspace: 'new', label: 'Reading place' },
});
await client.req('thread.rename', { threadId, title: 'Reading place durable' });
const { conversation } = await daemon.runtime.thread(threadId);
let count = 0;
async function append(n, mixed = false) {
  const ids = [];
  await conversation.commit(async tx => {
    for (let i = 0; i < n; i++) {
      const k = ++count;
      const entry = await tx.appendEntry(conversation.id, {
        kind: 'pi.assistant',
        model: [fauxAssistantMessage(mixed ? [
          { type: 'text', text: `Before tool ${k}. ${'Synthetic prose. '.repeat(30)}` },
          { type: 'toolCall', id: `mixed-${k}`, name: 'read', arguments: { path: 'synthetic.txt' } },
          { type: 'text', text: `After tool ${k}. ${'Synthetic prose. '.repeat(30)}` },
        ] : `DURABLE_SCROLL_${k}\n\n${'Synthetic evidence below the reader. '.repeat(8 + k % 5)}`)],
      });
      ids.push(String(entry.id));
    }
  }, ctx);
  return { count, ids };
}
await append(180);
process.on('message', message => { void (async () => {
  let value;
  if (message.command === 'append') value = await append(message.n, message.mixed);
  else if (message.command === 'submit') {
    await client.req('thread.submit', { threadId, content: '/sim long 2' });
    value = { admitted: true };
  } else if (message.command === 'busy') {
    await client.req('thread.submit', { threadId, content: '/sim bash sleep 60' });
    value = { admitted: true };
  } else if (message.command === 'idle') {
    value = await client.req('thread.abort', { threadId });
  } else if (message.command === 'arrival') {
    const { kind, callId } = message;
    const text = kind === 'notice' ? 'SCROLL_NOTICE' : kind === 'result' ? 'SCROLL_TOOL_RESULT ' + 'Result prose. '.repeat(100) : 'SCROLL_TOOL_CALL';
    const model = ['notice', 'team'].includes(kind)
      ? { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }
      : kind === 'result'
        ? { role: 'toolResult', toolCallId: callId, toolName: 'read', content: [{ type: 'text', text }], isError: false, timestamp: Date.now() }
        : fauxAssistantMessage([{ type: 'toolCall', id: callId, name: 'read', arguments: { path: 'synthetic.txt' } }]);
    const entry = await conversation.commit(tx => tx.appendEntry(conversation.id, {
      kind: kind === 'team' ? 'pi-team-bright.notice' : kind === 'notice' ? 'fixture.notice' : kind === 'result' ? 'pi.tool-result' : 'pi.assistant',
      model: [model],
    }), ctx);
    value = { id: String(entry.id) };
  } else if (message.command === 'finish') {
    client.close();
    await daemon.stop();
    process.send({ type: 'result', value: { stopped: true, reports } });
    process.disconnect();
    return;
  } else throw new Error('Unknown fixture command');
  process.send({ type: message.command, name: message.name, value });
})().catch(error => process.send({ type: 'failure', name: message.name, value: String(error) })); });
process.once('disconnect', () => process.exit());
process.send({ type: 'ready', value: { home, threadId, count } });
