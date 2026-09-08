'use strict';
const {t, translator} = require('./i18n');

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const privacy = require('./privacy-storage');

const TYPES = new Set(['done', 'approval', 'question', 'test']);
const TITLES = { done: 'Codex 本轮已回复', approval: 'Codex 等待审批', question: 'Codex 等待回答', test: 'Codex 通知测试' };
const MAX_HISTORY = 200;
const MAX_SEEN = 5000;
const BROKER_PROTOCOL_VERSION = 5;

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

function field(value, name, limit, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value) || (required && !value.trim())) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function validateSource(source) {
  object(source, 'source');
  return {
    id: field(source.id, 'source.id', 256, true),
    label: field(source.label, 'source.label', 200),
    host: field(source.host, 'source.host', 200),
    home: field(source.home, 'source.home', 2048),
    cwd: field(source.cwd, 'source.cwd', 2048),
  };
}

function validateEvent(event) {
  object(event, 'event');
  if (event.version !== 1) throw new Error('Unsupported event.version');
  if (!TYPES.has(event.type)) throw new Error('Invalid event.type');
  if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp) || event.timestamp < 0 || event.timestamp > 4102444800) {
    throw new Error('Invalid event.timestamp');
  }
  return {
    version: 1,
    id: field(event.id, 'event.id', 256, true),
    type: event.type,
    timestamp: event.timestamp,
    host: field(event.host, 'event.host', 200),
    label: field(event.label, 'event.label', 200),
    cwd: field(event.cwd, 'event.cwd', 2048),
    session_id: field(event.session_id, 'event.session_id', 256),
    turn_id: field(event.turn_id, 'event.turn_id', 256),
    originator: field(event.originator, 'event.originator', 64),
  };
}

function validateOptions(options = {}) {
  object(options, 'options');
  for (const key of ['sound', 'desktop']) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error(`Invalid options.${key}`);
  }
  return { sound: options.sound !== false, desktop: options.desktop !== false };
}

function atomicallyWrite(file, data) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

class NotificationStore extends EventEmitter {
  constructor(storage, {fileName = 'broker-state.json', legacyFileName, now = Date.now, initialize = true} = {}) {
    super();
    if (!path.isAbsolute(storage)) throw new Error('storage must be an absolute path');
    fs.mkdirSync(storage, { recursive: true });
    this.storage = privacy.checkDirectory(storage);
    this.now = now;
    this.control = privacy.readControl(storage);
    if (path.basename(fileName) !== fileName || (legacyFileName && path.basename(legacyFileName) !== legacyFileName)) throw new Error('Invalid state filename');
    this.file = path.join(storage, fileName);
    this.entries = [];
    this.seen = new Set();
    this.seenAt = new Map();
    this.needsMigration = false;
    if (initialize) this.reload({legacyFileName});
  }

  // A broker initializes only after it owns the listener. Re-read both the
  // privacy controls and disk snapshot then, since another broker may have
  // changed them while this process was waiting to reserve the pipe.
  reload({legacyFileName} = {}) {
    if (legacyFileName && path.basename(legacyFileName) !== legacyFileName) throw new Error('Invalid state filename');
    this.control = privacy.readControl(this.storage);
    this.entries = []; this.seen = new Set(); this.seenAt = new Map();
    const legacy = legacyFileName && path.join(this.storage, legacyFileName);
    const migrate = !this.control.cutoff && !this.control.paused && !fs.existsSync(this.file) && legacy && fs.existsSync(legacy);
    if (!this.control.paused) this.load(migrate ? legacy : this.file);
    this.needsMigration = Boolean(migrate);
    this.prune();
  }

