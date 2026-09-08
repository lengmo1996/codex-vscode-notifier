'use strict';
const {t} = require('./i18n');

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const RECEIVE_COMMAND = 'codexNotifier.internal.receive';
const MAX_LINE_BYTES = 16 * 1024;
const OWNER = 'codex-vscode-notifier-v1';
const TYPES = new Set(['done', 'approval', 'question', 'test', 'heartbeat']);

function clean(value, limit) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, limit);
}

function normalizeEvent(value) {
  if (!value || typeof value !== 'object' || value.version !== 1 || !TYPES.has(value.type) ||
      typeof value.id !== 'string' || !value.id || !Number.isFinite(value.timestamp)) return null;
  const record = {version: 1, type: value.type, id: clean(value.id, 128), timestamp: value.timestamp};
  for (const [key, limit] of Object.entries({host: 128, label: 200, cwd: 512, session_id: 128, turn_id: 128})) {
    record[key] = clean(value[key], limit);
  }
  if (typeof value.originator === 'string' && value.originator === clean(value.originator, 128)) {
    record.originator = value.originator;
  }
  if (value.type === 'heartbeat' && typeof value.privacyPaused === 'boolean') record.privacyPaused = value.privacyPaused;
  return record;
}

/** Byte-bound framing drops oversized lines, even when they span multiple chunks. */
class JsonLines {
  constructor(onRecord, maxBytes = MAX_LINE_BYTES) {
    this.onRecord = onRecord;
    this.maxBytes = maxBytes;
    this.pending = Buffer.alloc(0);
    this.discard = false;
  }
  push(input) {
    const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(10, start);
      const end = newline < 0 ? data.length : newline;
      const piece = data.subarray(start, end);
      if (!this.discard) {
        if (this.pending.length + piece.length > this.maxBytes) {
          this.pending = Buffer.alloc(0);
          this.discard = true;
        } else {
          this.pending = Buffer.concat([this.pending, piece]);
        }
      }
      if (newline < 0) break;
      if (!this.discard && this.pending.length) {
        try {
          const decoder = new StringDecoder('utf8');
          const value = normalizeEvent(JSON.parse(decoder.end(this.pending)));
          if (value) this.onRecord(value);
        } catch { /* Unknown log schemas and damaged lines are ignored. */ }
      }
      this.pending = Buffer.alloc(0);
      this.discard = false;
      start = end + 1;
    }
  }
}

function settingKey(key, prefix = '') {
  return prefix ? prefix + key[0].toUpperCase() + key.slice(1) : key;
}

function settings(configuration, environment = {}, keyPrefix = '') {
  const platform = environment.platform || process.platform;
  const home = environment.home || os.homedir();
  const vars = environment.env || process.env;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const get = (key, fallback) => configuration.get(settingKey(key, keyPrefix), fallback);
  let codexHome = get('codexHome', '') || vars.CODEX_HOME || paths.join(home, '.codex');
  if (codexHome === '~') codexHome = home;
  else if (/^~[\\/]/.test(codexHome)) codexHome = paths.join(home, codexHome.slice(2));
  // A relative user setting is resolved against the OS home, never workspace content.
  codexHome = paths.resolve(home, codexHome);
  const customPython = get('pythonPath', '').trim();
  const retention = get('cacheRetentionDays', 7);
  return {
    codexHome,
    python: customPython || (platform === 'win32' ? 'py' : 'python3'),
    pythonArgs: !customPython && platform === 'win32' ? ['-3'] : [],
    label: clean(get('sourceLabel', ''), 200),
    enabled: get('collectorEnabled', true) !== false,
    retentionDays: Number.isInteger(retention) && retention >= 1 && retention <= 30 ? retention : 7,
  };
}

function makeSource(config, {hostname = os.hostname(), remoteName = '', cwd = ''} = {}) {
  const id = crypto.createHash('sha256').update(hostname + '\0' + config.codexHome).digest('hex').slice(0, 32);
  const fallback = remoteName ? `${remoteName}/${hostname}` : hostname;
  return {id, label: config.label || clean(fallback, 200), host: clean(hostname, 128), home: config.codexHome, cwd};
}

function hookIsConfigured(document) {
  return Array.isArray(document?.hooks?.PermissionRequest) && document.hooks.PermissionRequest.some(entry =>
    Array.isArray(entry?.hooks) && entry.hooks.some(hook => hook?.type === 'command' &&
      typeof hook.command === 'string' && /(?:^|\s)--owner\s+["']?codex-vscode-notifier-v1["']?(?:\s|$)/.test(hook.command)));
}

function restartDelay(failureCount) {
  return Math.min(60000, 1000 * 2 ** Math.min(Math.max(failureCount - 1, 0), 6));
}

/** Acknowledged command bridge. The local broker owns durable duplicate suppression. */
class EventBridge {
  constructor(executeCommand, log, onConnection = () => {}) {
    this.executeCommand = executeCommand;
    this.log = log;
    this.onConnection = onConnection;
    this.queue = [];
    this.latestStatus = null;
    this.busy = false;
    this.disposed = false;
    this.connected = false;
    this.reportedUnavailable = false;
  }
  event(source, event) {
    if (event.type === 'heartbeat') return;
    if (this.queue.some(item => item.event.id === event.id && item.source.id === source.id)) return;
    if (this.queue.length >= 500) {
      this.queue.shift();
      this.log(t('Notification queue reached 500 entries; oldest pending event was dropped.'));
    }
    this.queue.push({version: 1, kind: 'event', source, event});
    void this.flush();
  }
  status(source, status) {
    this.latestStatus = {version: 1, kind: 'status', source, status};
    void this.flush();
  }
  async deliver(message) {
    const result = await this.executeCommand(RECEIVE_COMMAND, message);
    if (result?.accepted !== true) throw new Error(t('Local component did not acknowledge the event.'));
  }
  async flush() {
    if (this.busy || this.disposed) return;
    this.busy = true;
    try {
      if (this.latestStatus) {
        const message = this.latestStatus;
        await this.deliver(message);
        if (this.latestStatus === message) this.latestStatus = null;
      }
      while (this.queue.length && !this.disposed) {
        const message = this.queue[0];
        await this.deliver(message);
        // The bounded queue may have evicted this item while delivery awaited.
        const index = this.queue.indexOf(message);
        if (index >= 0) this.queue.splice(index, 1);
      }
      if (!this.connected) this.onConnection(true);
      this.connected = true;
      this.reportedUnavailable = false;
    } catch {
      if (this.connected) this.onConnection(false);
      this.connected = false;
      if (!this.reportedUnavailable) {
        this.log(t('Waiting for the local Codex Notifier component; retrying every 2 seconds.'));
        this.reportedUnavailable = true;
      }
    } finally {
      this.busy = false;
    }
  }
  dispose() { this.disposed = true; }
}

module.exports = {OWNER, RECEIVE_COMMAND, MAX_LINE_BYTES, clean, normalizeEvent, JsonLines,
  settings, settingKey, makeSource, hookIsConfigured, restartDelay, EventBridge};
