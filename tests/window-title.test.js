'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WindowTitleController } = require('../ui/lib/window-title');

function mockVscode(options = {}) {
  const settings = { defaultValue: '${activeEditorShort}${separator}${rootName}${separator}${appName}', ...options.settings };
  const calls = [];
  const edits = [];
  const contexts = new Map();
  const api = {
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    commands: {
      async getCommands() { return options.supported === false ? ['setContext'] : ['setContext', 'registerWindowTitleVariable']; },
      async executeCommand(command, ...args) {
        calls.push({ command, args });
        if (command === 'setContext') contexts.set(args[0], args[1]);
      },
    },
    workspace: {
      getConfiguration(section) {
        assert.equal(section, 'window');
        return {
          inspect() { options.onInspect?.(settings); return { ...settings }; },
          get() { return settings.workspaceValue ?? settings.globalValue ?? settings.defaultValue; },
          async update(key, value, target) {
            if (options.updateError) throw new Error(options.updateError);
            edits.push({ key, value, target });
            settings[target === 2 ? 'workspaceValue' : 'globalValue'] = value;
          },
        };
      },
    },
  };
  return { api, settings, calls, edits, contexts };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('unsupported title command does not write settings or contexts', async () => {
  const mock = mockVscode({ supported: false });
  const title = new WindowTitleController(mock.api);
  assert.equal((await title.initialize()).supported, false);
  assert.equal((await title.update('等待回答')).applied, false);
  assert.equal(mock.edits.length, 0);
  assert.equal(mock.calls.length, 0);
});

test('initialization prefixes once and later unread updates only change this windows context', async () => {
  const mock = mockVscode();
  const title = new WindowTitleController(mock.api);
  const initialized = await title.initialize();
  assert.equal(initialized.configured, true);
  assert.equal(initialized.scope, 'global');
  assert.equal(mock.edits.length, 1);
  assert.equal(mock.edits[0].value, '${codexNotification}${separator}' + mock.settings.defaultValue);
  assert.deepEqual(mock.calls[0], { command: 'registerWindowTitleVariable', args: ['codexNotification', 'codexNotifier.windowTitle'] });
  await title.update('[待处理 3]');
  await title.update('[待处理 1]');
  assert.equal(mock.contexts.get('codexNotifier.windowTitle'), '[待处理 1]');
  assert.equal(mock.edits.length, 1);
});

test('existing token is not duplicated, including when initialization runs again in another host', async () => {
  const mock = mockVscode({ settings: { globalValue: '${codexNotification}${separator}CUSTOM' } });
  await new WindowTitleController(mock.api).initialize();
  await new WindowTitleController(mock.api).initialize();
  assert.equal(mock.edits.length, 0);
  assert.equal(mock.settings.globalValue, '${codexNotification}${separator}CUSTOM');
});

test('effective workspace override is updated at workspace scope and global settings stay intact', async () => {
  const mock = mockVscode({ settings: { globalValue: 'GLOBAL', workspaceValue: 'WORKSPACE' } });
  assert.equal((await new WindowTitleController(mock.api).initialize()).scope, 'workspace');
  assert.equal(mock.edits[0].target, 2);
  assert.equal(mock.settings.workspaceValue, '${codexNotification}${separator}WORKSPACE');
  assert.equal(mock.settings.globalValue, 'GLOBAL');
});

test('second inspection preserves a concurrently changed template', async () => {
  let inspections = 0;
  const mock = mockVscode({ settings: { globalValue: 'OLD' }, onInspect(settings) {
    if (++inspections === 2) settings.globalValue = 'USER CHANGED';
  } });
  await new WindowTitleController(mock.api).initialize();
  assert.equal(mock.settings.globalValue, '${codexNotification}${separator}USER CHANGED');
});

test('binding marker restores the newest friendly prefix after updates during discovery', async () => {
  const mock = mockVscode();
  const title = new WindowTitleController(mock.api);
  await title.update('[待处理 1]');
  const entered = deferred();
  const finish = deferred();
  const bound = title.withBindingMarker('CN-BIND-0123456789', async marker => {
    assert.equal(mock.contexts.get('codexNotifier.windowTitle'), marker);
    entered.resolve();
    await finish.promise;
    return '123456';
  });
  await entered.promise;
  assert.equal((await title.update('[待处理 7]')).deferred, true);
  assert.equal(mock.contexts.get('codexNotifier.windowTitle'), 'CN-BIND-0123456789');
  finish.resolve();
  assert.equal(await bound, '123456');
  assert.equal(mock.contexts.get('codexNotifier.windowTitle'), '[待处理 7]');
});

test('failed binding restores the friendly prefix and does not prevent a later attempt', async () => {
  const mock = mockVscode();
  const title = new WindowTitleController(mock.api);
  await title.update('[待处理]');
  await assert.rejects(title.withBindingMarker('CN-BIND-failed', async () => { throw new Error('no unique HWND'); }), /no unique HWND/);
  assert.equal(mock.contexts.get('codexNotifier.windowTitle'), '[待处理]');
  assert.equal(await title.withBindingMarker('CN-BIND-next', async () => 123), 123);
});

test('dispose during binding clears the context and never restores an old marker or overwrites settings', async () => {
  const mock = mockVscode();
  const title = new WindowTitleController(mock.api);
  await title.update('[待处理]');
  const entered = deferred();
  const finish = deferred();
  const bound = title.withBindingMarker('CN-BIND-dispose', async () => { entered.resolve(); await finish.promise; });
  await entered.promise;
  mock.settings.globalValue = 'USER NEW TEMPLATE';
  await title.dispose();
  finish.resolve();
  await bound;
  assert.equal(mock.contexts.get('codexNotifier.windowTitle'), '');
  assert.equal(mock.settings.globalValue, 'USER NEW TEMPLATE');
  assert.equal(mock.edits.length, 1);
  assert.equal((await title.update('AFTER DISPOSE')).applied, false);
});

test('removing the variable later is respected instead of automatically rewriting the users template', async () => {
  const mock = mockVscode();
  const title = new WindowTitleController(mock.api);
  await title.initialize();
  mock.settings.globalValue = 'USER REMOVED TOKEN';
  assert.equal((await title.update('[待处理]')).applied, false);
  await assert.rejects(title.withBindingMarker('CN-BIND-missing', async () => assert.fail('must not enumerate an absent marker')), /binding is unavailable/);
  assert.equal(mock.settings.globalValue, 'USER REMOVED TOKEN');
  assert.equal(mock.edits.length, 1);
});

test('configuration failure is reported without claiming that the prefix was enabled', async () => {
  const mock = mockVscode({ updateError: 'settings are read-only' });
  const result = await new WindowTitleController(mock.api).initialize();
  assert.equal(result.supported, true);
  assert.equal(result.configured, false);
  assert.match(result.reason, /read-only/);
});
