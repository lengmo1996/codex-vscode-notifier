'use strict';
const {t} = require('./i18n');

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { NotificationStore, BatchScheduler, validateSource, validateEvent, formatBatch, BROKER_PROTOCOL_VERSION } = require('./broker-core');
const { WindowRegistry } = require('./routing');
const { notificationOptions } = require('./presentation');
const {loadIdentity} = require('./ipc-security');
const {createSecureServer} = require('./secure-pipe');

const MAX_PACKET = 64 * 1024;
const MAX_WRITE_QUEUE = 4 * 1024 * 1024;

class NativeNotifier extends EventEmitter {
  constructor({ disabled = false } = {}) {
    super();
    this.disabled = disabled;
    this.child = null;
    this.pending = null;
    this.closed = false;
    this.clicks = new Map();
  }

  start() {
    if (this.closed) throw new Error('Notification helper is closed');
    if (this.child) return;
    const script = path.resolve(__dirname, '../assets/show-notification.ps1');
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > MAX_PACKET) { this.fail(child, new Error('Invalid notification helper output')); return; }
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        if (line.startsWith('CLICK ')) {
          const id = line.slice(6);
          const keys = this.clicks.get(id);
          this.clicks.delete(id);
          if (keys) this.emit('click', {id, keys});
        }
        if (!this.pending || this.pending.child !== child) continue;
        if (line === `SHOWN ${this.pending.id}`) this.finishPending(null);
        else if (line.startsWith(`ERROR ${this.pending.id} `)) this.finishPending(new Error(line.slice(`ERROR ${this.pending.id} `.length)));
      }
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', error => this.fail(child, error));
    child.on('error', error => this.fail(child, error));
    child.on('exit', () => this.fail(child, new Error('Windows notification helper exited')));
  }

  finishPending(error) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve();
  }

  fail(child, error) {
    if (this.child !== child) return;
    this.child = null;
    if (this.pending?.child === child) this.finishPending(error);
    try { child.kill(); } catch { /* The child may already have exited. */ }
  }

  once(batch) {
    this.start();
    const child = this.child;
    const id = crypto.randomUUID();
    if (batch.desktop) {
      this.clicks.set(id, batch.keys || []);
      while (this.clicks.size > 64) this.clicks.delete(this.clicks.keys().next().value);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(child, new Error('Windows notification helper did not acknowledge delivery')), 12000);
      this.pending = { id, child, resolve, reject, timer };
      child.stdin.write(`${JSON.stringify({ id, title: batch.title, body: batch.body, sound: batch.sound, desktop: batch.desktop, appName: batch.title.startsWith('Codex ') ? batch.title : 'Codex' })}\n`, 'utf8', error => {
        if (error) this.fail(child, error);
      });
    });
  }

  async deliver(batch, latest = () => batch) {
    if (this.disabled) return;
    if (process.platform !== 'win32') throw new Error('Native notifications require Windows; use the VS Code notification fallback');
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.closed) throw new Error('Notification helper is closed');
      const current = latest();
      if (!current) return;
      try { await this.once(current); return; }
      catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    throw lastError;
  }

  cancel(keys) {
    const removed = new Set(keys);
    for (const [id, batchKeys] of this.clicks) {
      const remaining = batchKeys.filter(key => !removed.has(key));
      if (remaining.length) this.clicks.set(id, remaining);
      else this.clicks.delete(id);
    }
    // Already displayed system balloons expire normally. Their deleted
    // entries can no longer be opened, and retries re-check the live store.
  }

  cancelAll() {
    this.clicks.clear();
    if (this.child) this.fail(this.child, new Error(t('通知缓存已重置')));
    else this.finishPending(new Error(t('通知缓存已重置')));
  }

  close() {
    this.closed = true;
    this.clicks.clear();
    this.finishPending(new Error('Notification helper is shutting down'));
    if (this.child) {
      const child = this.child;
      this.child = null;
      try { child.kill(); } catch { /* The helper has already stopped. */ }
    }
  }
}