  load(inputFile = this.file) {
    try {
      if (privacy.checkedFile(this.storage, path.basename(inputFile)).info.size > 4 * 1024 * 1024) throw new Error('Broker state is too large');
      const state = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.entries) || !Array.isArray(state.seen)) throw new Error('Invalid broker state');
      const entries = state.entries.slice(-MAX_HISTORY).map(record => {
        object(record, 'record');
        const source = validateSource(record.source);
        const event = validateEvent(record.event);
        const key = `${source.id}:${event.id}`;
        if (record.key !== key || typeof record.read !== 'boolean' || !Number.isFinite(record.receivedAt)) throw new Error('Invalid history record');
        return { key, receivedAt: record.receivedAt, source, event, read: record.read };
      });
      const seen = state.seen.slice(-MAX_SEEN).map(key => field(key, 'seen key', 513, true));
      this.entries = entries;
      this.seen = new Set(seen);
      const savedTimes = state.seenAt && typeof state.seenAt === 'object' && !Array.isArray(state.seenAt) ? state.seenAt : {};
      this.seenAt = new Map(seen.map(key => [key, Number.isFinite(savedTimes[key]) && savedTimes[key] >= 0 ? Math.min(savedTimes[key], this.now()) : this.now()]));
      for (const record of entries) this.seen.add(record.key);
      this.trimSeen();
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Keep a damaged file for diagnosis instead of silently overwriting it.
        throw new Error(`Cannot load notification history: ${error.message}`);
      }
    }
  }

  trimSeen() {
    while (this.seen.size > MAX_SEEN) {
      const key = this.seen.values().next().value;
      this.seen.delete(key); this.seenAt.delete(key);
    }
    for (const key of this.seenAt.keys()) if (!this.seen.has(key)) this.seenAt.delete(key);
  }

  save() {
    privacy.checkedFile(this.storage, path.basename(this.file), true);
    atomicallyWrite(this.file, {version: 1, entries: this.entries, seen: [...this.seen],
      seenAt: Object.fromEntries([...this.seen].map(key => [key, this.seenAt.get(key) ?? this.now()]))});
  }

  prune() {
    const cutoff = this.now() - this.control.retentionDays * privacy.DAY;
    const before = this.entries;
    const seen = this.seen;
    const seenAt = this.seenAt;
    this.entries = before.filter(record => record.receivedAt >= cutoff && record.event.timestamp * 1000 > this.control.cutoff);
    this.seen = new Set([...seen].filter(key => (seenAt.get(key) ?? this.now()) >= cutoff));
    this.seenAt = new Map([...seenAt].filter(([key]) => this.seen.has(key)));
    const removed = before.filter(record => !this.entries.includes(record)).map(record => record.key);
    if (removed.length || seen.size !== this.seen.size) {
      try { this.save(); } catch (error) { this.entries = before; this.seen = seen; this.seenAt = seenAt; throw error; }
      if (removed.length) this.emit('removed', removed);
      this.emit('changed');
    }
    const legacy = privacy.cacheFiles(this.storage).filter(item => item.name !== path.basename(this.file) && item.name !== 'broker-token' && item.modifiedAt < cutoff);
    privacy.removeCacheFiles(this.storage, legacy.map(item => item.name));
    return {expired: removed.length};
  }

  setRetentionDays(days) {
    const next = {...this.control, retentionDays: privacy.retentionDays(days)};
    if (next.retentionDays === this.control.retentionDays) return {retentionDays: next.retentionDays};
    privacy.writeControl(this.storage, next); this.control = next;
    this.prune();
    return {retentionDays: next.retentionDays};
  }

  privacyStatus() {
    const files = privacy.cacheFiles(this.storage);
    return {retentionDays: this.control.retentionDays, paused: this.control.paused,
      files, totalBytes: files.reduce((sum, item) => sum + item.bytes, 0),
      retainedControl: t('只保留保留期、暂停状态、清理时间和新通信凭据，不含会话标识')};
  }

  resetPrivacy() {
    const files = privacy.cacheFiles(this.storage);
    // Pause durably before deleting anything; partial I/O failures never resume ingest.
    const next = {...this.control, paused: true, cutoff: this.now()};
    privacy.writeControl(this.storage, next); this.control = next;
    const keys = this.entries.map(record => record.key);
    this.entries = []; this.seen = new Set(); this.seenAt = new Map();
    this.emit('removed', keys); this.emit('changed');
    const deletedCount = privacy.removeCacheFiles(this.storage, files.map(item => item.name));
    return {cleared: true, paused: true, deletedCount};
  }

  resumePrivacy() {
    const next = {...this.control, paused: false};
    privacy.writeControl(this.storage, next); this.control = next;
    return {paused: false};
  }

  add(rawSource, rawEvent, rawOptions) {
    const source = validateSource(rawSource);
    const event = validateEvent(rawEvent);
    const options = validateOptions(rawOptions);
    this.prune();
    if (this.control.paused || event.timestamp * 1000 <= this.control.cutoff || event.timestamp * 1000 < this.now() - this.control.retentionDays * privacy.DAY) {
      return {accepted: true, ignored: true, reason: this.control.paused ? 'privacy-paused' : 'expired'};
    }
    const key = `${source.id}:${event.id}`;
    if (this.seen.has(key)) return { accepted: true, duplicate: true, key };
    const record = { key, receivedAt: this.now(), source, event, read: false };
    const oldEntries = this.entries;
    const oldSeen = new Set(this.seen);
    const oldSeenAt = new Map(this.seenAt);
    this.entries = [...this.entries, record].slice(-MAX_HISTORY);
    this.seen.add(key);
    this.seenAt.set(key, this.now());
    this.trimSeen();
    try { this.save(); } catch (error) { this.entries = oldEntries; this.seen = oldSeen; this.seenAt = oldSeenAt; throw error; }
    this.emit('changed');
    this.emit('event', record, options);
    return { accepted: true, duplicate: false, key };
  }

  history() {
    this.prune();
    return {entries: [...this.entries].reverse(), unread: this.entries.filter(record => !record.read).length,
      privacyPaused: this.control.paused, retentionDays: this.control.retentionDays};
  }

  markRead(request) {
    let keys;
    if (request.key !== undefined) keys = [field(request.key, 'key', 513, true)];
    else if (request.keys !== undefined) {
      if (!Array.isArray(request.keys) || request.keys.length > MAX_HISTORY) throw new Error('Invalid keys');
      keys = request.keys.map(key => field(key, 'key', 513, true));
    }
    const selected = keys ? new Set(keys) : undefined;
    const oldEntries = this.entries;
    this.entries = this.entries.map(record => (!selected || selected.has(record.key)) ? { ...record, read: true } : record);
    try { this.save(); } catch (error) { this.entries = oldEntries; throw error; }
    this.emit('changed');
    return { unread: this.entries.filter(record => !record.read).length };
  }

  deleteEntry(request) {
    object(request, 'delete request');
    const key = field(request.key, 'key', 513, true);
    return this.removeMatching(record => record.key === key);
  }

  clearRead() { return this.removeMatching(record => record.read); }

  removeMatching(predicate) {
    const previous = this.entries;
    const removed = previous.filter(predicate);
    if (!removed.length) return {deleted: 0, unread: previous.filter(record => !record.read).length};
    const keys = new Set(removed.map(record => record.key));
    this.entries = previous.filter(record => !keys.has(record.key));
    // Preserve deduplication tombstones so an observer replay cannot resurrect
    // notifications the user deleted, including after a broker restart.
    try { this.save(); } catch (error) { this.entries = previous; throw error; }
    this.emit('removed', [...keys]);
    this.emit('changed');
    return {deleted: removed.length, unread: this.entries.filter(record => !record.read).length};
  }

  clear() {
    this.removeMatching(() => true);
    return { unread: 0 };
  }
}

