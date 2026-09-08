'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { NotificationStore, BatchScheduler, validateSource, validateEvent, formatBatch } = require('../ui/lib/broker-core');
const { NativeNotifier } = require('../ui/lib/broker');

const source = { id: 'remote-1', label: 'GPU 容器', host: 'gpu-01', home: '/home/user', cwd: '/work/project' };
function event(id, type = 'done') {
  return { version: 1, id, type, timestamp: 1788757200, host: 'gpu-01', label: '实验', cwd: '/work/project', session_id: 'session-1', turn_id: 'turn-1', originator: 'codex_vscode' };
}
function directory() {
  const storage = path.join(__dirname, '.broker-test-data', crypto.randomUUID());
  fs.mkdirSync(storage, { recursive: true });
  return storage;
}

test('store deduplicates cross-client event identity and persists only approved metadata', () => {
  const storage = directory();
  const store = new NotificationStore(storage);
  assert.equal(store.add({ ...source, token: 'SECRET' }, { ...event('same'), prompt: 'PRIVATE PROMPT', command: 'PRIVATE COMMAND' }, {}).duplicate, false);
  assert.equal(store.add(source, event('same'), {}).duplicate, true);
  assert.equal(store.history().entries.length, 1);
  assert.equal(store.history().unread, 1);
  assert.ok(store.history().entries[0].receivedAt > 1000000000000);
  const state = fs.readFileSync(path.join(storage, 'broker-state.json'), 'utf8');
  assert.ok(!state.includes('PRIVATE'));
  assert.ok(!state.includes('SECRET'));
  const restarted = new NotificationStore(storage);
  assert.equal(restarted.add(source, event('same'), {}).duplicate, true);
  assert.deepEqual(restarted.history(), store.history());
  restarted.markRead({ key: 'remote-1:same' });
  assert.equal(new NotificationStore(storage).history().unread, 0);
  restarted.clear();
  const cleared = new NotificationStore(storage);
  assert.equal(cleared.history().entries.length, 0);
  assert.equal(cleared.add(source, event('same'), {}).duplicate, true);
});

test('history and dedup state remain bounded, with new source identity independent', () => {
  const store = new NotificationStore(directory());
  for (let index = 0; index < 205; index++) store.add(source, event(`event-${index}`), { sound: false, desktop: false });
  assert.equal(store.history().entries.length, 200);
  assert.equal(store.history().entries[0].event.id, 'event-204');
  store.seen = new Set(Array.from({ length: 5000 }, (_, index) => `old:${index}`));
  store.add(source, event('last'), {});
  assert.equal(store.seen.size, 5000);
  assert.equal(store.seen.has('old:0'), false);
  assert.equal(store.add({ ...source, id: 'remote-2' }, event('last'), {}).duplicate, false);
});

test('single deletion accepts read and unread entries, preserves other entries and survives replay after restart', () => {
  const storage = directory();
  const store = new NotificationStore(storage);
  const unread = store.add(source, event('delete-unread'), {});
  const read = store.add(source, event('delete-read'), {});
  store.add(source, event('keep-unread'), {});
  store.markRead({key: read.key});
  const removed = [];
  store.on('removed', keys => removed.push(keys));
  assert.deepEqual(store.deleteEntry({key: unread.key}), {deleted: 1, unread: 1});
  assert.deepEqual(store.deleteEntry({key: read.key}), {deleted: 1, unread: 1});
  assert.deepEqual(store.deleteEntry({key: 'remote-1:missing'}), {deleted: 0, unread: 1});
  assert.deepEqual(removed, [[unread.key], [read.key]]);
  const restarted = new NotificationStore(storage);
  assert.deepEqual(restarted.entries.map(item => item.event.id), ['keep-unread']);
  for (const id of ['delete-unread', 'delete-read']) assert.equal(restarted.add(source, event(id), {}).duplicate, true);
  assert.equal(restarted.history().unread, 1);
});

