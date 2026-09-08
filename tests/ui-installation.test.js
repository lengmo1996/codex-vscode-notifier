'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {REMOTE_ID, inspectInstallation, showInstallation} = require('../ui/lib/installation');

function fixture(remoteName, commands = [], result = {state: 'running'}) {
  const calls = [];
  return {calls, env: {remoteName},
    commands: {getCommands: async () => commands,
      executeCommand: async (...args) => { calls.push(args); return result; }},
    window: {showInformationMessage: async () => undefined}};
}

test('Local folders use embedded collection and never require the pack companion', async () => {
  const api = fixture(undefined, ['codexNotifier.local.status']);
  assert.equal((await inspectInstallation(api)).state, 'available');
  assert.deepEqual(api.calls, [['codexNotifier.local.status']]);
});
test('A locally installed companion cannot satisfy a remote environment', async () => {
  const api = fixture('ssh-remote', ['codexNotifier.local.status']);
  api.extensions = {getExtension: () => ({id: REMOTE_ID})};
  assert.deepEqual(await inspectInstallation(api), {state: 'missing', remote: true});
  assert.equal(api.calls.length, 0);
});
test('A container collector is detected through cross-host commands without local registry access', async () => {
  const api = fixture('dev-container', ['codexNotifier.remote.status']);
  assert.equal((await inspectInstallation(api)).state, 'available');
  assert.deepEqual(api.calls, [['codexNotifier.remote.status']]);
});
test('Activation failures and stopped collectors are not diagnosed as missing installations', async () => {
  const api = fixture('ssh-remote', ['codexNotifier.remote.status'], {state: 'stopped', enabled: false});
  assert.equal((await inspectInstallation(api)).state, 'available');
  api.commands.executeCommand = async () => { throw new Error('activation failed'); };
  assert.deepEqual(await inspectInstallation(api), {state: 'unavailable', remote: true});
});
test('Missing component guidance locates only the pinned companion without installing or reloading', async () => {
  const api = fixture('ssh-remote');
  await showInstallation(api, await inspectInstallation(api));
  assert.deepEqual(api.calls, [['workbench.extensions.search', `@id:${REMOTE_ID}`]]);
});
test('Local guidance does not open the marketplace and checks do not start or resume collection', async () => {
  const api = fixture(undefined, ['codexNotifier.local.status'], {state: 'stopped'});
  await showInstallation(api, await inspectInstallation(api));
  assert.deepEqual(api.calls, [['codexNotifier.local.status']]);
});
test('Rechecking after installation requires the explicit guide action', async () => {
  const api = fixture('dev-container');
  api.window.showInformationMessage = async () => '重新检查';
  await showInstallation(api, {state: 'missing', remote: true});
  assert.deepEqual(api.calls[1], ['codexNotifier.checkInstallation']);
});