function formatBatch(items) {
  const t = translator(items[0]?.record.notificationLanguage || 'zh-CN');
  const priority = { approval: 0, question: 1, done: 2, test: 3 };
  const visibleItems = items.filter(item => item.options.desktop);
  const sorted = [...visibleItems].sort((a, b) => priority[a.record.event.type] - priority[b.record.event.type]);
  const firstProject = sorted[0]?.record.event.cwd.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop();
  const title = visibleItems.length === 1 ? t(TITLES[sorted[0].record.event.type]) + (firstProject ? ` · ${firstProject}` : '') : t`Codex 有 ${visibleItems.length} 条新提醒`;
  const lines = sorted.slice(0, 4).map(({ record }) => {
    const source = record.targetWindowLabel || record.source.label || record.event.label || record.source.host || record.event.host || record.source.id;
    const type = t(TITLES[record.event.type]).replace('Codex ', '');
    const project = record.event.cwd.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop();
    const session = record.event.session_id ? ` · ${record.event.session_id.slice(0, 8)}` : '';
    return `${type}${project ? ' · ' + project.slice(0, 24) : ''} · ${source.slice(0, 48)}${session}`;
  });
  if (visibleItems.length > 4) lines.push(t`另有 ${visibleItems.length - 4} 条，请查看通知历史`);
  return { title, body: lines.join('\n'), sound: items.some(item => item.options.sound), desktop: items.some(item => item.options.desktop), keys: visibleItems.map(item => item.record.key) };
}

