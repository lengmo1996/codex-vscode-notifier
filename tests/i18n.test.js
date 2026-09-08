'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {t, translator, configureLanguage, getLanguage, message, renderMessage, MESSAGES} = require('../ui/lib/i18n');
const {formatBatch, BatchScheduler} = require('../ui/lib/broker-core');
const {eventTitle, historyGroups} = require('../ui/lib/presentation');
const {WindowRegistry} = require('../ui/lib/routing');
const {PrivacyActions} = require('../ui/lib/privacy');
const {showInstallation} = require('../ui/lib/installation');
const sample = (language, type = 'done') => ({record: {key: language + type, notificationLanguage: language,
  source: {id: language, label: '研究项目 {0} $&', host: 'host'}, targetWindowId: language,
  event: {type, cwd: '/project/实验', session_id: '12345678-1234-4234-8234-123456789abc'}, read: false, receivedAt: 1},
  options: {desktop: true, sound: true}});
test.afterEach(() => configureLanguage(() => 'zh-CN'));

test('Chinese is the independent default; fixed translators and opaque substitutions survive live changes', () => {
  assert.equal(getLanguage(), 'zh-CN');
  let language = 'en';
  configureLanguage(() => language);
  const zh = translator('zh-CN');
  const data = '本机 {0} $& ${secret} 中文';
  assert.equal(t`Codex 有 ${data} 条新提醒`, `Codex: ${data} new notifications`);
  assert.equal(zh('本轮已回复'), '本轮已回复');
  language = 'zh-CN';
  assert.equal(t('本轮已回复'), '本轮已回复');
  language = 'unsupported';
  assert.equal(getLanguage(), 'zh-CN');
  assert.equal(t(data), data);
});

test('Every catalogue entry has matching placeholders and a nonempty English translation', () => {
  const placeholders = text => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
  for (const [key, value] of Object.entries(MESSAGES)) {
    const [zh, en] = Array.isArray(value) ? value : [key, value];
    assert.ok(zh.trim() && en.trim(), key);
    assert.equal(/[\u3400-\u9fff]/u.test(en), false, key);
    assert.deepEqual(placeholders(zh), placeholders(en), key);
  }
});

test('Status templates render in the receiving window language without changing protocol or user metadata', () => {
  const spec = message('Collector is reading Codex event metadata.');
  assert.equal(renderMessage(spec, 'en'), 'Collector is reading Codex event metadata.');
  assert.equal(renderMessage(spec, 'zh-CN'), '采集器正在读取 Codex 事件元数据。');
  assert.equal(renderMessage({key: '__proto__', values: []}, 'en', 'raw'), 'raw');
  assert.equal(renderMessage({key: spec.key, values: 'not an array'}, 'en', 'raw'), 'raw');
});

test('History rerenders owned labels and keeps keys, read states, paths and source names', () => {
  const entry = sample('en').record;
  const before = JSON.stringify(entry);
  assert.match(eventTitle(entry), /^本轮已回复/);
  configureLanguage(() => 'en');
  assert.equal(eventTitle(entry), 'Reply finished · 研究项目 {0} $&');
  assert.equal(historyGroups([entry], 'en')[0].title, 'Pending in this window');
  assert.equal(JSON.stringify(entry), before);
});

test('Native notifications follow target language for all event types and keep opaque metadata intact', () => {
  configureLanguage(() => 'en');
  assert.match(formatBatch([sample('zh-CN')]).title, /^Codex 本轮已回复/);
  for (const [type, expected] of [['done', 'reply finished'], ['approval', 'awaiting approval'], ['question', 'awaiting an answer']]) {
    const batch = formatBatch([sample('en', type)]);
    assert.equal(batch.title, `Codex ${expected} · 实验`);
    assert.ok(batch.body.includes('研究项目 {0} $&'));
    assert.equal(batch.sound, true);
  }
});

test('Simultaneous native notifications are separated by language and one failure does not drop the other', async () => {
  const delivered = [], errors = [];
  const scheduler = new BatchScheduler(async (batch, entries) => {
    delivered.push({batch, entries});
    if (entries[0].notificationLanguage === 'zh-CN') throw new Error('fixture');
  }, {setTimeout: () => 1, clearTimeout: () => {}});
  scheduler.on('deliveryError', (entries, error) => errors.push({entries, error}));
  for (const item of [sample('zh-CN'), sample('en', 'question')]) scheduler.add(item.record, item.options);
  await scheduler.flush();
  scheduler.close();
  assert.equal(delivered.length, 2);
  assert.equal(errors.length, 1);
  assert.match(delivered[0].batch.title, /本轮已回复/);
  assert.match(delivered[1].batch.title, /awaiting an answer/);
  assert.equal(delivered[1].entries.length, 1);
});

test('Window language accepts only the explicit enum and cannot influence target routing', () => {
  const windows = new WindowRegistry(() => 1);
  const info = {id: 'en', sourceId: 'en', focused: true, workspaceCwd: '/project', language: 'en'};
  windows.update('en', info);
  assert.equal(windows.select(sample('en').record).language, 'en');
  assert.throws(() => windows.update('en', {...info, language: {value: 'en'}}), /language/);
  assert.equal(windows.select(sample('en').record).language, 'en');
});

test('Changing language during a privacy confirmation cannot cancel or accidentally authorize cleanup', async () => {
  let language = 'en';
  configureLanguage(() => language);
  const operations = [];
  const actions = new PrivacyActions({window: {
    async showWarningMessage(title, options, button) {
      assert.equal(title, 'Clear notification data and pause collection?');
      assert.equal(button, 'Clear and pause');
      assert.ok(options.modal);
      language = 'zh-CN';
      return button;
    }, async showInformationMessage() {},
  }}, {client: {async request(op) {operations.push(op); return {totalBytes: 0};}},
    clearOutput() {}, refresh: async () => {}, collector: async () => {throw new Error('Must not contact a collector');}});
  const result = await actions.clear({localOnly: true});
  assert.equal(result.cleared, true);
  assert.deepEqual(operations, ['interact', 'privacyStatus', 'privacyReset']);
  language = 'en';
  actions.vscode.window.showWarningMessage = async () => {language = 'zh-CN'; return undefined;};
  assert.deepEqual(await actions.clear({localOnly: true}), {cancelled: true});
  assert.equal(operations.filter(op => op === 'privacyReset').length, 1);
});

test('Installation dialog action remains valid when the language changes while open', async () => {
  let language = 'en'; configureLanguage(() => language);
  const commands = [];
  await showInstallation({commands: {async executeCommand(cmd) {commands.push(cmd);}}, window: {
    async showInformationMessage(text, button) {assert.equal(button, 'Check again'); language = 'zh-CN'; return button;},
  }}, {remote: true, state: 'missing'});
  assert.deepEqual(commands, ['workbench.extensions.search', 'codexNotifier.checkInstallation']);
});

test('Packaged collectors and UI use the exact canonical translations', () => {
  const canonical = fs.readFileSync(path.join(__dirname, '../remote/src/i18n.js'));
  assert.deepEqual(fs.readFileSync(path.join(__dirname, '../ui/lib/i18n.js')), canonical);
  assert.deepEqual(fs.readFileSync(path.join(__dirname, '../ui/collector/src/i18n.js')), canonical);
});
