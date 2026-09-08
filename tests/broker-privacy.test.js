'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {NotificationStore} = require('../ui/lib/broker-core');
const privacy = require('../ui/lib/privacy-storage');
const source = {id: 'test-source', host: 'synthetic-host', home: '/synthetic/home', cwd: '/synthetic/project', label: 'synthetic'};
const epoch = Date.UTC(2026, 8, 8);
function fixture(t) {
  const dir = path.join(__dirname, '.broker-test-data', crypto.randomUUID());
  fs.mkdirSync(dir, {recursive: true});
  let now = epoch;
  return {dir, now: () => now, advance: value => {now += value;},
    event: id => ({version: 1, id, type: 'done', timestamp: now / 1000, session_id: 'synthetic-session', originator: 'codex_vscode'})};
}
test('history and tombstones expire on read and do not revive old log events', t => {
  const f = fixture(t); const store = new NotificationStore(f.dir, {now: f.now});
  const event = f.event('old'); const {key} = store.add(source, event, {});
  store.deleteEntry({key});
  assert.equal(store.seen.size, 1);
  f.advance(8 * privacy.DAY);
  assert.equal(store.history().entries.length, 0);
  assert.equal(store.seen.size, 0);
  assert.equal(store.add(source, event, {}).ignored, true);
  assert.equal(store.add(source, f.event('new'), {}).duplicate, false);
  const recovered = new NotificationStore(f.dir, {now: f.now});
  assert.equal(recovered.entries.length, 1);
  assert.equal(recovered.entries[0].event.id, 'new');
});
test('retention reduction expires unread/read alike and cancels matching pending notifications', t => {
  const f = fixture(t); const store = new NotificationStore(f.dir, {now: f.now});
  store.add(source, f.event('past'), {});
  f.advance(3 * privacy.DAY);
  store.add(source, f.event('recent'), {});
  const removed = []; store.on('removed', keys => removed.push(...keys));
  store.setRetentionDays(1);
  assert.deepEqual(store.entries.map(e => e.event.id), ['recent']);
  assert.deepEqual(removed, ['test-source:past']);
  assert.equal(new NotificationStore(f.dir, {now: f.now}).control.retentionDays, 1);
  for (const bad of [0, 31, -1, 1.5, '7']) assert.throws(() => store.setRetentionDays(bad));
});
test('privacy reset deletes only known caches, forgets IDs, and remains paused across restart', t => {
  const f = fixture(t); const store = new NotificationStore(f.dir, {fileName: 'broker-state-v5.json', now: f.now});
  const old = f.event('secret-id'); store.add(source, old, {});
  fs.writeFileSync(path.join(f.dir, 'broker-state-v3.json'), 'legacy private');
  fs.writeFileSync(path.join(f.dir, 'broker-token'), 'old-secret');
  fs.writeFileSync(path.join(f.dir, 'unrelated.txt'), 'preserve');
  const result = store.resetPrivacy();
  assert.equal(result.paused, true);
  for (const name of ['broker-state-v5.json','broker-state-v3.json','broker-token']) assert.equal(fs.existsSync(path.join(f.dir,name)),false);
  assert.equal(fs.readFileSync(path.join(f.dir,'unrelated.txt'),'utf8'),'preserve');
  assert.ok(!fs.readFileSync(path.join(f.dir,privacy.CONTROL_FILE),'utf8').includes('secret-id'));
  const recovered = new NotificationStore(f.dir, {fileName: 'broker-state-v5.json', now: f.now});
  assert.equal(recovered.add(source, f.event('during-pause'), {}).reason,'privacy-paused');
  recovered.resumePrivacy();
  assert.equal(recovered.add(source, old, {}).reason,'expired');
  f.advance(1000);
  assert.equal(recovered.add(source, f.event('after-explicit-resume'), {}).ignored, undefined);
});
test('non-regular cache entry blocks deletion before touching other files', t => {
  const f = fixture(t); const store = new NotificationStore(f.dir, {now: f.now});
  store.add(source, f.event('keep-on-error'), {});
  fs.mkdirSync(path.join(f.dir, 'broker-state-v2.json'));
  assert.throws(() => store.resetPrivacy(), /非普通文件/);
  assert.equal(store.entries.length, 1);
  assert.ok(fs.existsSync(path.join(f.dir, 'broker-state.json')));
});
test('hardlinked cache cannot be followed or removed as notifier-owned data', t => {
  const f = fixture(t); const store = new NotificationStore(f.dir, {now: f.now});
  const outside = path.join(f.dir,'unrelated.txt'); fs.writeFileSync(outside,'private-unrelated');
  fs.linkSync(outside,path.join(f.dir,'broker-state-v2.json'));
  assert.throws(() => store.resetPrivacy(), /链接/);
  assert.equal(fs.readFileSync(outside,'utf8'),'private-unrelated');
});
test('expired legacy files are removed by age without deleting current unrelated files', t => {
  const f = fixture(t);
  const legacy = path.join(f.dir,'broker-state-v2.json'); fs.writeFileSync(legacy,'expired');
  fs.utimesSync(legacy,new Date(epoch - 9*privacy.DAY),new Date(epoch - 9*privacy.DAY));
  fs.writeFileSync(path.join(f.dir,'unrelated.txt'),'preserve');
  const store = new NotificationStore(f.dir, {now:f.now});
  assert.equal(fs.existsSync(legacy),false);
  assert.ok(fs.existsSync(path.join(f.dir,'unrelated.txt')));
  assert.equal(store.history().entries.length,0);
});