class BatchScheduler extends EventEmitter {
  constructor(deliver, options = {}) {
    super();
    this.deliver = deliver;
    this.now = options.now || Date.now;
    this.scheduleTimer = options.setTimeout || setTimeout;
    this.cancelTimer = options.clearTimeout || clearTimeout;
    this.batchMs = options.batchMs ?? 700;
    this.intervalMs = options.intervalMs ?? 4000;
    this.queueLimit = options.queueLimit ?? 1000;
    this.filterItems = options.filterItems || (items => items);
    this.queue = [];
    this.timer = null;
    this.lastDelivery = -Infinity;
    this.delivering = false;
    this.closed = false;
  }

  add(record, options) {
    if (this.closed || (!options.desktop && !options.sound)) return;
    if (this.queue.length >= this.queueLimit) {
      this.emit('deliveryError', [record], 'Notification queue limit reached');
      return;
    }
    this.queue.push({ record, options, queuedAt: this.now() });
    this.plan();
  }

  plan() {
    if (this.closed || this.timer !== null || this.delivering || !this.queue.length) return;
    const due = Math.max(this.queue[0].queuedAt + this.batchMs, this.lastDelivery + this.intervalMs);
    this.timer = this.scheduleTimer(() => { this.timer = null; void this.flush(); }, Math.max(0, due - this.now()));
  }

  async flush() {
    if (this.closed || this.delivering || !this.queue.length) return;
    this.delivering = true;
    const items = this.filterItems(this.queue.splice(0));
    if (!items.length) { this.delivering = false; this.plan(); return; }
    this.lastDelivery = this.now();
    try {
      // One native popup must not mix window languages. Preserve delivery failure isolation.
      const groups = new Map();
      for (const item of items) {
        const language = item.record.notificationLanguage === 'en' ? 'en' : 'zh-CN';
        if (!groups.has(language)) groups.set(language, []);
        groups.get(language).push(item);
      }
      for (const group of groups.values()) {
        if (this.closed) break;
        const live = this.filterItems(group);
        if (!live.length) continue;
        try { await this.deliver(formatBatch(live), live.map(item => item.record)); }
        catch (error) { this.emit('deliveryError', live.map(item => item.record), error.message); }
      }
    }
    finally {
      this.delivering = false;
      this.plan();
    }
  }

  close() {
    this.closed = true;
    if (this.timer !== null) this.cancelTimer(this.timer);
    this.timer = null;
    this.queue = [];
  }

  cancel(predicate = () => true) {
    this.queue = this.queue.filter(item => !predicate(item.record));
    if (!this.queue.length && this.timer !== null) { this.cancelTimer(this.timer); this.timer = null; }
  }
}

module.exports = { NotificationStore, BatchScheduler, validateSource, validateEvent, validateOptions, formatBatch, MAX_HISTORY, MAX_SEEN, BROKER_PROTOCOL_VERSION };
