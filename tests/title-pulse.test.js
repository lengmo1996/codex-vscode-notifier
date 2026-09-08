'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {TitlePulse} = require('../ui/lib/title-pulse');
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(write) {
  let next = 0;
  const jobs = new Map(), frames = [];
  const pulse = new TitlePulse(async value => { frames.push(value); return write ? write(value) : {applied: true}; }, {
    schedule(fn, interval) { assert.equal(interval, 800); jobs.set(++next, fn); return next; },
    cancel(id) { jobs.delete(id); }
  });
  return {pulse, jobs, frames, async tick() {
    assert.equal(jobs.size, 1, 'one timer per window');
    const [id, fn] = [...jobs][0]; jobs.delete(id); fn(); await flush();
  }};
}
test('unread title alternates its dot while status text and count remain visible', async () => {
  const h = harness();
  await h.pulse.update('🟡 已完成 2', true);
  await h.tick(); await h.tick();
  assert.deepEqual(h.frames, ['🟡 已完成 2', '⚪ 已完成 2', '🟡 已完成 2']);
  await h.pulse.update('🔴 待处理 1', true); await h.tick();
  assert.equal(h.frames.at(-1), '⚪ 待处理 1');
  h.pulse.dispose(); assert.equal(h.jobs.size, 0);
});
test('routine refresh cannot reset animation or multiply its timer; disabling keeps a static title', async () => {
  const h = harness();
  await h.pulse.update('🟡 已完成 1', true); await h.tick();
  for (let i = 0; i < 5; i++) await h.pulse.update('🟡 已完成 1', true);
  assert.equal(h.frames.length, 2); assert.equal(h.jobs.size, 1);
  await h.pulse.update('🟡 已完成 1', false);
  assert.equal(h.frames.at(-1), '🟡 已完成 1'); assert.equal(h.jobs.size, 0);
});
test('read clears immediately and an in-flight older frame cannot restart animation', async () => {
  let release;
  const h = harness(value => value ? new Promise(resolve => {release = resolve;}) : {applied: true});
  const old = h.pulse.update('🟡 已完成 1', true); await flush();
  await h.pulse.update('', false); release({applied: true}); await old;
  assert.deepEqual(h.frames, ['🟡 已完成 1', '']); assert.equal(h.jobs.size, 0);
});
test('disposing during a pending title write does not restart the timer', async () => {
  let release;
  const h = harness(() => new Promise(resolve => {release = resolve;}));
  const old = h.pulse.update('🟡 已完成 1', true); await flush();
  h.pulse.dispose(); release({applied: true}); await old;
  assert.equal(h.jobs.size, 0);
  await h.pulse.update('🟡 已完成 9', true); assert.equal(h.frames.length, 1);
});
test('a failed title write can retry the same pending state without a leaked timer', async () => {
  let fail = true;
  const h = harness(() => { if (fail) throw new Error('title unavailable'); return {applied: true}; });
  await assert.rejects(h.pulse.update('🟡 已完成 1', true), /unavailable/);
  assert.equal(h.jobs.size, 0); fail = false;
  await h.pulse.update('🟡 已完成 1', true); assert.equal(h.jobs.size, 1); h.pulse.dispose();
});
