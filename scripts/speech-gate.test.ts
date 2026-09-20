import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechGate } from '../server/src/speech-gate.js';
import { stripStage } from '../shared/spoken-text.js';
import { ClientSession } from '../server/src/session.js';

test('stage text stays hidden across incomplete and nested brackets', () => {
  assert.equal(stripStage('（指尖轻轻蹭过（照片）边角）慢点，台阶有点滑。'), '慢点，台阶有点滑。');
  assert.equal(stripStage('慢点。（跟着你'), '慢点。');
  assert.equal(stripStage('【低头】你好。'), '你好。');
});

test('native PCM streams before any transcript or completion event', () => {
  const gate = new SpeechGate();
  const start = { type: 'response.output_audio.started', response_id: 'r' };
  assert.deepEqual(gate.accept(start).events, [start]);
  const pcm = { type: 'response.output_audio.delta', delta: 'cGNt' };
  assert.deepEqual(gate.accept(pcm).events, [{ ...pcm, response_id: 'r' }]);
});

test('split narration is removed from subtitles without holding audio', () => {
  const gate = new SpeechGate();
  const send = (type: string, extra = {}) => gate.accept({ type, response_id: 'r', ...extra });
  assert.deepEqual(send('response.output_text.delta', { delta: '（跟着你' }).events, []);
  assert.deepEqual(send('response.output_text.delta', { delta: '走）慢点。' }).events, [
    { type: 'response.output_text.delta', response_id: 'r', delta: '慢点。' },
  ]);
  assert.equal(send('response.output_audio.started').events.length, 1);
  assert.equal(send('response.output_audio.delta', { delta: 'filtered-upstream' }).events.length, 1);
  assert.equal(send('response.output_text.done', { text: '（跟着你走）慢点。' }).events[0].text, '慢点。');
});

test('completion and clear isolate subtitle state across responses', () => {
  const gate = new SpeechGate();
  gate.accept({ type: 'response.output_text.delta', response_id: 'r', delta: '（低头' });
  gate.accept({ type: 'response.done', response_id: 'r' });
  assert.equal(
    gate.accept({ type: 'response.output_text.delta', response_id: 'next', delta: '你好。' }).events[0].delta,
    '你好。',
  );
  gate.clear();
  assert.equal(
    gate.accept({ type: 'response.output_text.delta', response_id: 'next', delta: '你好。' }).events[0].delta,
    '你好。',
  );
});

test('session forwards first PCM immediately and drops late PCM after interruption', async () => {
  const session = new ClientSession('speech-stream-test', { decide: null, photoJudge: null });
  const s = session as any;
  const sent: unknown[] = [];
  s.ws = { readyState: 1, bufferedAmount: 0, send: (value: unknown) => sent.push(value) };
  s.duplex = { cancelResponse: () => {}, clearInject: () => {}, close: async () => {} };
  try {
    s.onDuplexEvent({ type: 'response.output_audio.started', response_id: 'r' });
    s.onDuplexEvent({ type: 'response.output_audio.delta', delta: 'cGNt' });
    assert.equal(sent.filter(Buffer.isBuffer).length, 1, 'first PCM must not wait for text/audio done');
    session.handleInterrupt('client');
    s.onDuplexEvent({ type: 'response.output_audio.delta', delta: 'bGF0ZQ==' });
    s.onDuplexEvent({ type: 'response.output_text.done', response_id: 'r', text: '迟到的回复。' });
    s.onDuplexEvent({ type: 'response.output_audio.done', response_id: 'r' });
    assert.equal(sent.filter(Buffer.isBuffer).length, 1);
    assert.ok(!sent.some((value) => typeof value === 'string' && value.includes('迟到')));
  } finally {
    await session.destroy();
  }
});

test('fully filtered reply settles even if provider never sends audio.done', () => {
  const gate = new SpeechGate();
  gate.accept({ type: 'response.output_text.delta', response_id: 'r', delta: '（挥手）' });
  const result = gate.accept({ type: 'response.output_text.done', response_id: 'r', text: '（挥手）' });
  assert.ok(result.events.some((e) => e.type === 'response.output_audio.done' && e.stage_filtered_empty));
  assert.deepEqual(gate.accept({ type: 'response.output_audio.started', response_id: 'r' }).events, []);
  assert.deepEqual(gate.accept({ type: 'response.output_audio.delta', delta: 'cGNt' }).events, []);
  assert.equal(gate.accept({ type: 'response.output_audio.started', response_id: 'next' }).events.length, 1);
});

test('session returns to listening for a fully filtered response with a late started event', async () => {
  const session = new ClientSession('speech-empty-test', { decide: null, photoJudge: null });
  const s = session as any;
  const sent: unknown[] = [];
  s.ws = { readyState: 1, bufferedAmount: 0, send: (value: unknown) => sent.push(value) };
  s.duplex = { close: async () => {} };
  s.preparePhotoForReply = async () => {};
  s.director.prepareContinuation = async () => {};
  try {
    s.onDuplexEvent({ type: 'response.output_text.done', response_id: 'empty', text: '（挥手）' });
    s.onDuplexEvent({ type: 'response.output_audio.started', response_id: 'empty' });
    assert.equal(s.speaking, false);
    const messages = sent.filter((v): v is string => typeof v === 'string').map((v) => JSON.parse(v));
    assert.ok(messages.some((m) => m.type === 'state' && m.phase === 'listening'));
    assert.ok(!messages.some((m) => m.type === 'audio.begin'));
  } finally {
    await session.destroy();
  }
});
