'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {BrokerClient} = require('../ui/lib/client');

const brokerScript = path.resolve(__dirname, '../ui/lib/broker.js');
const silent = {desktop: false, sound: false};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function event(id, cwd) {
  return {
    version: 1, type: 'done', id, timestamp: Date.now() / 1000, originator: 'codex_vscode',
    host: 'same-server', label: '同一服务器', cwd,
    session_id: crypto.randomUUID(), turn_id: crypto.randomUUID(),
  };
}

function windowRecord(client, label, cwd, focused = false) {
  return {
    id: client.clientId, label, sourceId: 'same-server-user',
    workspaceUri: '', workspaceCwd: cwd, workspaceCwds: [cwd],
    focused, routeUri: '',
  };
}

async function waitUntil(predicate, description) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(10);
  }
}

test('real shared pipe routes task opens only to the correct registered VS Code client', {timeout: 18000}, async t => {
  const storage = path.resolve(__dirname, '.broker-test-data', 'routing-' + crypto.randomUUID());
  await fs.mkdir(storage, {recursive: true});
  const options = {env: {CODEX_NOTIFIER_TEST_MODE: '1'}};
  const a = new BrokerClient(storage, brokerScript, options);
  const b = new BrokerClient(storage, brokerScript, options);
  const receivedA = [];
  const receivedB = [];
  a.on('openEntry', message => receivedA.push(message));
  b.on('openEntry', message => receivedB.push(message));
  // Each fixture has a unique storage directory. Dispose both clients and let
  // their isolated broker exit normally; never remove a user's directory.
  t.after(() => {a.dispose(); b.dispose();});
  await a.connect();
  await b.connect();
  assert.equal((await a.request('ping')).pid, (await b.request('ping')).pid);

  const source = {
    id: 'same-server-user', label: '共享服务器', host: 'same-server',
    home: '/home/researcher/.codex', cwd: '/work/training',
  };
  const outerWindow = windowRecord(a, '外层项目窗口', '/work/training');
  const innerWindow = windowRecord(b, '内层项目窗口', '/work/training/thermal');
  await a.request('window', {window: outerWindow});
  await b.request('window', {window: innerWindow});

  // The first reporting client is deliberately the wrong project window.
  // Shared CODEX_HOME observers must not decide ownership by arrival order.
  const outerEvent = event('outer-project', '/work/training/experiments');
  const innerEvent = event('inner-project', '/work/training/thermal/runs');
  const outer = await b.request('event', {source, event: outerEvent, options: silent});
  const inner = await a.request('event', {source, event: innerEvent, options: silent});
  assert.equal(outer.accepted, true);
  assert.equal(inner.accepted, true);
  const duplicate = await b.request('event', {source, event: innerEvent, options: silent});
  assert.equal(duplicate.duplicate, true);
  const initialHistory = await a.request('history');
  assert.equal(initialHistory.entries.length, 2);
  const outerEntry = initialHistory.entries.find(entry => entry.event.id === 'outer-project');
  const innerEntry = initialHistory.entries.find(entry => entry.event.id === 'inner-project');
  assert.equal(outerEntry.targetWindowId, a.clientId);
  assert.equal(outerEntry.targetWindowLabel, outerWindow.label);
  assert.equal(innerEntry.targetWindowId, b.clientId, 'longest matching workspace directory owns the nested task');
  assert.equal(innerEntry.targetWindowLabel, innerWindow.label);

  async function assertOpen(requester, key, target, other) {
    const targetCount = target.length;
    const otherCount = other.length;
    const receipt = await requester.request('openEntry', {key});
    assert.equal(receipt.routed, true);
    await waitUntil(() => target.length === targetCount + 1, 'the targeted openEntry message');
    // Ping replies are ordered after any previously written broker messages on
    // each pipe. This also detects an incorrect cross-window broadcast.
    await Promise.all([a.request('ping'), b.request('ping')]);
    assert.equal(other.length, otherCount, 'an unrelated window must not receive openEntry');
    assert.equal(target.at(-1).key, key);
    assert.equal(target.at(-1).entry.key, key);
    assert.ok(target.at(-1).entry.event.session_id, 'the target gets the UUID needed to open its own conversation editor');
  }

  await assertOpen(b, outerEntry.key, receivedA, receivedB);
  await assertOpen(a, innerEntry.key, receivedB, receivedA);

  // Multiple windows can show the same remote workspace. The latest focus
  // transition should then choose the target for subsequent task events.
  const sharedCwd = '/work/shared';
  await a.request('window', {window: windowRecord(a, '共享项目 A', sharedCwd, false)});
  await b.request('window', {window: windowRecord(b, '共享项目 B', sharedCwd, false)});
  await a.request('window', {window: windowRecord(a, '共享项目 A', sharedCwd, true)});
  await b.request('event', {source, event: event('focus-a', sharedCwd), options: silent});
  let focusEntry = (await b.request('history')).entries.find(entry => entry.event.id === 'focus-a');
  assert.equal(focusEntry.targetWindowId, a.clientId);
  await assertOpen(b, focusEntry.key, receivedA, receivedB);

  await delay(15);
  await a.request('window', {window: windowRecord(a, '共享项目 A', sharedCwd, false)});
  await b.request('window', {window: windowRecord(b, '共享项目 B', sharedCwd, true)});
  await a.request('event', {source, event: event('focus-b', sharedCwd), options: silent});
  focusEntry = (await a.request('history')).entries.find(entry => entry.event.id === 'focus-b');
  assert.equal(focusEntry.targetWindowId, b.clientId);
  await assertOpen(a, focusEntry.key, receivedB, receivedA);
  assert.equal((await a.request('history')).entries.length, 4);
});
