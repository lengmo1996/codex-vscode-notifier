'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const {EventEmitter} = require('node:events');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const {BrokerClient} = require('../ui/lib/client');
const {BROKER_PROTOCOL_VERSION} = require('../ui/lib/broker-core');
const {loadIdentity} = require('../ui/lib/ipc-security');

class FakeSocket extends EventEmitter {
  constructor() {super(); this.destroyed = false; this.authorized = true;}
  setEncoding() {}
  getPeerCertificate() {return {raw: Buffer.from('fixture')};}
  getProtocol() {return 'TLSv1.3';}
  destroy(error) {
    if (this.destroyed) return;
    this.destroyed = true;
    if (error) this.emit('error', error);
    this.emit('close');
  }
}

function fixture(t) {
  const sockets = [];
  const original = net.createConnection;
  const originalTls = tls.connect;
  net.createConnection = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  tls.connect = options => options.socket;
  const client = new BrokerClient(path.resolve(__dirname, 'unused-unit-storage'), 'unused-broker.js');
  client.identity = {raw: Buffer.from('fixture'), cert: 'fixture'};
  t.after(() => {
    client.dispose();
    for (const socket of sockets) socket.destroy();
    net.createConnection = original;
    tls.connect = originalTls;
  });
  return {client, sockets};
}

test('startup connection failures do not report a previously connected broker as disconnected', async t => {
  const {client, sockets} = fixture(t);
  const disconnected = [];
  client.on('disconnected', () => disconnected.push(true));
  for (let attempt = 0; attempt < 3; attempt++) {
    const pending = client._openSocket();
    const rejected = assert.rejects(pending, /not ready/);
    sockets.at(-1).destroy(new Error('broker not ready'));
    await rejected;
  }
  assert.equal(disconnected.length, 0);
  assert.equal(client.authenticated, false);
  assert.equal(client.socket, null);
});

test('closing an authenticated connection reports one real disconnect', async t => {
  const {client, sockets} = fixture(t);
  let disconnected = 0;
  client.on('disconnected', () => {disconnected++;});
  const pending = client._openSocket();
  sockets[0].emit('secureConnect');
  await pending;
  client.authenticated = true;
  sockets[0].destroy();
  sockets[0].emit('close');
  assert.equal(disconnected, 1);
  assert.equal(client.authenticated, false);
  assert.equal(client.socket, null);
});

test('a stale socket close cannot clear the newer authenticated connection or pending requests', async t => {
  const {client, sockets} = fixture(t);
  let disconnected = 0;
  let rejected = false;
  client.on('disconnected', () => {disconnected++;});
  const first = client._openSocket();
  sockets[0].emit('secureConnect');
  await first;
  const second = client._openSocket();
  sockets[1].emit('secureConnect');
  await second;
  client.authenticated = true;
  client.pending.set('new-socket-request', {timer: null, reject() {rejected = true;}});
  sockets[0].destroy();
  assert.equal(client.socket, sockets[1]);
  assert.equal(client.authenticated, true);
  assert.equal(client.pending.has('new-socket-request'), true);
  assert.equal(rejected, false);
  assert.equal(disconnected, 0);
});

test('a socket that closes before connect rejects its opening promise promptly', async t => {
  const {client, sockets} = fixture(t);
  let state = 'pending';
  const pending = client._openSocket().then(() => {state = 'resolved';}, () => {state = 'rejected';});
  sockets[0].destroy();
  await Promise.resolve();
  assert.equal(state, 'rejected');
  await pending;
});

test('authenticated protocol uses a separate pipe without touching an older running broker', () => {
  const client = new BrokerClient(path.resolve(__dirname, 'unused-unit-storage'), 'unused-broker.js');
  try {
    if (process.platform === 'win32') assert.equal(client.pipe.startsWith(`\\\\.\\pipe\\codex-notifier-secure-v1-p${BROKER_PROTOCOL_VERSION}-`), true);
    else assert.equal(path.basename(client.pipe), `broker-secure-v1-p${BROKER_PROTOCOL_VERSION}.sock`);
  } finally {client.dispose();}
});

test('a mismatched broker handshake fails once without accepting or relaunching the old protocol', async () => {
  const storage = path.resolve(__dirname, 'runtime', 'protocol-' + crypto.randomUUID());
  loadIdentity(storage);
  const client = new BrokerClient(storage, 'must-not-launch-a-broker.js');
  let attempts = 0;
  client._openSocket = async () => {client.socket = new FakeSocket();};
  client._raw = async () => {attempts++; return {version: 3};};
  try {
    await assert.rejects(client.connect(), error => error.code === 'BROKER_PROTOCOL_MISMATCH');
    assert.equal(attempts, 1);
    assert.equal(client.authenticated, false);
    assert.equal(client.socket.destroyed, true);
  } finally {client.dispose();}
});
