import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../server/src/config.js';
import {
  SessionTrace,
  exportTrace,
  listTraces,
  sanitize,
  traceEvent,
  traceOperation,
} from '../server/src/telemetry.js';

test('session diagnostics preserve concurrent ownership, hierarchy, failures, pending calls and archived history', async () => {
  const old = config.recordingsDir;
  config.recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-trace-'));
  try {
    const a = new SessionTrace(),
      b = new SessionTrace();
    a.bind('owner-a');
    b.bind('owner-b');
    await Promise.all([
      a.run(() =>
        traceOperation('turn', { text: '去公园' }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return traceOperation('provider', { prompt: 'complete prompt' }, async () => {
            traceEvent('world.rejected', { reason: 'not_world_action' });
            return 'raw output';
          });
        }),
      ),
      b.run(() =>
        traceOperation('turn-b', {}, async () => {
          traceEvent('only-b');
        }),
      ),
    ]);
    await assert.rejects(
      a.run(() =>
        traceOperation('failed', {}, async () => {
          throw new Error('provider timeout');
        }),
      ),
    );
    let finish!: () => void;
    const pending = a.run(() =>
      traceOperation(
        'pending',
        {},
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    await a.flush();
    await b.flush();
    const result = await exportTrace('owner-a', a.traceId);
    assert.ok(result);
    const spans = result.resourceSpans[0].scopeSpans[0].spans;
    assert.ok(
      spans.every(
        (s) => /^[a-f0-9]{32}$/.test(s.traceId) && /^[a-f0-9]{16}$/.test(s.spanId) && /^\d+$/.test(s.startTimeUnixNano),
      ),
    );
    const byName = (n: string) => spans.find((s) => s.name === n)!;
    assert.equal(byName('provider').parentSpanId, byName('turn').spanId);
    assert.equal(byName('world.rejected').parentSpanId, byName('provider').spanId);
    assert.equal(byName('failed').status.code, 2);
    assert.match(JSON.stringify(byName('pending')), /inProgress/);
    assert.equal(
      spans.some((s) => s.name === 'only-b'),
      false,
    );
    assert.equal(await exportTrace('owner-b', a.traceId), null);
    assert.equal(await exportTrace('owner-a', '../escape'), null);
    finish();
    await pending;
    await a.flush(true);
    assert.equal((await listTraces('owner-a')).length, 1);
    const archived = await exportTrace('owner-a', a.traceId);
    assert.match(JSON.stringify(archived), /raw output/);
    assert.equal(archived!.resourceSpans[0].scopeSpans[0].spans.find((s) => s.name === 'pending')!.status.code, 1);
  } finally {
    fs.rmSync(config.recordingsDir, { recursive: true, force: true });
    config.recordingsDir = old;
  }
});

test('diagnostics redact credentials and binary payloads while retaining full prompts', () => {
  const result = JSON.stringify(
    sanitize({
      client_token: 'secret-owner',
      authorization: 'secret-auth',
      apiKey: 'secret-key',
      image: 'data:image/png;base64,YWJjZA==',
      url: '/media/a?access=secret-url',
      output: Buffer.from('pixels'),
      prompt: 'x'.repeat(12000),
    }),
  );
  assert.doesNotMatch(result, /secret-|YWJjZA|pixels/);
  assert.match(result, /sha256/);
  assert.ok(result.includes('x'.repeat(12000)));
});
