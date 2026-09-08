'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {BrokerClient} = require('../ui/lib/client');

test('UI client sends events through a shared broker and reconnects without duplicates', {timeout: 30000}, async () => {
  const storage = path.join(__dirname, 'runtime', 'client-' + crypto.randomUUID());
  await fs.mkdir(storage, {recursive: true});
  const script = path.join(__dirname, '../ui/lib/broker.js');
  const a = new BrokerClient(storage, script, {env: {CODEX_NOTIFIER_TEST_MODE: '1'}});
  const b = new BrokerClient(storage, script, {env: {CODEX_NOTIFIER_TEST_MODE: '1'}});
  const source = {id: 'same-remote-user', label: 'host/container', host: 'host', home: '/home/u/.codex', cwd: '/project'};
  const event = {version: 1, type: 'approval', id: 'same-approval', timestamp: Date.now() / 1000, cwd: '/project', session_id: 's', originator: 'codex_vscode'};
  try {
    await Promise.all([a.connect(), b.connect()]);
    const receipts = await Promise.all([
      a.request('event', {source, event, options: {desktop: false, sound: false}}),
      b.request('event', {source, event, options: {desktop: false, sound: false}})
    ]);
    assert.ok(receipts.every(r => r.accepted));
    assert.equal(receipts.filter(r => r.duplicate).length, 1);
    const state = await a.request('history');
    assert.equal(state.entries.length, 1);
    assert.equal(state.unread, 1);
    await b.request('markRead');
    assert.equal((await a.request('history')).unread, 0);
  } finally { a.dispose(); b.dispose(); }
});
