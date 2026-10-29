// A declared phase tool must redirect a mistaken call without cancelling work.
import "../test/home.mjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import { magpieProfile } from '@hypercarrier/pi-sim';
import { wrongTool } from './scenarios.mjs';

for (const profile of ['anthropic', 'magpie']) for (const method of ['native', 'summary']) {
  test(`AC2/AC3 refusal: ${profile}/${method} wrong tool redirects to successful compaction`, async t => {
    const report = await wrongTool({ ...(profile === 'magpie' ? magpieProfile() : {}), method });
    const [refused, accepted] = report.results;
    assert.equal(refused.toolName, report.wrong);
    assert.equal(refused.result.details.status, 'ignored');
    assert.match(refused.result.content[0].text, new RegExp(`Call ${report.right}|call ${report.right}`));
    assert.equal(accepted.toolName, report.right);
    assert.equal(accepted.result.details.status, 'accepted');
    assert.match(report.pendingStatus, method === 'native' ? /handoff pending/ : /planning/);
    if (method !== 'native') assert.match(report.pendingStatus, /Waiting for the agent's compaction plan/);
    assert.equal(report.compactionsAfterRefusal, 0);
    const compactions = report.trace.entries.filter(entry => entry.type === 'compaction');
    assert.equal(compactions.length, 1);
    assert.match(compactions[0].summary, method === 'native' ? /Native state after corrected readiness/ : /Synthetic working state/);
    assert.doesNotMatch(report.finalStatus, /forced|fallback/i);
    const tools = JSON.stringify(report.handoffRequests[0].body.tools);
    for (const request of report.handoffRequests) assert.equal(JSON.stringify(request.body.tools), tools);
    assert.deepEqual(report.handoffCache.violations.filter(item => item.property === 'stable-cache-prefix'), []);
    t.diagnostic(JSON.stringify({ profile, method, pi: report.trace.piVersion,
      refusal: refused.result.content[0].text, pending: true, compactions: compactions.length,
      prefixFailures: 0, ...report.metrics }));
  });
}
