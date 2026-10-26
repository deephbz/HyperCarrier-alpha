// T3place uses the lane-1 page and browser. Fixture arrivals never touch owner data.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { CrashChild } from '../../test/durable-l2/process.ts';
import { topicSnapshot } from './live-rows.mjs';
import { href } from '../../web/src/util.ts';
import { target, submodulesPinned } from './hub.mjs';
import { webDistCurrent } from '../web-inputs.mjs';

async function until(check, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Deadline: ' + label);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

export async function readingPlace(j) {
  assert.ok(submodulesPinned(target).ok, 'fixture submodule pins');
  assert.ok(webDistCurrent(target).ok, 'fixture web build');
  const run = mkdtempSync(join(tmpdir(), 'ampi-reading-place-'));
  const proof = join(j.state.proof, 'T3place');
  mkdirSync(proof, { recursive: true });
  const p = j.page, context = p.context(), children = [], failures = [];
  await p.setViewportSize({ width: 1280, height: 800 });
  const receipt = {
    prediction: 'Surviving fragments stay within 2px after arrivals, downward extension, and resize. Away windows paint no arrivals until a reader extends them. Retained rows plateau. G returns within 2px of the end and releases retained rows. A running conversation-only fold has no drift over ten seconds without arrivals. working clears on idle and G. The omission divider survives fragment restoration.',
    fixturePreconditions: '180 initial entries per carrier; file appends and node commits create arrivals.',
    spendUsd: 0, rows: [],
  };
  const save = () => writeFileSync(join(proof, 'reading-place.json'), JSON.stringify(receipt, null, 2) + '\n');
  let node, hub, allowPattern, activeRead, seq = 0, piCount = 0, piLast = null, piFile;
  const ipc = async (child, command, args = {}) => {
    const name = 'op' + (++seq);
    child.child.send({ command, name, ...args });
    return (await child.wait(command, name, 20000)).value;
  };
  const frames = () => j.settle();
  const scroll = () => p.locator('[data-region="transcript"]');
  const measure = (sourceIds = []) => scroll().evaluate((el, sourceIds) => {
    const box = el.getBoundingClientRect(), nodes = [...el.querySelectorAll('[data-entry]')];
    const first = nodes.find(e => e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().bottom > box.top + 1);
    const ids = nodes.map(n => n.dataset.entry), unique = [...new Set(ids)], served = new Set(sourceIds);
    return { entry: first?.dataset.entry, fragment: first ? nodes.filter(n => n.dataset.entry === first.dataset.entry).indexOf(first) : -1,
      offset: first?.getBoundingClientRect().top - box.top,
      top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight,
      gap: el.scrollHeight - el.clientHeight - el.scrollTop, painted: nodes.length, uniquePainted: unique.length,
      retained: unique.filter(id => !served.has(id)).length, retainedFragments: ids.filter(id => !served.has(id)).length,
      sourceCount: sourceIds.length, first: ids[0], last: ids.at(-1) };
  }, sourceIds);
  const position = anchor => scroll().evaluate((el, anchor) => {
    const entry = [...el.querySelectorAll('[data-entry]')].filter(e => e.dataset.entry === anchor.entry)[anchor.fragment];
    return entry?.getBoundingClientRect().height > 0 ? entry.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
  }, anchor);
  const move = async mode => {
    await p.mouse.move(10, 10);
    if (mode === 'tail') { await scroll().focus(); await p.keyboard.press('Shift+G'); await frames(); return; }
    await scroll().evaluate((el, mode) => { el.scrollTop = mode === 'tail' ? el.scrollHeight : mode === 'stationary' ? 300 : el.scrollHeight - 2.5 * el.clientHeight; }, mode);
    await frames();
  };
  const lens = async folded => {
    const button = p.getByRole('button', { name: 'Transcript mode: ' + (folded ? 'full transcript' : 'conversation only'), exact: true });
    if (await button.count()) await button.click();
    await p.mouse.move(10, 10);
    await frames();
  };
  function piMessage(message, customType) {
    const id = 'arrival-' + (++seq), timestamp = new Date().toISOString();
    const row = customType
      ? { type: 'custom_message', id, parentId: piLast, timestamp, customType, content: message, display: true }
      : { type: 'message', id, parentId: piLast, timestamp, message };
    appendFileSync(piFile, JSON.stringify(row) + '\n');
    piLast = id;
    return id;
  }
  const assistant = content => ({ role: 'assistant', content, provider: 'fixture', model: 'sim', timestamp: Date.now(), stopReason: 'stop',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } });
  function piAppend(n, mixed = false) {
    for (let i = 0; i < n; i++) {
      const k = ++piCount;
      piMessage(assistant(mixed ? [
        { type: 'text', text: `Before tool ${k}. ${'Synthetic prose. '.repeat(30)}` },
        { type: 'toolCall', id: `mixed-${k}`, name: 'read', arguments: { path: 'synthetic.txt' } },
        { type: 'text', text: `After tool ${k}. ${'Synthetic prose. '.repeat(30)}` },
      ] : [{ type: 'text', text: `PI_SCROLL_${k}\n\n${'Synthetic evidence below the reader. '.repeat(8 + k % 5)}` }]));
    }
    return 'PI_SCROLL_' + piCount;
  }
  async function step(name, action, fn) {
    const row = { name, observations: [] };
    receipt.rows.push(row);
    try {
      await j.step(name, action, async () => {
        try { await fn(row); return row; }
        catch (error) { error.detail = row; throw error; }
      });
      row.status = 'passed';
    } catch (error) { row.status = 'failed'; row.error = error.message; failures.push(name + ': ' + error.message); }
    finally { if (activeRead) row.final = await activeRead(); save(); }
  }
  const verify = (mode, before, observations) => {
    if (mode === 'tail') assert.ok(observations.every(o => o.gap <= 2), 'tail stopped following');
    else assert.ok(observations.every(o => o.anchorOffset !== null && Math.abs(o.anchorOffset - before.offset) <= 2), 'stationary reading anchor moved or was evicted');
  };
  try {
    const nodeDir = join(run, 'node');
    mkdirSync(nodeDir);
    node = new CrashChild(nodeDir, 'reading-place', 'node', new URL('./reading-place-node.mjs', import.meta.url));
    children.push(node);
    const ready = (await node.wait('ready', undefined, 20000)).value;
    piFile = join(run, 'pi-seed.jsonl');
    writeFileSync(piFile, JSON.stringify({ type: 'session', version: 3, id: 'sess-a', timestamp: new Date().toISOString(), cwd: '/work' }) + '\n');
    piAppend(180);
    writeFileSync(join(run, 'hub-config.json'), JSON.stringify({ nodes: [ready.home], pi: true, piclose: true, piSeed: piFile }));
    hub = new CrashChild(run, 'reading-place', 'hub', pathToFileURL(join(target, 'apps/ampi/test/durable-l3/round2-hub.ts')));
    children.push(hub);
    const hr = (await hub.wait('ready', undefined, 20000)).value;
    const port = hr.port, origin = 'http://127.0.0.1:' + port, cookie = 'ampi_k_' + port;
    assert.ok(port < 7879 || port > 7895, 'protected port');
    const piState = JSON.parse(readFileSync(join(hr.fixtures[0], 'state.json'), 'utf8'));
    piFile = piState.agents[0].agent_session.value;
    const auth = { cookie: cookie + '=' + 'e'.repeat(64) };
    let health;
    await until(async () => {
      health = await fetch(origin + '/api/health', { headers: auth, signal: AbortSignal.timeout(5000) }).then(response => response.json());
      return ['durable', 'pi'].every(carrier => health.hosts.some(host => host.link === 'devbox#' + carrier && host.status === 'connected'));
    }, 'both fixture carriers');
    allowPattern = origin + '/**';
    await context.route(allowPattern, route => route.continue());
    await context.addCookies([{ name: cookie, value: 'e'.repeat(64), url: origin }]);
    receipt.doctor = { port, hosts: health.hosts.map(h => ({ link: h.link, status: h.status })), web: webDistCurrent(target), submodules: submodulesPinned(target) };
    for (const carrier of ['pi', 'durable']) {
      const host = 'devbox#' + carrier, threadId = carrier === 'pi' ? 'pi:sess-a' : ready.threadId;
      const snapshot = () => topicSnapshot({ port, host, auth, topic: { kind: 'thread', threadId }, timeoutMs: 20000 });
      await snapshot();
      await p.goto(origin + '/' + href.thread(host, threadId));
      await scroll().waitFor();
      await until(async () => (await measure()).painted >= 120, 'initial paint');
      await frames();
      let latestSource = await snapshot();
      const read = async () => {
        latestSource = await snapshot();
        return measure(latestSource.entries.map(e => e.id));
      };
      activeRead = read;
      const admitted = async predicate => {
        await until(async () => { latestSource = await snapshot(); return predicate(latestSource); }, 'source admission');
        await frames();
      };
      const observe = async (row, phase) => {
        await frames();
        const source = await snapshot();
        latestSource = source;
        const after = { phase, ...await measure(source.entries.map(e => e.id)), anchorOffset: await position(row.before),
          sourceFirst: source.entries[0]?.id, sourceLast: source.entries.at(-1)?.id, hiddenBefore: source.hiddenBefore,
          working: await p.locator('.new-below').innerText(), dividers: await p.locator('.omitted').count() };
        row.observations.push(after);
        return after;
      };
      const append = async (n, mixed = false) => {
        let id;
        if (carrier === 'pi') { piAppend(n, mixed); id = piLast; }
        else id = (await ipc(node, 'append', { n, mixed })).ids.at(-1);
        await admitted(source => source.entries.some(e => e.id === id));
      };
      const arrival = async (kind, callId) => {
        let id;
        if (carrier === 'durable') id = (await ipc(node, 'arrival', { kind, callId })).id;
        else if (kind === 'notice' || kind === 'team') id = piMessage('Synthetic notice ' + (++seq), kind === 'team' ? 'pi-team-bright.notice' : 'notice');
        else if (kind === 'result') id = piMessage({ role: 'toolResult', toolCallId: callId, toolName: 'read', content: [{ type: 'text', text: 'Result prose. '.repeat(100) }], isError: false, timestamp: Date.now() });
        else id = piMessage({ ...assistant([{ type: 'toolCall', id: callId, name: 'read', arguments: { path: 'synthetic.txt' } }]), stopReason: 'toolUse' });
        await admitted(source => source.entries.some(e => e.id === id));
      };
      for (const mode of ['tail', 'above']) {
        await lens(false);
        await step(carrier + '-arrivals-' + mode, 'Fixture precondition: stream a simulated reply, tool call/result, and notice while the reader holds ' + mode, async row => {
          await move(mode); row.before = await read();
          if (carrier === 'pi') {
            row.streamCoverage = 'Committed assistant chunks; Pi partial-token streaming is not exposed by this source.';
            for (const k of [1, 3, 8]) {
              const text = 'PI_CHUNK_' + (++seq) + ' ' + 'Streaming synthetic assistant prose. '.repeat(k * 12);
              const id = piMessage(assistant([{ type: 'text', text }]));
              await admitted(source => source.entries.some(e => e.id === id));
              await observe(row, 'assistant-chunk-' + k);
            }
          } else {
            await ipc(node, 'submit');
            const stop = p.getByRole('button', { name: /■ Stop/ });
            await stop.waitFor();
            await until(async () => { await observe(row, 'assistant-stream'); return await stop.count() === 0; }, 'simulated stream completion', 30000);
            assert.ok(row.observations.filter(o => o.phase === 'assistant-stream').length >= 3, 'stream was not sampled');
          }
          const callId = 'call-' + (++seq);
          for (const kind of ['call', 'result', 'notice']) { await arrival(kind, callId); await observe(row, kind); }
          verify(mode, row.before, row.observations);
        });
        await lens(true);
        await step(carrier + '-fold-' + mode, 'Fixture precondition: grow a collapsed tool/Team fold while the reader holds ' + mode, async row => {
          await arrival('call', 'fold-' + (++seq));
          await move(mode); row.before = await read();
          for (const kind of ['call', 'call', 'team', 'call', 'call', 'team', 'call']) {
            await arrival(kind, 'fold-' + (++seq));
            await observe(row, kind);
            row.observations.at(-1).fold = await p.locator('.rb-tools > summary').last().evaluate(el => ({ height: el.getBoundingClientRect().height, open: el.parentElement.open }));
          }
          assert.ok(row.observations.every(o => o.fold.height === row.observations[0].fold.height && !o.fold.open), 'collapsed fold changed height');
          verify(mode, row.before, row.observations);
        });
      }
      await lens(false);
      for (const mode of ['above', 'tail']) await step(carrier + '-single-' + mode, 'Fixture precondition: append three single entries while the reader holds ' + mode, async row => {
        await move(mode); row.before = await read();
        for (let i = 0; i < 3; i++) { await append(1); await observe(row, 'single-' + i); }
        verify(mode, row.before, row.observations);
      });
      await step(carrier + '-stationary-3x120', 'Fixture precondition: move to scrollTop 300, record the settled place, then append three batches of 120 without input through source-window eviction', async row => {
        await move('stationary'); row.before = await read();
        const source = await snapshot();
        row.sourceBefore = { count: source.entries.length, first: source.entries[0]?.id, hiddenBefore: source.hiddenBefore };
        for (let i = 0; i < 3; i++) { await append(120); await observe(row, 'batch-' + i); }
        assert.ok(row.observations.at(-1).hiddenBefore > row.sourceBefore.hiddenBefore, 'fixture did not evict the source window');
        verify('above', row.before, row.observations);
        assert.ok(row.observations.every((o, i) => o.painted - row.before.painted <= 120 * (i + 1)), 'paint count grew beyond arrivals');
      });
      const busy = async value => {
        if (carrier === 'pi') {
          const file = join(hr.fixtures[0], 'state.json');
          const state = JSON.parse(readFileSync(file, 'utf8'));
          state.agents[0].agent_status = value ? 'working' : 'idle';
          writeFileSync(file, JSON.stringify(state));
          if (value) await arrival('call', 'running-' + (++seq));
        } else await ipc(node, value ? 'busy' : 'idle');
        await admitted(source => Boolean(source.live?.run) === value);
      };
      const status = () => p.locator('.new-below');
      const goEnd = async () => { await move('tail'); await until(async () => (await read()).gap <= 2, 'G newest end'); };
      const prepareMixed = async () => {
        await goEnd(); await append(180, true); await goEnd(); await lens(true);
        await p.locator('.msg.assistant').filter({ hasText: 'After tool' }).last().waitFor();
      };
      await step(carrier + '-split-running-idle-10s', 'Fixture precondition: split prose/tool/prose entries and a running tool fold; hold conversation-only for ten seconds with no source arrivals', async row => {
        await prepareMixed(); await busy(true); await goEnd(); await move('above');
        await p.locator('.rb-tools').last().getByText('running', { exact: false }).waitFor({ state: 'attached' });
        row.before = await read();
        const sourceVersion = latestSource.sourceVersion, sourceLast = latestSource.entries.at(-1)?.id;
        // The duration is the acceptance input, not a readiness sleep. Sample each animation frame for transient drift.
        row.hold = await scroll().evaluate(async el => {
          const top = el.scrollTop, height = el.scrollHeight, start = performance.now();
          let samples = 0, maxDrift = 0, minHeight = height, maxHeight = height;
          while (performance.now() - start < 10000) {
            await new Promise(requestAnimationFrame); samples++;
            maxDrift = Math.max(maxDrift, Math.abs(el.scrollTop - top));
            minHeight = Math.min(minHeight, el.scrollHeight); maxHeight = Math.max(maxHeight, el.scrollHeight);
          }
          return { durationMs: performance.now() - start, samples, maxDrift, minHeight, maxHeight };
        });
        await observe(row, 'held-ten-seconds');
        row.sourceUnchanged = latestSource.sourceVersion === sourceVersion && latestSource.entries.at(-1)?.id === sourceLast;
        row.runningFold = await p.locator('.rb-tools').last().innerText();
        assert.ok(row.sourceUnchanged, 'source changed during the no-arrival hold');
        assert.match(row.runningFold, /running/);
        assert.ok(row.hold.maxDrift <= 2, 'running fold drifted without arrivals');
        verify('above', row.before, row.observations);
      });
      await step(carrier + '-working-clears-idle', 'Let the fixture run become idle while the reader stays away; working clears', async row => {
        row.before = await read();
        row.wasWorking = await status().innerText();
        await busy(false); await observe(row, 'idle');
        await until(async () => !(await status().innerText()).includes('working'), 'working clears on idle');
        assert.match(row.wasWorking, /working/);
        verify('above', row.before, row.observations);
      });
      await step(carrier + '-working-clears-G', 'Start another fixture run while away; press G to follow the newest end and clear working', async row => {
        await goEnd(); await busy(true); await move('above'); row.before = await read();
        await until(async () => (await status().innerText()).includes('working'), 'working while away');
        row.wasWorking = await status().innerText();
        await goEnd(); await observe(row, 'G');
        assert.equal((await status().innerText()).trim(), '', 'G clears away status');
        assert.equal(row.observations.at(-1).retained, 0, 'G releases retained rows');
        await busy(false);
      });
      let frozenBefore, extensionBefore;
      await step(carrier + '-split-frozen-8x120', 'Fixture precondition: split entries, then 960 arrivals in overlapping source windows while the reader holds still; paint and retained rows plateau', async row => {
        await busy(false); await prepareMixed(); await move('stationary');
        row.before = frozenBefore = await read();
        for (let i = 0; i < 8; i++) { await append(120, true); await observe(row, 'batch-' + i); }
        verify('above', row.before, row.observations);
        assert.ok(row.observations.every(o => o.painted <= row.before.painted), 'away window painted arrivals');
        const last = row.observations.at(-1);
        assert.equal(last.retained, last.uniquePainted, 'source did not move past every frozen row');
        assert.ok(last.retained <= row.before.uniquePainted, 'retained rows did not plateau');
      });
      await step(carrier + '-split-downward-extension', 'Scroll near the frozen bottom at an after-tool fragment; one downward extension admits served entries behind an omission divider', async row => {
        const fragments = p.locator('.msg.assistant').filter({ hasText: 'After tool' });
        const fragment = fragments.nth(await fragments.count() - 3);
        row.before = extensionBefore = await fragment.evaluate(node => {
          const el = document.querySelector('[data-region="transcript"]');
          el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - 20;
          const peers = [...el.querySelectorAll('[data-entry]')].filter(n => n.dataset.entry === node.dataset.entry);
          return { entry: node.dataset.entry, fragment: peers.indexOf(node), offset: node.getBoundingClientRect().top - el.getBoundingClientRect().top,
            gap: el.scrollHeight - el.scrollTop - el.clientHeight, text: node.textContent.slice(0, 90) };
        });
        assert.ok(row.before.gap > 0 && row.before.gap < 600, 'extension starts near the frozen bottom without a clamp');
        await frames();
        await observe(row, 'extended');
        verify('above', row.before, row.observations);
        row.dividerText = await p.locator('.omitted').allTextContents();
        assert.equal(row.dividerText.length, 1, 'one divider must name the unpainted gap');
        assert.match(row.dividerText[0], /never shown here/);
        const extended = row.observations.at(-1);
        const servedPainted = extended.uniquePainted - extended.retained;
        assert.ok(servedPainted > 0, 'reader scroll did not paint served entries');
        assert.ok(servedPainted <= 120, 'one extension admitted more than one window');
      });
      await step(carrier + '-split-resize-divider-restore', 'Resize the viewport with the after-tool fragment visible; restore that fragment without losing the omission divider', async row => {
        const fragment = p.locator('.msg.assistant[data-entry="' + extensionBefore.entry + '"]').filter({ hasText: 'After tool' });
        await fragment.evaluate(node => {
          const el = document.querySelector('[data-region="transcript"]');
          el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - 20;
        });
        await frames();
        row.before = { ...extensionBefore, offset: await position(extensionBefore) };
        row.beforeCounts = await read();
        assert.ok(row.before.offset !== null && row.before.offset >= -2 && row.before.offset < row.beforeCounts.client, 'resize needs a visible after-tool fragment');
        row.dividersBefore = await p.locator('.omitted').count();
        await p.setViewportSize({ width: 1100, height: 740 }); await frames();
        await observe(row, 'narrow');
        await p.setViewportSize({ width: 1280, height: 800 }); await frames();
        await observe(row, 'restored');
        verify('above', row.before, row.observations);
        assert.equal(row.dividersBefore, 1, 'fixture needs the omission divider');
        assert.ok(row.observations.every(o => o.dividers === 1), 'fragment restoration removed the omission divider');
      });
      await step(carrier + '-split-G-releases-retained', 'Press G to leave the frozen window, follow the newest end, and release retained rows', async row => {
        row.before = await read(); await goEnd(); await observe(row, 'G');
        verify('tail', row.before, row.observations);
        assert.equal(row.observations.at(-1).retained, 0, 'G retained evicted source rows');
        assert.equal(await p.locator('.omitted').count(), 0, 'G retained the omission divider');
        assert.equal((await status().innerText()).trim(), '', 'G retained the unread count');
      });
    }
  } finally {
    for (const child of [hub, node]) if (child?.child.connected) {
      child.child.send({ command: 'finish' });
      await child.result().catch(() => child.cleanup());
    }
    for (const child of children) { child.cleanup(); await child.exited; }
    receipt.cleanup = children.map(child => ({ exit: child.child.exitCode, signal: child.child.signalCode }));
    for (const [name, dir] of [['node', join(run, 'node')], ['hub', run]]) {
      try { writeFileSync(join(proof, name + '.log'), readFileSync(join(dir, name + '.log'))); } catch {}
    }
    rmSync(run, { recursive: true, force: true });
    receipt.runRemoved = true;
    if (allowPattern) await context.unroute(allowPattern);
    save();
  }
  assert.deepEqual(failures, [], failures.join('; '));
}
