'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const {loadIdentity, tlsOptions, checkPeer} = require('../ui/lib/ipc-security');
const {BROKER_PROTOCOL_VERSION} = require('../ui/lib/broker-core');
const {BrokerClient} = require('../ui/lib/client');
const {startBroker} = require('../ui/lib/broker');

const brokerScript = path.resolve(__dirname, '../ui/lib/broker.js');
const source = { id: 'pipe-remote', label: '中文测试', host: 'host', home: '/home/user', cwd: '/work/project' };
function event(id) { return { version: 1, id, type: 'done', timestamp: Date.now() / 1000, host: 'host', label: '测试', cwd: '/work/project', session_id: 's', turn_id: 't', originator: 'codex_vscode' }; }
function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function launch(storage, pipe) {
  const child = spawn(process.execPath, [brokerScript, '--storage', storage, '--pipe', pipe, '--no-native'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CODEX_NOTIFIER_TEST_MODE: '1' },
  });
  child.output = '';
  child.errors = '';
  child.stdout.on('data', data => { child.output += data; });
  child.stderr.on('data', data => { child.errors += data; });
  return child;
}

async function ready(child) {
  const deadline = Date.now() + 12000;
  while (!child.output.includes('READY')) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Broker failed to start: ${child.errors}`);
    await pause(25);
  }
}

async function connect(pipe, identity, clientId) {
  const socket = tls.connect({...tlsOptions(identity), socket: net.createConnection(pipe), checkServerIdentity: checkPeer(identity)});
  socket.on('error', () => {});
  try { await once(socket, 'secureConnect'); } catch (error) { socket.destroy(); throw error; }
  let buffer = '';
  const pending = new Map();
  const broadcasts = [];
  socket.on('close', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Connection closed')); } pending.clear(); });
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    let boundary;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 1);
      if (message.type) broadcasts.push(message);
      else {
        const item = pending.get(message.requestId);
        if (item) { clearTimeout(item.timer); pending.delete(message.requestId); item.resolve(message); }
      }
    }
  });
  function request(body) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Request timeout')); }, 3000);
      pending.set(requestId, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ requestId, ...body })}\n`);
    });
  }
  const response = await request({ op: 'hello', version: BROKER_PROTOCOL_VERSION, clientId });
  return { socket, request, broadcasts, response };
}

