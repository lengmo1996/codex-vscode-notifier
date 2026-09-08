'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const path = require('node:path');
const core = require('../remote/src/core');
const {activate, createController} = require('../remote/src/extension');

function event(id = 'event-1', type = 'done') {
  return {version: 1, type, id, timestamp: 1788796800, host: 'gpu-01', label: '训练服务器',
    cwd: '/experiment', session_id: 'session-1', turn_id: 'turn-2', originator: 'codex_vscode'};
}
const source = {id: 'source-1', label: 'GPU', host: 'gpu', home: '/home/user/.codex', cwd: '/project'};
const config = values => ({get: (key, fallback) => Object.hasOwn(values, key) ? values[key] : fallback});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('settings use explicit home, CODEX_HOME and OS home with platform Python defaults', () => {
  const environment = {platform: 'linux', home: '/home/research', env: {CODEX_HOME: '/container/codex'}};
  assert.equal(core.settings(config({}), environment).codexHome, '/container/codex');
  assert.equal(core.settings(config({codexHome: '~/custom'}), environment).codexHome, '/home/research/custom');
  assert.equal(core.settings(config({codexHome: 'relative'}), environment).codexHome, '/home/research/relative');
  assert.equal(core.settings(config({}), {...environment, env: {}}).codexHome, '/home/research/.codex');
  assert.deepEqual(core.settings(config({}), {platform: 'win32', home: 'C:\\Users\\研究员', env: {}}), {
    codexHome: 'C:\\Users\\研究员\\.codex', python: 'py', pythonArgs: ['-3'], enabled: true, label: '', retentionDays: 7,
  });
  assert.deepEqual(core.settings(config({pythonPath: '/custom/python'}), environment).pythonArgs, []);
});

test('source identity is stable across workspaces and changes with host or home', () => {
  const base = {codexHome: '/home/a/.codex', label: ''};
  const first = core.makeSource(base, {hostname: 'gpu-1', remoteName: 'ssh-remote', cwd: '/project/one'});
  const second = core.makeSource(base, {hostname: 'gpu-1', remoteName: 'ssh-remote', cwd: '/project/two'});
  assert.equal(first.id, second.id);
  assert.equal(first.label, 'ssh-remote/gpu-1');
  assert.equal(first.label, second.label);
  assert.equal(first.cwd, '/project/one');
  assert.notEqual(first.id, core.makeSource(base, {hostname: 'gpu-2'}).id);
  assert.notEqual(first.id, core.makeSource({...base, codexHome: '/home/b/.codex'}, {hostname: 'gpu-1'}).id);
});

test('local settings use their own keys without inheriting remote overrides', () => {
  const environment = {platform: 'linux', home: '/home/local', env: {}};
  const values = {codexHome: '/remote/codex', pythonPath: '/remote/python', sourceLabel: 'remote', collectorEnabled: false};
  assert.deepEqual(core.settings(config(values), environment, 'local'), {
    codexHome: '/home/local/.codex', python: 'python3', pythonArgs: [], label: '', enabled: true, retentionDays: 7,
  });
  assert.deepEqual(core.settings(config({...values, localCodexHome: '~/codex-local',
    localPythonPath: '/local/python', localSourceLabel: 'local', localCollectorEnabled: false}), environment, 'local'), {
    codexHome: '/home/local/codex-local', python: '/local/python', pythonArgs: [], label: 'local', enabled: false, retentionDays: 7,
  });
  assert.equal(core.settings(config({localCacheRetentionDays: 2}), environment, 'local').retentionDays, 2);
  for (const invalid of [0, -1, 31, 1.5, '7', null]) {
    assert.equal(core.settings(config({cacheRetentionDays: invalid}), environment).retentionDays, 7);
  }
});

test('event validator allowlists metadata and ignores malformed or unknown records', () => {
  const input = {...event(), prompt: 'PRIVATE', arguments: {password: 'SECRET'}};
  assert.deepEqual(core.normalizeEvent(input), event());
  for (const bad of [null, {}, {...event(), version: 2}, {...event(), timestamp: Infinity},
    {...event(), id: ''}, {...event(), type: 'function_call'}]) assert.equal(core.normalizeEvent(bad), null);
  assert.equal(core.normalizeEvent({...event(), cwd: 'abc\u0000\u001b\n'}).cwd, 'abc');
  assert.equal(core.normalizeEvent(event()).originator, 'codex_vscode');
  const legacy = event();
  delete legacy.originator;
  assert.equal(Object.hasOwn(core.normalizeEvent(legacy), 'originator'), false);
  assert.equal(Object.hasOwn(core.normalizeEvent({...event(), originator: {untrusted: true}}), 'originator'), false);
  assert.equal(Object.hasOwn(core.normalizeEvent({...event(), originator: 'codex_\nvscode'}), 'originator'), false);
});

