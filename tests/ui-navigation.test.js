'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {openCodexSession: navigate} = require('../ui/lib/navigation');
const openCodexSession = (api, value, options = {}) => navigate(api, value, {location: 'editor', ...options});
const id = '11111111-2222-4333-8444-555555555555';

function targetUri(value) {
  return {...value, toString: () => value.scheme + '://' + value.authority + value.path};
}

class TabInputCustom {
  constructor(uri, viewType = 'chatgpt.conversationEditor') {
    this.uri = uri;
    this.viewType = viewType;
  }
}

function tabApi(input = new TabInputCustom(targetUri({scheme: 'openai-codex', authority: 'route', path: '/local/' + id}))) {
  return {TabInputCustom, window: {tabGroups: {activeTabGroup: {activeTab: {input}}}}};
}

const shortWait = {tabWaitTimeoutMs: 40, tabPollIntervalMs: 5};

test('privacy cancellation prevents queued navigation and stops post-open focus', async () => {
  const calls = [];
  let cancelled = true;
  const api = {...tabApi(), Uri: {from: targetUri}, ViewColumn: {Active: -1},
    commands: {executeCommand: async name => {calls.push(name); cancelled = true;}}};
  await assert.rejects(openCodexSession(api, id, {isCancelled: () => cancelled}), {code: 'PRIVACY_CANCELLED'});
  assert.deepEqual(calls, []);
  cancelled = false;
  await assert.rejects(openCodexSession(api, id, {isCancelled: () => cancelled}), {code: 'PRIVACY_CANCELLED'});
  assert.deepEqual(calls, ['vscode.openWith']);
});

test('session navigation opens the Codex custom editor in the current destination window', async () => {
  const calls = [];
  let target;
  const vscode = {
    ...tabApi(),
    Uri: {from: value => {target = targetUri(value); return target;}},
    ViewColumn: {Active: -1},
    commands: {executeCommand: async (...args) => {calls.push(args);}},
  };
  assert.deepEqual(await openCodexSession(vscode, id), {sessionId: id, requested: true, method: 'window-editor'});
  assert.equal(target.toString(), 'openai-codex://route/local/' + id);
  assert.deepEqual(calls, [
    ['vscode.openWith', target, 'chatgpt.conversationEditor',
      {viewColumn: -1, preserveFocus: false, preview: false}],
    ['workbench.action.focusWindow'],
  ]);
});

test('invalid identifiers cannot navigate arbitrary extension routes or execute commands', async () => {
  for (const value of ['', '../settings', 'command:run', id + '?command=run', null]) {
    await assert.rejects(openCodexSession({}, value), /有效的 Codex 会话标识/);
  }
});

test('remote-only Codex can navigate when absent from the local extension registry', async () => {
  const requested = [];
  const vscode = {
    ...tabApi(),
    extensions: {getExtension: () => undefined},
    Uri: {from: targetUri},
    ViewColumn: {Active: -1},
    commands: {executeCommand: async (...args) => {requested.push(args);}},
    env: {remoteName: 'ssh-remote'},
  };
  // Exercise the actual dispatch branch; previewOnly would hide the bug.
  assert.deepEqual(await openCodexSession(vscode, id), {sessionId: id, requested: true, method: 'window-editor'});
  assert.equal(requested.length, 2);
  assert.equal(requested[0][1].path, '/local/' + id);
  assert.deepEqual(requested[1], ['workbench.action.focusWindow']);
});

test('unsupported extension registry or external URI getters are never accessed', async () => {
  const unsupported = () => {throw new Error('unsupported getter was accessed');};
  let opened = false;
  const vscode = {
    ...tabApi(),
    Uri: {from: targetUri},
    ViewColumn: {Active: -1},
    commands: {executeCommand: async () => {opened = true;}},
    get extensions() {return unsupported();},
    get env() {return unsupported();},
  };
  await openCodexSession(vscode, id);
  assert.equal(opened, true);
});

