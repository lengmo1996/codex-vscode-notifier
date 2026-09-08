'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const {once} = require('node:events');
const {startBroker, NativeNotifier} = require('../ui/lib/broker');
const {NotificationStore} = require('../ui/lib/broker-core');
const {BrokerClient} = require('../ui/lib/client');

const source = {id: 'shared-source', label: 'shared', host: 'host', home: '/codex', cwd: '/project'};
const event = id => ({version: 1, type: 'done', id, timestamp: Date.now() / 1000,
  originator: 'codex_vscode', cwd: '/project', session_id: '11111111-2222-4333-8444-555555555555'});
const silent = {sound: false, desktop: false};
function deferred() {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};}

async function fixture(t, native = new NativeNotifier({disabled: true})) {
  const storage = path.resolve(__dirname, 'runtime', 'deletion-' + crypto.randomUUID());
  const script = path.resolve(__dirname, '../ui/lib/broker.js');
  const a = new BrokerClient(storage, script);
  const b = new BrokerClient(storage, script);
  let timerId = 0;
  const timers = new Map();
  const broker = startBroker({storage, pipe: a.pipe, noNative: true, nativeNotifier: native, batchOptions: {
    batchMs: 0, intervalMs: 0,
    setTimeout(callback) {const id = ++timerId; timers.set(id, callback); return id;},
    clearTimeout(id) {timers.delete(id);},
  }});
  t.after(() => {a.dispose(); b.dispose(); broker.close();});
  await once(broker.server, 'listening');
  await Promise.all([a.connect(), b.connect()]);
  return {a, b, broker, native, storage, timers};
}

test('deletion cancels in-flight retries, queued alerts and CLICK keys while clearRead preserves unread delivery', {timeout: 5000}, async t => {
  const started = deferred();
  const release = deferred();
  const delivered = [];
  const native = new NativeNotifier();
  let calls = 0;
  native.deliver = async (batch, latest) => {
    if (++calls === 1) {started.resolve(); await release.promise;}
    const current = latest();
    if (current) delivered.push(current);
  };
  const f = await fixture(t, native);
  t.after(() => release.resolve());
  await f.a.request('window', {window: {id: f.a.clientId, label: 'project', sourceId: source.id,
    workspaceCwd: '/project', workspaceCwds: ['/project'], focused: false,
    policy: {soundOnDone: true, desktopOnDone: true}}});
  const notify = (id, options = {sound: true, desktop: true}) => f.a.request('event', {source, event: event(id), options});
  const pending = await notify('in-flight');
  const inFlight = f.broker.scheduler.flush();
  await started.promise;
  const queued = await notify('queued');
  const keep = await notify('keep-unread');
  const read = await notify('read', silent);
  // Seed read state without a user interaction mute: clearRead itself must
  // leave another unread notification's delivery policy and queue untouched.
  f.broker.store.markRead({key: read.key});
  native.clicks.set('mixed-balloon', [pending.key, queued.key, keep.key, read.key]);
  assert.deepEqual(await f.b.request('clearRead'), {deleted: 1, unread: 3});
  assert.deepEqual(native.clicks.get('mixed-balloon'), [pending.key, queued.key, keep.key]);
  assert.deepEqual(await f.a.request('deleteEntry', {key: pending.key}), {deleted: 1, unread: 2});
  assert.deepEqual(await f.b.request('deleteEntry', {key: queued.key}), {deleted: 1, unread: 1});
  assert.deepEqual(native.clicks.get('mixed-balloon'), [keep.key]);
  assert.deepEqual(f.broker.scheduler.queue.map(item => item.record.key), [keep.key]);
  release.resolve();
  await inFlight;
  assert.equal(delivered.length, 0, 'A deleted event must disappear from in-flight retry revalidation');
  await f.broker.scheduler.flush();
  assert.deepEqual(delivered.flatMap(batch => batch.keys), [keep.key]);
  assert.deepEqual((await f.b.request('history')).entries.map(item => item.key), [keep.key]);
  await assert.rejects(f.a.request('deleteEntry'), /Invalid key/);
  assert.deepEqual(await f.a.request('deleteEntry', {key: 'shared-source:missing'}), {deleted: 0, unread: 1});
  for (const id of ['in-flight', 'queued', 'read']) assert.equal((await notify(id)).duplicate, true);
  assert.equal(f.broker.scheduler.queue.length, 0, 'Replayed deleted notifications must not re-enter the delivery queue');
  const restored = new NotificationStore(f.storage, {fileName: 'broker-state-v5.json'});
  for (const id of ['in-flight', 'queued', 'read']) assert.equal(restored.add(source, event(id), silent).duplicate, true);
  assert.equal(restored.history().unread, 1);
  assert.deepEqual(await f.b.request('clear'), {unread: 0});
  assert.equal(native.clicks.size, 0);
  assert.deepEqual((await f.a.request('history')).entries, []);
});