test('clearRead removes only read entries, preserves dedup tombstones, and clear still removes all history', () => {
  const storage = directory();
  const store = new NotificationStore(storage);
  const read = store.add(source, event('read'), {});
  const unread = store.add(source, event('unread'), {});
  store.markRead({key: read.key});
  assert.deepEqual(store.clearRead(), {deleted: 1, unread: 1});
  assert.deepEqual(store.clearRead(), {deleted: 0, unread: 1});
  assert.deepEqual(store.history().entries.map(item => item.key), [unread.key]);
  assert.equal(new NotificationStore(storage).add(source, event('read'), {}).duplicate, true);
  assert.deepEqual(store.clear(), {unread: 0});
  const restarted = new NotificationStore(storage);
  assert.equal(restarted.entries.length, 0);
  assert.equal(restarted.add(source, event('unread'), {}).duplicate, true);
});

test('invalid delete requests and failed persistence cannot partially remove history or emit cancellation', () => {
  const store = new NotificationStore(directory());
  const a = store.add(source, event('a'), {});
  const b = store.add(source, event('b'), {});
  store.markRead({key: b.key});
  for (const request of [undefined, null, [], {}, {key: ''}, {key: 1}, {key: '\n'}, {key: 'x'.repeat(514)}]) {
    assert.throws(() => store.deleteEntry(request));
  }
  const before = store.history();
  const seen = [...store.seen];
  let removals = 0;
  store.on('removed', () => {removals++;});
  store.save = () => {throw new Error('simulated disk failure');};
  assert.throws(() => store.deleteEntry({key: a.key}), /disk failure/);
  assert.throws(() => store.clearRead(), /disk failure/);
  assert.throws(() => store.clear(), /disk failure/);
  assert.deepEqual(store.history(), before);
  assert.deepEqual([...store.seen], seen);
  assert.equal(removals, 0);
});

test('native cancellation removes only deleted CLICK keys without starting a helper', () => {
  const native = new NativeNotifier();
  native.clicks.set('only-deleted', ['deleted']);
  native.clicks.set('mixed', ['deleted', 'unread']);
  native.clicks.set('other', ['other']);
  native.cancel(['deleted']);
  assert.equal(native.child, null);
  assert.equal(native.clicks.has('only-deleted'), false);
  assert.deepEqual(native.clicks.get('mixed'), ['unread']);
  assert.deepEqual(native.clicks.get('other'), ['other']);
  native.close();
});

test('origin metadata is bounded and old persisted events without origin remain readable', () => {
  assert.equal(validateEvent(event('new')).originator, 'codex_vscode');
  assert.throws(() => validateEvent({...event('bad'), originator: 'x'.repeat(65)}));
  const storage = directory();
  const oldEvent = event('old');
  delete oldEvent.originator;
  fs.writeFileSync(path.join(storage, 'broker-state.json'), JSON.stringify({version: 1,
    entries: [{key: source.id + ':old', receivedAt: Date.now(), read: false, source, event: oldEvent}], seen: [source.id + ':old']}));
  const store = new NotificationStore(storage);
  assert.equal(store.entries.length, 1);
  assert.equal(store.entries[0].event.originator, '');
  assert.deepEqual(store.deleteEntry({key: source.id + ':old'}), {deleted: 1, unread: 0});
});

test('invalid metadata and event schema reject before saving', () => {
  const store = new NotificationStore(directory());
  for (const bad of [null, [], { id: '' }, { ...source, label: 42 }, { ...source, id: 'bad\n' }, { ...source, home: 'x'.repeat(2049) }]) {
    assert.throws(() => validateSource(bad));
  }
  for (const bad of [null, [], { ...event('a'), version: 2 }, { ...event('a'), type: 'completed' }, { ...event('a'), timestamp: NaN }, { ...event('a'), id: 'x'.repeat(257) }]) {
    assert.throws(() => validateEvent(bad));
  }
  assert.throws(() => store.add(source, event('a'), { sound: 'yes' }));
  assert.throws(() => store.markRead({ keys: 'all' }));
  assert.equal(store.history().entries.length, 0);
});

function fakeClock() {
  let clock = 0;
  let counter = 0;
  const timers = new Map();
  return {
    now: () => clock,
    setTimeout(fn, delay) { const id = ++counter; timers.set(id, { fn, due: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const target = clock + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, item]) => item.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        clock = next[1].due;
        timers.delete(next[0]);
        next[1].fn();
        await Promise.resolve();
        await Promise.resolve();
      }
      clock = target;
    },
  };
}
function record(id, type = 'done') { return { key: `${source.id}:${id}`, receivedAt: Date.now(), source, event: event(id, type), read: false }; }