function startBroker({ storage, pipe, noNative = false, idleMs = 10000, nativeNotifier, attentionNotifier, batchOptions = {}, now = Date.now }) {
  if (!path.isAbsolute(storage)) throw new Error('--storage must be an absolute path');
  if (typeof pipe !== 'string' || !pipe || (process.platform === 'win32' ? !pipe.startsWith('\\\\.\\pipe\\') : !path.isAbsolute(pipe))) {
    throw new Error('--pipe must be a local named pipe or absolute Unix socket path');
  }
  const identity = loadIdentity(storage);
  const store = new NotificationStore(storage, {fileName: `broker-state-v${BROKER_PROTOCOL_VERSION}.json`, now, initialize: false});
  const native = nativeNotifier || new NativeNotifier({ disabled: noNative || process.env.CODEX_NOTIFIER_TEST_MODE === '1' });
  let attention = attentionNotifier;
  const clients = new Set();
  const windows = new WindowRegistry(now);
  const observedBy = new Map();
  const mutedUntil = new Map();
  // Interaction cancels these events for their entire remaining delivery lifetime.
  // A retry or a long batch delay must not revive them when the window mute expires.
  const silencedKeys = new Set();
  const forcedTests = new Set();
  let idleTimer = null;
  let stopping = false;
  const targetFor = record => windows.select(record, observedBy.get(record.key));
  const annotated = record => {
    const target = targetFor(record);
    return {...record, targetWindowId: target?.id || '', targetWindowLabel: target?.label || '', notificationLanguage: target?.language || 'zh-CN'};
  };
  function effectiveOptions(record, original) {
    const target = targetFor(record);
    if (forcedTests.has(record.key) || !target?.policy) return original;
    return notificationOptions({get: (key, fallback) => target.policy[key] ?? fallback}, target.focused, record.event.type);
  }
  function liveItems(items) {
    return items.flatMap(item => {
      const record = store.entries.find(entry => entry.key === item.record.key);
      if (!record || record.read || silencedKeys.has(record.key)) return [];
      const target = targetFor(record);
      if (!forcedTests.has(record.key) && target && (mutedUntil.get(target.id) || 0) > now()) {
        silencedKeys.add(record.key);
        return [];
      }
      const options = effectiveOptions(record, item.options);
      if (!options.desktop && !options.sound) return [];
      return [{record: annotated(record), options}];
    });
  }
  const scheduler = new BatchScheduler((batch, entries) => {
    // Keep the original per-event options for revalidation before every retry.
    const original = entries.map(record => ({record, options: deliveryOptions.get(record.key) || {sound: false, desktop: false}}));
    return native.deliver(batch, () => {
      const remaining = liveItems(original);
      return remaining.length ? formatBatch(remaining) : null;
    });
  }, {...batchOptions, filterItems: liveItems});
  const deliveryOptions = new Map();
  const server = createSecureServer(identity);
  let expiryTimer = null;

  function send(client, message) {
    if (client.socket.destroyed || !client.socket.writable) return false;
    const line = `${JSON.stringify(message)}\n`;
    if (client.socket.writableLength + Buffer.byteLength(line) > MAX_WRITE_QUEUE) { client.socket.destroy(); return false; }
    try { client.socket.write(line); return true; }
    catch { client.socket.destroy(); return false; }
  }

  function broadcast(message) { for (const client of clients) if (client.authenticated) send(client, message); }
  store.on('removed', keys => {
    const removed = new Set(keys);
    scheduler.cancel(record => removed.has(record.key));
    native.cancel?.(keys);
    for (const key of keys) {
      observedBy.delete(key); deliveryOptions.delete(key); forcedTests.delete(key); silencedKeys.delete(key);
    }
  });
  store.on('changed', () => broadcast({ type: 'historyChanged' }));
  store.on('event', (record, options) => {
    deliveryOptions.set(record.key, options);
    const target = targetFor(record);
    if (!forcedTests.has(record.key) && target && (mutedUntil.get(target.id) || 0) > now()) silencedKeys.add(record.key);
    if (!silencedKeys.has(record.key)) scheduler.add(record, effectiveOptions(record, options));
  });
  scheduler.on('deliveryError', (entries, error) => broadcast({ type: 'deliveryError', entries, error }));
  function silenceKey(key) {
    if (!store.entries.some(record => record.key === key)) return;
    silencedKeys.add(key);
    scheduler.cancel(record => record.key === key);
  }
  function routeEntry(key) {
    const record = store.entries.find(entry => entry.key === key);
    if (!record) return {routed: false, reason: 'missing'};
    silenceKey(key);
    const target = targetFor(record);
    const client = target && [...clients].find(item => item.authenticated && item.id === target.id);
    if (!client) return {routed: false, reason: 'window-unavailable'};
    interact(target.id);
    if (!send(client, {type: 'openEntry', key, entry: annotated(record), routeUri: target.routeUri})) {
      return {routed: false, reason: 'window-unavailable'};
    }
    return {routed: true, clientId: target.id, routeUri: target.routeUri};
  }
  function interact(clientId, key) {
    mutedUntil.set(clientId, now() + 15000);
    for (const record of store.entries) {
      if (!record.read && targetFor(record)?.id === clientId && !forcedTests.has(record.key)) silencedKeys.add(record.key);
    }
    if (key !== undefined) silenceKey(key);
    scheduler.cancel(record => silencedKeys.has(record.key));
  }
  function attentionRequest(op, message) {
    if ((noNative || process.env.CODEX_NOTIFIER_TEST_MODE === '1') && process.env.CODEX_NOTIFIER_ATTENTION_TEST !== '1') {
      return Promise.resolve({disabled: true});
    }
    if (!attention) {
      const {WindowAttentionNative} = require('./window-attention-native');
      attention = new WindowAttentionNative();
    }
    return attention.request(op, message);
  }
  native.on('click', ({keys = []}) => {
    try {
    const priority = {approval: 0, question: 1, done: 2, test: 3};
    const records = keys.map(key => store.entries.find(record => record.key === key)).filter(Boolean)
      .sort((a, b) => priority[a.event.type] - priority[b.event.type]);
    if (!records.length) return;
    const record = records.find(item => targetFor(item)) || records[0];
    const result = routeEntry(record.key);
    if (!result.routed) {
      const client = [...clients].filter(item => item.authenticated).sort((a, b) =>
        Number(windows.windows.get(b.id)?.focused) - Number(windows.windows.get(a.id)?.focused))[0];
      if (client) send(client, {type: 'navigationUnavailable', entry: annotated(record)});
    }
    } catch (error) {
      const client = [...clients].find(item => item.authenticated && windows.windows.get(item.id)?.focused)
        || [...clients].find(item => item.authenticated);
      if (client) send(client, {type: 'actionError', error: t('无法处理通知点击：') + error.message});
    }
  });

  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (!stopping && clients.size === 0) idleTimer = setTimeout(() => close(), idleMs);
  }

  function close() {
    if (stopping) return;
    stopping = true;
    clearTimeout(idleTimer);
    clearInterval(expiryTimer);
    scheduler.close();
    native.close();
    if (attention) attention.close();
    for (const client of clients) client.socket.destroy();
    server.close();
  }

  function dispatch(client, request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Request must be an object');
    if (typeof request.requestId !== 'string' || !request.requestId || request.requestId.length > 128 || /[\u0000-\u001f]/u.test(request.requestId)) throw new Error('Invalid requestId');
    if (!client.authenticated) {
      // The connection reaches this parser only after mutual TLS and exact
      // certificate pinning. The hello binds the window and application version.
      if (request.op !== 'hello' || request.version !== BROKER_PROTOCOL_VERSION) throw new Error('Unsupported authenticated broker protocol');
      if (typeof request.clientId !== 'string' || !request.clientId || request.clientId.length > 256 || /[\u0000-\u001f]/u.test(request.clientId)) throw new Error('Invalid clientId');
      client.authenticated = true;
      client.id = request.clientId;
      clearTimeout(client.helloTimer);
      return { version: BROKER_PROTOCOL_VERSION, pid: process.pid, capabilities: ['notification-language-v1'] };
    }
    switch (request.op) {
      case 'window': case 'registerWindow': case 'updateWindow': {
        const changed = windows.update(client.id, request.window);
        if (changed) broadcast({type: 'historyChanged'});
        return {registered: true, clientId: client.id};
      }
      case 'event': {
        const event = validateEvent(request.event);
        if (event.type !== 'test' && event.originator !== 'codex_vscode') {
          return {accepted: true, ignored: true, reason: 'unsupported-origin'};
        }
        const receipt = store.add(request.source, event, request.options);
        if (receipt.ignored) return receipt;
        if (!observedBy.has(receipt.key)) observedBy.set(receipt.key, new Set());
        observedBy.get(receipt.key).add(client.id);
        if (receipt.duplicate) broadcast({type: 'historyChanged'});
        const retained = new Set(store.entries.map(record => record.key));
        for (const map of [observedBy, deliveryOptions]) for (const key of map.keys()) if (!retained.has(key)) map.delete(key);
        for (const set of [forcedTests, silencedKeys]) for (const key of set) if (!retained.has(key)) set.delete(key);
        return receipt;
      }
      case 'history': { const result = store.history(); return {...result, entries: result.entries.map(annotated)}; }
      case 'privacyStatus': return store.privacyStatus();
      case 'privacyReset': {
        try { return store.resetPrivacy(); }
        finally {
          if (store.control.paused) {
            scheduler.cancel(); native.cancelAll?.();
            observedBy.clear(); deliveryOptions.clear(); forcedTests.clear(); silencedKeys.clear(); mutedUntil.clear();
            broadcast({type: 'privacyReset'});
          }
        }
      }
      case 'resumePrivacy': return store.resumePrivacy();
      case 'retention': return store.setRetentionDays(request.days);
      case 'deleteEntry': return store.deleteEntry(request);
      case 'clearRead': return store.clearRead();
      case 'markRead': {
        const result = store.markRead(request);
        scheduler.cancel(record => !store.entries.some(entry => entry.key === record.key && !entry.read));
        interact(client.id);
        return result;
      }
      case 'interact': interact(client.id, request.key); return {mutedUntil: mutedUntil.get(client.id)};
      case 'openEntry': return routeEntry(request.key);
      case 'attentionBind': return attentionRequest('bind', {id: client.id, marker: request.marker, pid: request.pid, executable: request.executable});
      case 'attentionUpdate': return attentionRequest('update', {id: client.id, count: request.count, needsDecision: request.needsDecision, flash: request.flash});
      case 'clear': { const result = store.clear(); scheduler.cancel(); observedBy.clear(); deliveryOptions.clear(); forcedTests.clear(); silencedKeys.clear(); return result; }
      case 'test': {
        const source = validateSource(request.source);
        const event = { version: 1, id: crypto.randomUUID(), type: 'test', timestamp: now() / 1000,
          host: source.host, label: source.label, cwd: source.cwd, session_id: '', turn_id: '' };
        const key = source.id + ':' + event.id;
        observedBy.set(key, new Set([client.id]));
        forcedTests.add(key);
        const receipt = store.add(source, event, request.options);
        if (receipt.ignored) { observedBy.delete(key); forcedTests.delete(key); }
        return receipt;
      }
      case 'ping': return { version: BROKER_PROTOCOL_VERSION, pid: process.pid, clients: [...clients].filter(item => item.authenticated).length };
      default: throw new Error('Unknown operation');
    }
  }

  server.on('connection', socket => {
    if (stopping || clients.size >= 64) { socket.destroy(); return; }
    clearTimeout(idleTimer);
    const client = { socket, authenticated: false, buffer: Buffer.alloc(0) };
    clients.add(client);
    client.helloTimer = setTimeout(() => socket.destroy(), 10000);
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(client.helloTimer); clients.delete(client);
      if (client.id) { windows.remove(client.id); mutedUntil.delete(client.id); broadcast({type: 'historyChanged'}); }
      if (client.id && attention && !stopping) void attention.request('release', {id: client.id}).catch(() => {});
      scheduleIdle();
    });
    socket.on('data', chunk => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      let boundary;
      while ((boundary = client.buffer.indexOf(10)) >= 0) {
        if (boundary > MAX_PACKET) { socket.destroy(); return; }
        const line = client.buffer.subarray(0, boundary).toString('utf8');
        client.buffer = client.buffer.subarray(boundary + 1);
        let request;
        try {
          request = JSON.parse(line);
          const result = dispatch(client, request);
          if (result && typeof result.then === 'function') {
            const requestId = request.requestId;
            void result.then(value => send(client, {requestId, ok: true, result: value}),
              error => send(client, {requestId, ok: false, error: error.message}));
          } else send(client, { requestId: request.requestId, ok: true, result });
        } catch (error) {
          const requestId = typeof request?.requestId === 'string' ? request.requestId.slice(0, 128) : '';
          send(client, { requestId, ok: false, error: error.message });
          if (!client.authenticated) { socket.end(); return; }
        }
      }
      if (client.buffer.length > MAX_PACKET) socket.destroy();
    });
  });

  server.on('listening', () => {
    if (stopping) return;
    try {
      const legacyFileName = ['broker-state-v4.json', 'broker-state-v3.json', 'broker-state-v2.json', 'broker-state.json']
        .find(file => fs.existsSync(path.join(storage, file)));
      store.reload({legacyFileName});
      if (store.needsMigration) { store.save(); store.needsMigration = false; }
    }
    catch (error) { process.stderr.write(`History migration failed: ${error.message}\n`); close(); return; }
    expiryTimer = setInterval(() => {
      try { store.prune(); }
      catch (error) { broadcast({type: 'actionError', error: error.message}); }
    }, 60000);
    expiryTimer.unref();
    process.stdout.write('READY\n'); scheduleIdle();
  });
  server.on('error', error => {
    if (error.code !== 'EADDRINUSE') { process.stderr.write(`Notification broker: ${error.message}\n`); process.exitCode = 1; }
    close();
  });
  server.listen(pipe);
  return { server, close, store, scheduler, windows, native };
}

function argumentsFrom(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--no-native') options.noNative = true;
    else if (argument === '--storage' || argument === '--pipe') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
      options[argument.slice(2)] = value;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.storage || !options.pipe) throw new Error('Usage: node broker.js --storage <absolute directory> --pipe <local pipe> [--no-native]');
  return options;
}

if (require.main === module) {
  try {
    const broker = startBroker(argumentsFrom(process.argv.slice(2)));
    process.once('SIGTERM', () => broker.close());
    process.once('SIGINT', () => broker.close());
  } catch (error) { process.stderr.write(`Notification broker: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { startBroker, argumentsFrom, NativeNotifier, MAX_PACKET };