test('default done alerts sound and remain unread while approval also displays', {timeout: 15000}, async t => {
  const deliveries = [];
  const native = new NativeNotifier({disabled: true});
  native.deliver = async (batch, latest) => {deliveries.push({batch, current: latest()});};
  const f = await fixture(t, native);
  await f.a.request('window', {window: {id: f.a.clientId, label: 'project', sourceId: source.id,
    workspaceCwd: '/project', workspaceCwds: ['/project'], focused: false, policy: {}}});
  // Stale observer preferences must not override the target window's defaults.
  const done = await f.b.request('event', {source, event: event('quiet-done'), options: {sound: true, desktop: true}});
  assert.equal(done.accepted, true);
  await f.broker.scheduler.flush();
  assert.equal(deliveries.length, 1, 'Default done must invoke sound delivery');
  assert.equal(deliveries[0].current.sound, true);
  assert.equal(deliveries[0].current.desktop, false);
  assert.equal(f.broker.scheduler.queue.length, 0);
  let history = await f.a.request('history');
  assert.equal(history.unread, 1);
  assert.equal(history.entries[0].key, done.key);
  assert.equal(history.entries[0].read, false);
  assert.equal(history.entries[0].targetWindowId, f.a.clientId);

  const approval = await f.b.request('event', {source, event: {...event('audible-approval'), type: 'approval'},
    options: {sound: false, desktop: false}});
  await f.broker.scheduler.flush();
  assert.equal(deliveries.length, 2, 'Approval must invoke native delivery under default target preferences');
  assert.deepEqual(deliveries[1].current.keys, [approval.key]);
  assert.equal(deliveries[1].current.sound, true);
  assert.equal(deliveries[1].current.desktop, true);
  history = await f.a.request('history');
  assert.equal(history.unread, 2);
  assert.equal(history.entries.find(item => item.key === done.key).read, false);
  assert.equal(history.entries.find(item => item.key === approval.key).read, false);
});

test('App and legacy missing-origin events are acknowledged and ignored before storage or delivery', {timeout: 5000}, async t => {
  const f = await fixture(t);
  const app = {...event('app'), originator: 'codex_cli_rs'};
  const legacy = event('legacy');
  delete legacy.originator;
  for (const unsupported of [app, legacy]) {
    assert.deepEqual(await f.a.request('event', {source, event: unsupported}), {
      accepted: true, ignored: true, reason: 'unsupported-origin'});
  }
  assert.equal(f.broker.store.entries.length, 0);
  assert.equal(f.broker.store.seen.size, 0);
  assert.equal(f.broker.scheduler.queue.length, 0);
  assert.equal(f.timers.size, 0);
  const vscode = await f.a.request('event', {source, event: event('vscode'), options: silent});
  assert.equal(vscode.accepted, true);
  assert.equal(vscode.ignored, undefined);
  const manual = await f.a.request('event', {source, event: {...legacy, id: 'test', type: 'test'}, options: silent});
  assert.equal(manual.accepted, true, 'Explicit test events do not require a Codex origin marker');
  assert.deepEqual((await f.b.request('history')).entries.map(item => item.event.id), ['test', 'vscode']);
  await assert.rejects(f.a.request('event', {source, event: {...app, originator: 'x'.repeat(65)}}), /originator/);
});

test('authenticated privacy reset cancels all windows, pauses persistently, and rejects pre-reset replay after resume', {timeout: 15000}, async t => {
  const f = await fixture(t);
  const old = event('privacy-reset-old');
  await f.a.request('event', {source, event: old, options: silent});
  const resetA = once(f.a, 'privacyReset');
  const resetB = once(f.b, 'privacyReset');
  assert.equal((await f.a.request('privacyStatus')).paused, false);
  assert.deepEqual(await f.a.request('retention', {days: 3}), {retentionDays: 3});
  const result = await f.a.request('privacyReset');
  assert.equal(result.cleared, true);
  await Promise.all([resetA, resetB]);
  assert.equal(f.broker.scheduler.queue.length, 0);
  assert.equal((await f.b.request('history')).privacyPaused, true);
  assert.deepEqual((await f.b.request('history')).entries, []);
  assert.equal((await f.b.request('event', {source, event: event('during-pause'), options: silent})).reason, 'privacy-paused');
  const reopened = new NotificationStore(f.storage, {fileName: 'broker-state-v5.json'});
  assert.equal(reopened.history().privacyPaused, true);
  assert.equal(reopened.seen.size, 0);
  await f.b.request('resumePrivacy');
  assert.equal((await f.a.request('event', {source, event: old, options: silent})).reason, 'expired');
  await new Promise(resolve => setTimeout(resolve, 5));
  const fresh = await f.a.request('event', {source, event: event('after-explicit-resume'), options: silent});
  assert.equal(fresh.ignored, undefined);
  assert.equal((await f.b.request('history')).entries.length, 1);
});
