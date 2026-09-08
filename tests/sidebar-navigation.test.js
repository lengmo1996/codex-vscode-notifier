'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {openCodexSession} = require('../ui/lib/navigation');
const id = '11111111-2222-4333-8444-555555555555';
function fixture() {
  const calls = [];
  const api = {calls, env: {uriScheme: 'vscode',
    asExternalUri() {throw new Error('Must not use numeric windowId routing');},
    openExternal() {throw new Error('Must not dispatch through the OS');}},
    Uri: {from: value => ({...value, toString() {return `${this.scheme}://${this.authority}${this.path}`;}})},
    window: {state: {focused: true}},
    commands: {getCommands: async () => ['chatgpt.openSidebar'],
      executeCommand: async (...args) => {calls.push(args);}}};
  return api;
}
test('default opens the sidebar route after focusing the destination without opening an editor', async () => {
  const api = fixture();
  assert.deepEqual(await openCodexSession(api, id), {sessionId: id, requested: true, method: 'sidebar'});
  assert.deepEqual(api.calls.map(call => call[0]), ['workbench.action.focusWindow', 'chatgpt.openSidebar', 'vscode.open']);
  const uri = api.calls[2][1];
  assert.equal(uri.toString(), 'vscode://openai.chatgpt/local/' + id);
  assert.equal(uri.query, undefined);
});
test('missing Codex commands fail without opening a link or offering an unrelated install', async () => {
  const api = fixture(); api.commands.getCommands = async () => [];
  await assert.rejects(openCodexSession(api, id), /侧栏不可用/);
  assert.deepEqual(api.calls, []);
});
test('cannot dispatch to a background window and preserves failure when focus moves', async () => {
  const api = fixture(); api.window.state.focused = false;
  await assert.rejects(openCodexSession(api, id, {tabWaitTimeoutMs: 0}), /未能聚焦/);
  assert.deepEqual(api.calls.map(call => call[0]), ['workbench.action.focusWindow']);
  for (const stage of ['chatgpt.openSidebar', 'vscode.open']) {
    const next = fixture();
    next.commands.executeCommand = async (...args) => {next.calls.push(args); if (args[0] === stage) next.window.state.focused = false;};
    await assert.rejects(openCodexSession(next, id), /保留未读/);
    if (stage === 'chatgpt.openSidebar') assert.equal(next.calls.some(call => call[0] === 'vscode.open'), false);
  }
});
test('privacy cancellation during sidebar activation prevents route dispatch', async () => {
  const api = fixture(); let cancelled = false;
  api.commands.executeCommand = async (...args) => {api.calls.push(args); if (args[0] === 'chatgpt.openSidebar') cancelled = true;};
  await assert.rejects(openCodexSession(api, id, {isCancelled: () => cancelled}), {code: 'PRIVACY_CANCELLED'});
  assert.equal(api.calls.length, 2);
});
test('rejected sidebar route requests do not fall back to an editor or OS URL', async () => {
  const api = fixture();
  api.commands.executeCommand = async (...args) => {api.calls.push(args); if (args[0] === 'vscode.open') throw new Error('route failed');};
  await assert.rejects(openCodexSession(api, id), /route failed/);
  assert.equal(api.calls.length, 3);
});
test('sidebar preview and malformed settings cannot dispatch commands', async () => {
  const api = fixture();
  assert.equal((await openCodexSession(api, id, {previewOnly: true})).requested, false);
  await assert.rejects(openCodexSession(api, id, {location: 'unknown'}), /未知/);
  await assert.rejects(openCodexSession(api, '../settings'), /有效的/);
  api.env.uriScheme = 'https';
  await assert.rejects(openCodexSession(api, id), /不支持/);
  assert.deepEqual(api.calls, []);
});