test('framing handles split Unicode, corrupt and oversized lines without leaking or unbounded memory', () => {
  const found = [];
  const framing = new core.JsonLines(value => found.push(value));
  const bytes = Buffer.from(JSON.stringify(event()) + '\n');
  for (let index = 0; index < bytes.length; index++) framing.push(bytes.subarray(index, index + 1));
  framing.push(Buffer.from('bad json\n'));
  framing.push(Buffer.alloc(20000, 65));
  assert.equal(framing.pending.length, 0);
  framing.push(Buffer.from(JSON.stringify(event('not-a-new-line'))));
  framing.push(Buffer.from('\n' + JSON.stringify(event('event-2')) + '\n'));
  assert.deepEqual(found.map(value => value.id), ['event-1', 'event-2']);
});

test('backoff doubles and caps at sixty seconds', () => {
  assert.deepEqual([1, 2, 3, 7, 99].map(core.restartDelay), [1000, 2000, 4000, 60000, 60000]);
});

test('hook detection recognizes only this extension owner and never claims trust', () => {
  const hooks = command => ({hooks: {PermissionRequest: [{hooks: [{type: 'command', command}]}]}});
  assert.equal(core.hookIsConfigured(hooks('python collector.py hook --owner codex-vscode-notifier-v1 --event approval')), true);
  assert.equal(core.hookIsConfigured(hooks('python collector.py hook --owner codex-notifier-v1')), false);
  assert.equal(core.hookIsConfigured(hooks('python collector.py hook --owner codex-vscode-notifier-v1-wrong')), false);
  assert.equal(core.hookIsConfigured({hooks: []}), false);
});

test('bridge retains unacknowledged events, retries, deduplicates pending and forwards the protocol', async () => {
  let available = false;
  const delivered = [];
  const logs = [];
  const bridge = new core.EventBridge(async (command, message) => {
    assert.equal(command, 'codexNotifier.internal.receive');
    if (!available) throw new Error('missing local extension');
    delivered.push(message);
    return {accepted: true};
  }, line => logs.push(line));
  bridge.status(source, {state: 'connected', message: 'ok'});
  bridge.event(source, event());
  bridge.event(source, event());
  bridge.event(source, event('hb', 'heartbeat'));
  await tick();
  await bridge.flush();
  assert.equal(bridge.queue.length, 1);
  assert.equal(logs.length, 1);
  available = true;
  await bridge.flush();
  assert.deepEqual(delivered.map(item => item.kind), ['status', 'event']);
  assert.equal(delivered[1].version, 1);
  assert.equal(bridge.queue.length, 0);
  assert.equal(bridge.connected, true);
  bridge.dispose();
});

test('bridge requires accepted true and bounds the backlog to five hundred events', async () => {
  const bridge = new core.EventBridge(async () => ({accepted: false}), () => {});
  for (let index = 0; index < 600; index++) bridge.event(source, event(String(index)));
  await tick();
  assert.equal(bridge.queue.length, 500);
  assert.equal(bridge.queue[0].event.id, '100');
  assert.equal(bridge.connected, false);
  bridge.dispose();
});

