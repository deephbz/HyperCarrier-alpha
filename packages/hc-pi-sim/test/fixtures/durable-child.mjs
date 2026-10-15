import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { SimWorld } from '../../src/index.mjs';
const world = await SimWorld.create({ root: process.argv[2], seed: 17, sessionStorage: 'durable', replies: [{ text: 'durable answer' }] });
try {
  await world.prompt('durable question');
  const file = world.sessionManager.getSessionFile();
  const content = fs.readFileSync(file, 'utf8');
  console.log(JSON.stringify({ file, content, hash: createHash('sha256').update(content).digest('hex'), trace: world.report().trace }));
  world.assertHealthy();
} finally { await world.close(); }