test('real local pipe: auth, cross-client dedup, restart, bounded input, idle shutdown', { timeout: 45000 }, async t => {
  const id = crypto.randomUUID();
  const storage = path.resolve(__dirname, '.broker-test-data', id);
  fs.mkdirSync(storage, { recursive: true });
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\codex-notifier-test-${id}` : path.join(storage, 'broker.sock');
  const processes = [];
  const sockets = [];
  t.after(() => { for (const socket of sockets) socket.destroy(); for (const child of processes) if (child.exitCode === null) child.kill(); });
  const child = launch(storage, pipe);
  processes.push(child);
  await ready(child);
  const identity = loadIdentity(storage);
  assert.equal(fs.existsSync(path.join(storage, 'broker-token')), false);
  const otherIdentity = loadIdentity(path.resolve(__dirname, '.broker-test-data', crypto.randomUUID()));
  await assert.rejects(connect(pipe, {...otherIdentity, ca: identity.ca}, 'bad'));
  const first = await connect(pipe, identity, 'one');
  const second = await connect(pipe, identity, 'two');
  sockets.push(first.socket, second.socket);
  assert.equal(first.response.ok, true);
  assert.equal(second.response.ok, true);
  const added = await first.request({ op: 'event', source, event: event('same-event'), options: { desktop: false, sound: false } });
  const duplicate = await second.request({ op: 'event', source, event: event('same-event'), options: { desktop: false, sound: false } });
  assert.equal(added.result.duplicate, false);
  assert.equal(duplicate.result.duplicate, true);
  const history = await second.request({ op: 'history' });
  assert.equal(history.result.entries.length, 1);
  assert.equal(history.result.unread, 1);
  assert.ok(first.broadcasts.some(message => message.type === 'historyChanged'));
  assert.ok(second.broadcasts.some(message => message.type === 'historyChanged'));
  const invalid = await first.request({ op: 'event', source, event: { ...event('bad'), type: 'private' } });
  assert.equal(invalid.ok, false);
  assert.equal((await first.request({ op: 'ping' })).ok, true);
  const otherProcess = launch(storage, pipe);
  processes.push(otherProcess);
  const [otherExit] = await once(otherProcess, 'exit');
  assert.equal(otherExit, 0, otherProcess.errors);
  assert.equal((await first.request({ op: 'ping' })).result.pid, child.pid);
  const large = await connect(pipe, identity, 'oversize');
  sockets.push(large.socket);
  const closed = once(large.socket, 'close');
  large.socket.write('x'.repeat(65537));
  await closed;
  await first.request({ op: 'markRead', key: added.result.key });
  first.socket.destroy();
  second.socket.destroy();
  const firstExit = once(child, 'exit');
  child.kill();
  await firstExit;
  const restarted = launch(storage, pipe);
  processes.push(restarted);
  await ready(restarted);
  const third = await connect(pipe, identity, 'three');
  sockets.push(third.socket);
  const restored = await third.request({ op: 'history' });
  assert.equal(restored.result.entries.length, 1);
  assert.equal(restored.result.unread, 0);
  assert.equal((await third.request({ op: 'event', source, event: event('same-event') })).result.duplicate, true);
  const tested = await third.request({ op: 'test', source, options: { desktop: true, sound: true } });
  assert.equal(tested.ok, true);
  await pause(800);
  assert.ok(!third.broadcasts.some(message => message.type === 'deliveryError'));
  assert.equal((await third.request({ op: 'history' })).result.entries[0].event.type, 'test');
  const exited = once(restarted, 'exit');
  const disconnected = Date.now();
  third.socket.destroy();
  const [exitCode] = await exited;
  assert.equal(exitCode, 0, restarted.errors);
  assert.ok(Date.now() - disconnected >= 9500, 'last client idle lifetime should be ten seconds');
  assert.ok(Date.now() - disconnected < 13000);
});

function snapshotRecord(id, receivedAt) {
  return {key: source.id + ':' + id, source, event: {...event(id), timestamp: receivedAt / 1000}, receivedAt, read: false};
}
function snapshot(records) {
  return JSON.stringify({version: 1, entries: records, seen: records.map(record => record.key),
    seenAt: Object.fromEntries(records.map(record => [record.key, record.receivedAt]))});
}

test('a broker that loses listener ownership cannot prune or rewrite another broker cache', {timeout: 15000}, async t => {
  const storage = path.resolve(__dirname, '.broker-test-data', crypto.randomUUID());
  loadIdentity(storage);
  const now = Date.now();
  const currentFile = path.join(storage, `broker-state-v${BROKER_PROTOCOL_VERSION}.json`);
  const legacyFile = path.join(storage, 'broker-state-v4.json');
  const original = snapshot([snapshotRecord('expired-current', now - 9 * 86400000)]);
  fs.writeFileSync(currentFile, original);
  fs.writeFileSync(legacyFile, 'expired-legacy-keep-until-owner-starts');
  fs.utimesSync(legacyFile, new Date(now - 9 * 86400000), new Date(now - 9 * 86400000));
  const client = new BrokerClient(storage, brokerScript);
  const occupied = net.createServer(socket => socket.destroy());
  occupied.listen(client.pipe); await once(occupied, 'listening');
  const contender = startBroker({storage, pipe: client.pipe, noNative: true, now: () => now});
  t.after(() => {client.dispose(); contender.close(); occupied.close();});
  assert.equal(fs.readFileSync(currentFile, 'utf8'), original, 'construction cannot rewrite an expired snapshot');
  assert.equal(contender.store.entries.length, 0, 'store stays uninitialized until listener ownership');
  const [error] = await once(contender.server, 'error');
  assert.equal(error.code, 'EADDRINUSE');
  assert.equal(fs.readFileSync(currentFile, 'utf8'), original);
  assert.equal(fs.readFileSync(legacyFile, 'utf8'), 'expired-legacy-keep-until-owner-starts');
});

test('a winning broker reloads the latest snapshot and retention controls before its first expiry pass', {timeout: 15000}, async t => {
  const storage = path.resolve(__dirname, '.broker-test-data', crypto.randomUUID());
  loadIdentity(storage);
  const now = Date.now();
  const currentFile = path.join(storage, `broker-state-v${BROKER_PROTOCOL_VERSION}.json`);
  fs.writeFileSync(currentFile, snapshot([snapshotRecord('superseded-before-listening', now)]));
  const client = new BrokerClient(storage, brokerScript);
  const winner = startBroker({storage, pipe: client.pipe, noNative: true, now: () => now});
  t.after(() => {client.dispose(); winner.close();});
  const newest = snapshotRecord('written-before-ownership', now);
  fs.writeFileSync(currentFile, snapshot([snapshotRecord('expires-under-new-policy', now - 3 * 86400000), newest]));
  fs.writeFileSync(path.join(storage, 'broker-privacy.json'), JSON.stringify({version: 1, retentionDays: 1, paused: false, cutoff: 0}));
  const legacyFile = path.join(storage, 'broker-state-v4.json');
  fs.writeFileSync(legacyFile, 'old-legacy');
  fs.utimesSync(legacyFile, new Date(now - 3 * 86400000), new Date(now - 3 * 86400000));
  await once(winner.server, 'listening');
  assert.deepEqual(winner.store.entries.map(record => record.key), [newest.key]);
  assert.equal(winner.store.control.retentionDays, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(currentFile, 'utf8')).entries.map(record => record.key), [newest.key]);
  assert.equal(fs.existsSync(legacyFile), false, 'the listener owner performs normal expiry');
  assert.equal((await client.request('history')).entries[0].key, newest.key);
});