test('0.7-second batching, four-second separation, priority and sound-only mode', async () => {
  const clock = fakeClock();
  const deliveries = [];
  const scheduler = new BatchScheduler(async batch => deliveries.push({ at: clock.now(), batch }), clock);
  scheduler.add(record('done'), { desktop: true, sound: false });
  await clock.advance(699);
  assert.equal(deliveries.length, 0);
  scheduler.add(record('question', 'question'), { desktop: true, sound: false });
  scheduler.add(record('approval', 'approval'), { desktop: true, sound: false });
  await clock.advance(1);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].batch.body.split('\n')[0], /等待审批/);
  assert.equal(deliveries[0].batch.sound, false);
  scheduler.add(record('sound'), { desktop: false, sound: true });
  scheduler.add(record('silent'), { desktop: false, sound: false });
  await clock.advance(3999);
  assert.equal(deliveries.length, 1);
  await clock.advance(1);
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[1].at, 4700);
  assert.equal(deliveries[1].batch.desktop, false);
  assert.equal(deliveries[1].batch.sound, true);
  scheduler.close();
});

test('batch lists at most four entries plus remainder and retains every event key', () => {
  const batch = formatBatch(Array.from({ length: 7 }, (_, index) => ({ record: record(String(index), index === 6 ? 'approval' : 'done'), options: { desktop: true, sound: false } })));
  assert.equal(batch.body.split('\n').length, 5);
  assert.match(batch.body.split('\n')[0], /等待审批/);
  assert.match(batch.body, /另有 3 条/);
  assert.equal(batch.keys.length, 7);
});

test('sound-only events never leak into another windows desktop batch', () => {
  const hidden = record('sound-only', 'approval');
  hidden.source = { ...hidden.source, label: 'HIDDEN_SOURCE' };
  const batch = formatBatch([
    { record: hidden, options: { desktop: false, sound: true } },
    { record: record('visible'), options: { desktop: true, sound: false } },
  ]);
  assert.equal(batch.sound, true);
  assert.equal(batch.desktop, true);
  assert.match(batch.title, /^Codex 本轮已回复/);
  assert.deepEqual(batch.keys, [record('visible').key]);
  assert.ok(!batch.body.includes('HIDDEN_SOURCE'));
});

test('bounded queue and delivery failures report to caller without breaking scheduling', async () => {
  const clock = fakeClock();
  let deliveries = 0;
  const failures = [];
  const scheduler = new BatchScheduler(async () => { deliveries++; throw new Error('helper failure'); }, { ...clock, queueLimit: 2 });
  scheduler.on('deliveryError', (entries, error) => failures.push({ entries, error }));
  scheduler.add(record('1'), { desktop: true, sound: false });
  scheduler.add(record('2'), { desktop: true, sound: false });
  scheduler.add(record('3'), { desktop: true, sound: false });
  assert.match(failures[0].error, /queue limit/);
  await clock.advance(700);
  assert.equal(deliveries, 1);
  assert.match(failures[1].error, /helper failure/);
  scheduler.add(record('4'), { desktop: true, sound: false });
  await clock.advance(4000);
  assert.equal(deliveries, 2);
  scheduler.close();
});

test('corrupted persistence does not silently erase saved history', () => {
  const storage = directory();
  fs.writeFileSync(path.join(storage, 'broker-state.json'), '{broken');
  assert.throws(() => new NotificationStore(storage), /Cannot load notification history/);
  assert.equal(fs.readFileSync(path.join(storage, 'broker-state.json'), 'utf8'), '{broken');
});

test('native delivery retries three times after failure and exposes final failure', { skip: process.platform !== 'win32' }, async () => {
  const successful = new NativeNotifier();
  let attempts = 0;
  successful.once = async () => { attempts++; if (attempts <= 3) throw new Error('temporary helper failure'); };
  await successful.deliver({ title: 'test', body: 'test', sound: false, desktop: true });
  assert.equal(attempts, 4);
  successful.close();
  const failing = new NativeNotifier();
  let failedAttempts = 0;
  failing.once = async () => { failedAttempts++; throw new Error('permanent helper failure'); };
  await assert.rejects(failing.deliver({ title: 'test', body: 'test', sound: false, desktop: true }), /permanent helper failure/);
  assert.equal(failedAttempts, 4);
  failing.close();
});