test('missing Codex custom editor failures propagate without any global URI fallback', async () => {
  const failure = new Error('No provider found for chatgpt.conversationEditor');
  let attempts = 0;
  let externalAttempts = 0;
  const vscode = {
    ...tabApi(),
    Uri: {from: targetUri}, ViewColumn: {Active: -1},
    commands: {executeCommand: async () => {attempts++; throw failure;}},
    env: {uriScheme: 'vscode', asExternalUri: async value => value,
      openExternal: async () => {externalAttempts++; return true;}},
  };
  await assert.rejects(openCodexSession(vscode, id), error => error === failure);
  assert.equal(attempts, 1);
  assert.equal(externalAttempts, 0);
});

test('window focus failures propagate after opening without a global URI fallback', async () => {
  const failure = new Error('Target window focus failed');
  const commands = [];
  let externalAttempts = 0;
  const vscode = {
    ...tabApi(),
    Uri: {from: targetUri}, ViewColumn: {Active: -1},
    commands: {executeCommand: async name => {
      commands.push(name);
      if (name === 'workbench.action.focusWindow') throw failure;
    }},
    env: {uriScheme: 'vscode', asExternalUri: async value => value,
      openExternal: async () => {externalAttempts++; return true;}},
  };
  await assert.rejects(openCodexSession(vscode, id), error => error === failure);
  assert.deepEqual(commands, ['vscode.openWith', 'workbench.action.focusWindow']);
  assert.equal(externalAttempts, 0);
});

test('a missing or mismatched custom editor tab never requests window focus', async () => {
  const expectedUri = targetUri({scheme: 'openai-codex', authority: 'route', path: '/local/' + id});
  const inputs = [
    undefined,
    {uri: expectedUri, viewType: 'chatgpt.conversationEditor'},
    new TabInputCustom(expectedUri, 'another.editor'),
    new TabInputCustom(targetUri({scheme: 'openai-codex', authority: 'route', path: '/local/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'})),
  ];
  for (const input of inputs) {
    const commands = [];
    const vscode = {
      ...tabApi(null), Uri: {from: targetUri}, ViewColumn: {Active: -1},
      commands: {executeCommand: async name => {commands.push(name);}},
    };
    vscode.window.tabGroups.activeTabGroup.activeTab.input = input;
    await assert.rejects(openCodexSession(vscode, id, shortWait), /未能确认目标 Codex 会话标签/);
    assert.deepEqual(commands, ['vscode.openWith']);
  }
});

test('navigation waits for a delayed matching custom editor before focusing', async () => {
  const commands = [];
  let timer;
  const vscode = {
    ...tabApi(null), Uri: {from: targetUri}, ViewColumn: {Active: -1},
    commands: {executeCommand: async (name, uri) => {
      commands.push(name);
      if (name === 'vscode.openWith') {
        timer = setTimeout(() => {
          vscode.window.tabGroups.activeTabGroup.activeTab = {input: new TabInputCustom(uri)};
        }, 20);
      } else {
        assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab.input instanceof TabInputCustom);
      }
    }},
  };
  try {
    assert.deepEqual(await openCodexSession(vscode, id, {...shortWait, tabWaitTimeoutMs: 500}),
      {sessionId: id, requested: true, method: 'window-editor'});
    assert.deepEqual(commands, ['vscode.openWith', 'workbench.action.focusWindow']);
  } finally {clearTimeout(timer);}
});

test('unavailable tab metadata fails within the bound without a global URI fallback', async () => {
  const commands = [];
  const vscode = {
    Uri: {from: targetUri}, ViewColumn: {Active: -1},
    get window() {throw new Error('tab metadata getter unavailable');},
    commands: {executeCommand: async name => {commands.push(name);}},
    get env() {throw new Error('must not access external URI APIs');},
  };
  await assert.rejects(openCodexSession(vscode, id, shortWait), /未能确认目标 Codex 会话标签/);
  assert.deepEqual(commands, ['vscode.openWith']);
});

test('preview returns the custom editor URI without claiming real Codex navigation', async () => {
  let attempts = 0;
  const vscode = {
    Uri: {from: targetUri}, ViewColumn: {Active: -1},
    commands: {executeCommand: async () => {attempts++;}},
    get env() {throw new Error('preview must not resolve an external URI');},
  };
  assert.deepEqual(await openCodexSession(vscode, id, {previewOnly: true}), {
    sessionId: id, uri: 'openai-codex://route/local/' + id,
    requested: false, previewOnly: true, method: 'window-editor',
  });
  assert.equal(attempts, 0);
});