function fixture(trusted = true, enabled = true, options = {}) {
  const commands = new Map();
  const children = [];
  const messages = [];
  const outputNames = [];
  const logs = [];
  const updates = [];
  const values = {codexHome: path.join(__dirname, 'unused-home'), collectorEnabled: enabled, ...options.values};
  let granted;
  let changed;
  let foldersChanged;
  const subscription = () => ({dispose() {}});
  const vscode = {
    workspace: {
      isTrusted: trusted, workspaceFolders: options.workspaceFolders ?? [{uri: {fsPath: '/workspace'}}],
      getConfiguration: () => ({...config(values), inspect: key => ({workspaceValue: values[key]}),
        async update(key, value, target) {
          values[key] = value;
          updates.push({key, value, target});
          changed?.({affectsConfiguration: actual => actual === `codexNotifier.${key}`});
        }}),
      onDidChangeConfiguration: handler => {changed = handler; return subscription();},
      onDidGrantWorkspaceTrust: handler => {granted = handler; return subscription();},
      onDidChangeWorkspaceFolders: handler => {foldersChanged = handler; return subscription();},
    },
    env: {remoteName: Object.hasOwn(options, 'remoteName') ? options.remoteName : 'ssh-remote'},
    commands: {
      registerCommand(name, handler) {commands.set(name, handler); return subscription();},
      async executeCommand(name, message) {messages.push(message); return {accepted: true};},
    },
    window: {
      createOutputChannel: name => {outputNames.push(name); return {appendLine(text) {logs.push(text);}, dispose() {}};},
      showInformationMessage: async text => {messages.push(text);},
      showErrorMessage: async text => {messages.push(text);},
    },
  };
  const spawn = (command, args, options) => {
    const process = new EventEmitter();
    process.stdout = new PassThrough();
    process.stderr = new PassThrough();
    process.pid = children.length + 1;
    process.killed = false;
    process.kill = () => {process.killed = true; setImmediate(() => process.emit('close', null, 'SIGTERM'));};
    children.push({process, command, args, options});
    return process;
  };
  const context = {extensionPath: options.extensionPath || path.join(__dirname, '../remote'), subscriptions: []};
  const controller = options.autoCreate === false ? null : createController(vscode, context, {spawn, ...options.dependencies});
  return {controller, commands, children, messages, vscode, values, context, outputNames, updates, logs,
    grant() {vscode.workspace.isTrusted = true; granted();},
    change(key) {changed({affectsConfiguration: actual => actual === `codexNotifier.${key}`});},
    folders(folders) {vscode.workspace.workspaceFolders = folders; foldersChanged?.();},
  };
}

test('workspace trust blocks processes and hook mutation until explicitly granted', async () => {
  const state = fixture(false);
  try {
    assert.equal(state.children.length, 0);
    const denied = await state.commands.get('codexNotifier.remote.configureApprovalHook')();
    assert.equal(denied.ok, false);
    assert.equal(state.children.length, 0);
    state.grant();
    assert.equal(state.children.length, 1);
    assert.ok(state.children[0].args.includes('follow'));
    assert.equal(state.children[0].options.shell, false);
    assert.equal(state.children[0].options.windowsHide, true);
    assert.equal(state.children[0].args.includes('install'), false);
  } finally {state.controller.dispose();}
});

const localDependencies = {commandPrefix: 'codexNotifier.local', configKeyPrefix: 'local', outputName: 'Codex 通知 · 本地采集'};
const localOptions = values => ({remoteName: undefined, extensionPath: path.join(__dirname, '../ui/collector'),
  dependencies: localDependencies, values: {localCodexHome: path.join(__dirname, 'unused-local-home'), ...values}});

test('remote activate leaves local windows entirely inactive', () => {
  const state = fixture(false, true, {autoCreate: false, remoteName: undefined});
  const Module = require('node:module');
  const original = Module._load;
  try {
    Module._load = function (request, parent, isMain) {
      return request === 'vscode' ? state.vscode : original.call(this, request, parent, isMain);
    };
    assert.equal(activate(state.context), undefined);
    assert.deepEqual([...state.commands.keys()], []);
    assert.equal(state.children.length, 0);
    assert.deepEqual(state.outputNames, []);
    assert.equal(state.context.subscriptions.length, 0);
  } finally {
    Module._load = original;
    for (const subscription of state.context.subscriptions) subscription.dispose();
  }
});

test('embedded local controller registers only local commands and uses the bundled script', async () => {
  const state = fixture(true, false, localOptions({localPythonPath: '/local/python', localSourceLabel: '本机'}));
  try {
    assert.deepEqual([...state.commands.keys()], ['status', 'setLanguage', 'configureApprovalHook', 'removeApprovalHook', 'test', 'restart',
      'privacyStatus', 'previewPrivacyCleanup', 'clearPrivateData', 'resumePrivateData']
      .map(name => 'codexNotifier.local.' + name));
    assert.deepEqual(state.outputNames, ['Codex 通知 · 本地采集']);
    assert.equal(state.children.length, 1);
    assert.equal(state.children[0].command, '/local/python');
    assert.ok(state.children[0].args.includes(path.join(state.context.extensionPath, 'scripts', 'collector.py')));
    assert.equal(state.children[0].args.at(-1), state.values.localCodexHome);
    const result = await state.commands.get('codexNotifier.local.status')();
    assert.equal(result.source.label, '本机');
    assert.equal(result.enabled, true);
    state.change('codexHome');
    assert.equal(state.children.length, 1);
    state.values.localCodexHome = path.join(__dirname, 'changed-local-home');
    state.change('localCodexHome');
    assert.equal(state.children.length, 2);
    assert.equal(state.children[1].args.at(-1), state.values.localCodexHome);
    state.values.localCollectorEnabled = false;
    state.change('localCollectorEnabled');
    assert.equal(state.children[1].process.killed, true);
    const denied = await state.commands.get('codexNotifier.local.test')();
    assert.equal(denied.ok, false);
    assert.match(denied.error, /localCollectorEnabled/);
    assert.equal(state.children.length, 2);
  } finally {state.controller.dispose();}
});

