'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {ReadTracker} = require('../ui/lib/read-tracking');
const first = '11111111-1111-1111-1111-111111111111';
const second = '22222222-2222-2222-2222-222222222222';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(focused = false) {
  const listeners = {};
  const subscribe = name => callback => {listeners[name] = callback; return {dispose() {delete listeners[name];}};};
  class TabInputCustom {constructor(id) {this.viewType = 'chatgpt.conversationEditor'; this.uri = {scheme: 'openai-codex', authority: 'route', path: '/local/' + id};}}
  const vscode = {TabInputCustom, window: {state: {focused}, onDidChangeWindowState: subscribe('focus'),
    tabGroups: {activeTabGroup: {}, onDidChangeTabs: subscribe('tabs'), onDidChangeTabGroups: subscribe('groups')}}};
  const state = {entries: [], enabled: true, suspended: false, calls: [], errors: []};
  const tracker = new ReadTracker(vscode, {windowId: 'local', entries: () => state.entries,
    enabled: () => state.enabled, suspended: () => state.suspended,
    acknowledge: async keys => {state.calls.push(keys);}, log: error => state.errors.push(error)});
  return {...state, state, tracker, focus(value) {listeners.focus({focused: value});},
    select(id) {vscode.window.tabGroups.activeTabGroup.activeTab = {input: new TabInputCustom(id)}; listeners.tabs();}};
}
const entry = (key, session = first, target = 'local', read = false) => ({key, event: {session_id: session}, targetWindowId: target, read});

test('returning to a window acknowledges only its existing unread reminders without consuming later arrivals', async () => {
  const f = fixture();
  f.state.entries = [entry('one'), entry('two', second), entry('other', first, 'other'), entry('read', first, 'local', true)];
  f.focus(true);
  f.state.entries.push(entry('new'));
  await tick();
  assert.deepEqual(f.state.calls, [['one', 'two']]);
  f.focus(true);
  await tick();
  assert.equal(f.state.calls.length, 1);
  f.tracker.dispose();
});

test('selecting a Codex editor in an already focused window acknowledges only that session', async () => {
  const f = fixture(true);
  f.state.entries = [entry('one'), entry('two', second), entry('other', first, 'other')];
  f.select(first);
  f.select(first);
  await tick();
  assert.deepEqual(f.state.calls, [['one']]);
  f.select(second);
  await tick();
  assert.deepEqual(f.state.calls, [['one'], ['two']]);
  f.tracker.dispose();
});

test('startup, background tab changes and disabled tracking do not acknowledge reminders', async () => {
  const f = fixture();
  f.state.entries = [entry('one')];
  f.select(first);
  await tick();
  assert.equal(f.state.calls.length, 0);
  f.state.enabled = false;
  f.focus(true);
  f.select(second);
  await tick();
  assert.equal(f.state.calls.length, 0);
  f.tracker.dispose();
});

test('notification navigation suppresses focus and tab bulk reads even if auto-read is enabled', async () => {
  const f = fixture();
  f.state.entries = [entry('one'), entry('two', second)];
  f.state.suspended = true;
  f.focus(true);
  f.select(first);
  await tick();
  assert.deepEqual(f.state.calls, []);
  f.state.suspended = false;
  await tick();
  assert.deepEqual(f.state.calls, [], 'Suppressed events must not be replayed after navigation');
  f.tracker.dispose();
});

test('a queued bulk read is cancelled when notification navigation begins before acknowledgement', async () => {
  const f = fixture();
  f.state.entries = [entry('one'), entry('two', second)];
  f.focus(true);
  f.state.suspended = true;
  await tick();
  assert.deepEqual(f.state.calls, []);
  f.tracker.dispose();
});