test('local collector honors trust before running Python or configuring hooks', async () => {
  const state = fixture(false, true, localOptions());
  try {
    assert.equal(state.children.length, 0);
    const denied = await state.commands.get('codexNotifier.local.configureApprovalHook')();
    assert.equal(denied.ok, false);
    assert.equal(state.children.length, 0);
    state.grant();
    assert.equal(state.children.length, 1);
    const pending = state.commands.get('codexNotifier.local.configureApprovalHook')();
    const action = state.children[1];
    assert.ok(action.args.includes('install'));
    assert.equal(action.args.at(-1), state.values.localCodexHome);
    action.process.stdout.write(JSON.stringify({installed: true}));
    action.process.emit('close', 0);
    assert.equal((await pending).installed, true);
  } finally {state.controller.dispose();}
});

test('local empty windows stay stopped and respond to workspace folder changes', async () => {
  const state = fixture(true, true, {...localOptions(), workspaceFolders: []});
  try {
    assert.equal(state.children.length, 0);
    assert.equal((await state.controller.status()).state, 'stopped');
    assert.equal((await state.commands.get('codexNotifier.local.configureApprovalHook')()).ok, false);
    assert.equal((await state.commands.get('codexNotifier.local.test')()).ok, false);
    assert.equal(state.children.length, 0);
    state.folders([{uri: {fsPath: '/local/workspace'}}]);
    assert.equal(state.children.length, 1);
    state.folders([]);
    assert.equal(state.children[0].process.killed, true);
    assert.equal((await state.controller.status()).state, 'stopped');
  } finally {state.controller.dispose();}
});

test('controller forwards sanitized events and restarts on configured home changes, then shuts down', async () => {
  const state = fixture();
  try {
    state.children[0].process.stdout.write(JSON.stringify(event('hb', 'heartbeat')) + '\n');
    state.children[0].process.stdout.write(JSON.stringify({...event(), prompt: 'PRIVATE'}) + '\n');
    await tick();
    const result = await state.controller.status();
    assert.equal(result.state, 'connected');
    assert.equal(result.hookTrust, 'unknown');
    assert.equal(result.hookConfigured, false);
    const forwarded = state.messages.find(message => message.kind === 'event');
    assert.equal(forwarded.event.id, 'event-1');
    assert.equal(JSON.stringify(forwarded).includes('PRIVATE'), false);
    state.values.codexHome = path.join(__dirname, 'other-unused-home');
    state.change('codexHome');
    assert.equal(state.children[0].process.killed, true);
    assert.equal(state.children.length, 2);
    assert.equal(state.children[1].args.at(-1), state.values.codexHome);
  } finally {state.controller.dispose();}
  assert.equal(state.children[1].process.killed, true);
});

test('explicit hook configuration invokes only install and does not return an approval decision', async () => {
  const state = fixture();
  try {
    const pending = state.commands.get('codexNotifier.remote.configureApprovalHook')();
    const action = state.children[1];
    assert.ok(action.args.includes('install'));
    action.process.stdout.write(JSON.stringify({installed: true, hook_count: 1}));
    action.process.emit('close', 0);
    const result = await pending;
    assert.equal(result.installed, true);
    assert.equal(Object.hasOwn(result, 'decision'), false);
    assert.ok(state.messages.some(message => typeof message === 'string' && message.includes('Trust')));
  } finally {state.controller.dispose();}
});

test('disabled collector does not start and refuses misleading pipeline tests', async () => {
  const state = fixture(true, false);
  try {
    assert.equal(state.children.length, 0);
    const result = await state.commands.get('codexNotifier.remote.test')();
    assert.equal(result.ok, false);
    assert.equal(state.children.length, 0);
  } finally {state.controller.dispose();}
});

test('privacy cleanup stops follow, binds preview token, and stays paused until explicit resume', async () => {
  const state = fixture(true, true, localOptions({localCacheRetentionDays: 3}));
  try {
    const token = 'a'.repeat(64);
    const pending = state.commands.get('codexNotifier.local.clearPrivateData')({previewToken: token});
    await tick();
    await tick();
    assert.equal(state.children[0].process.killed, true);
    assert.equal(state.values.localCollectorEnabled, false);
    assert.equal(state.children.length, 2);
    const action = state.children[1];
    assert.ok(action.args.includes('clear-private-data'));
    assert.equal(action.args.at(-1), token);
    assert.equal(action.args[action.args.indexOf('--retention-days') + 1], '3');
    const concurrent = await state.commands.get('codexNotifier.local.clearPrivateData')({previewToken: token});
    assert.equal(concurrent.ok, false);
    await state.commands.get('codexNotifier.local.restart')();
    assert.equal(state.children.length, 2);
    action.process.stdout.write(JSON.stringify({cleared: true, paused: true, errors: []}));
    action.process.emit('close', 0);
    assert.equal((await pending).cleared, true);
    state.values.localCollectorEnabled = true;
    state.change('localCollectorEnabled');
    await state.commands.get('codexNotifier.local.restart')();
    assert.equal(state.children.length, 2);
    const resumed = state.commands.get('codexNotifier.local.resumePrivateData')();
    await tick();
    const resume = state.children[2];
    assert.ok(resume.args.includes('resume-private-data'));
    resume.process.stdout.write(JSON.stringify({resumed: true, paused: false, resetCutoff: 123}));
    resume.process.emit('close', 0);
    assert.equal((await resumed).resumed, true);
    assert.equal(state.children.length, 4);
    assert.ok(state.children[3].args.includes('follow'));
    assert.equal((await state.controller.status()).privacyPaused, false);
  } finally {state.controller.dispose();}
});

test('privacy preview is read-only and missing tokens or untrusted workspaces cannot clear', async () => {
  const state = fixture();
  try {
    assert.equal((await state.commands.get('codexNotifier.remote.clearPrivateData')()).ok, false);
    assert.equal(state.children.length, 1);
    assert.equal(state.children[0].process.killed, false);
    const pending = state.commands.get('codexNotifier.remote.previewPrivacyCleanup')();
    assert.equal(state.children.length, 2);
    state.children[1].process.stdout.write(JSON.stringify({previewToken: 'a'.repeat(64), files: [], canClear: true}));
    state.children[1].process.emit('close', 0);
    assert.equal((await pending).canClear, true);
    assert.equal(state.children[0].process.killed, false);
    assert.deepEqual(state.updates, []);
  } finally {state.controller.dispose();}
  const untrusted = fixture(false);
  try {
    assert.equal((await untrusted.commands.get('codexNotifier.remote.clearPrivateData')({previewToken: 'a'.repeat(64)})).ok, false);
    assert.equal(untrusted.children.length, 0);
    assert.deepEqual(untrusted.updates, []);
  } finally {untrusted.controller.dispose();}
});

test('persistent privacy pause from another collector blocks automatic restart', async () => {
  const state = fixture();
  try {
    state.children[0].process.stdout.write(JSON.stringify({...event('paused', 'heartbeat'), privacyPaused: true}) + '\n');
    await tick();
    assert.equal((await state.controller.status()).privacyPaused, true);
    assert.equal((await state.controller.status()).state, 'stopped');
    state.change('cacheRetentionDays');
    assert.equal(state.children[0].process.killed, true);
    assert.equal(state.children.length, 1);
  } finally {state.controller.dispose();}
});

test('Language changes translate remote popups, status and logs without restarting collection', async () => {
  const state = fixture(false);
  try {
    assert.match(state.logs[0], /工作区尚未受信任/);
    const choose = state.commands.get('codexNotifier.remote.setLanguage');
    assert.deepEqual(choose('invalid'), {accepted: false});
    assert.deepEqual(choose('en'), {accepted: true, language: 'en'});
    assert.match(state.logs.at(-1), /Collector language updated/);
    const status = await state.controller.status();
    assert.equal(status.state, 'stopped');
    assert.match(status.message, /Workspace is not trusted/);
    const denied = await state.commands.get('codexNotifier.remote.configureApprovalHook')();
    assert.match(denied.error, /Trust this workspace/);
    assert.ok(state.messages.includes(denied.error));
    state.grant();
    assert.equal(state.children.length, 1);
    assert.match(state.logs.at(-1), /Starting Codex event collector/);
    choose('zh-CN');
    assert.equal(state.children.length, 1);
    assert.equal(state.children[0].process.killed, false);
    assert.match((await state.controller.status()).message, /正在启动 Codex/);
    assert.match(state.logs.at(-1), /采集器语言已更新/);
  } finally {state.controller.dispose();}
});
