'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {WindowAttention} = require('../ui/lib/window-attention');
const {TitlePulse} = require('../ui/lib/title-pulse');

const entry = (key = 'source:done', type = 'done') => ({key, event: {type}});
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => {resolve = done;});
  return {promise, resolve};
}

function fixture(t, nativeRequest) {
  const contexts = new Map();
  const commands = [];
  const requests = [];
  const logs = [];
  const timers = new Map();
  let nextTimer = 0;
  let template = '${codexNotification}${separator}${rootName}';
  const vscode = {
    ConfigurationTarget: {Global: 1, Workspace: 2},
    commands: {
      async getCommands() {return ['registerWindowTitleVariable', 'setContext'];},
      async executeCommand(command, ...args) {
        commands.push({command, args});
        if (command === 'setContext') contexts.set(args[0], args[1]);
      },
    },
    workspace: {
      getConfiguration(section) {
        assert.equal(section, 'window');
        return {
          inspect() {return {globalValue: template};},
          get() {return template;},
          async update(key, value) {assert.equal(key, 'title'); template = value;},
        };
      },
    },
  };
  const client = {
    clientId: '11111111-2222-4333-8444-555555555555',
    async request(op, payload) {
      requests.push({op, payload});
      const result = await nativeRequest?.(op, payload, requests);
      if (result !== undefined) return result;
      if (op === 'attentionBind') return {bound: true};
      assert.equal(op, 'attentionUpdate');
      return {bound: true, color: payload.count === 0 ? 'none' : payload.needsDecision ? 'red' : 'yellow',
        title: contexts.get('codexNotifier.windowTitle')};
    },
  };
  const controller = new WindowAttention(vscode, client, {log: message => logs.push(message), testing: true});
  // Exercise the real title/pulse implementations with an explicitly driven
  // clock. These tests never wait for animation intervals or call native APIs.
  controller.pulse.dispose();
  controller.pulse = new TitlePulse(prefix => controller.title.update(prefix), {
    schedule(callback) {const id = ++nextTimer; timers.set(id, callback); return id;},
    cancel(id) {timers.delete(id);},
    onError: error => logs.push(error.message),
  });
  t.after(async () => {controller.dispose(); await controller.title.commandQueue;});
  return {controller, contexts, commands, requests, logs, timers,
    updates: () => requests.filter(request => request.op === 'attentionUpdate'),
    binds: () => requests.filter(request => request.op === 'attentionBind')};
}

test('unread events received while focused flash on blur without repeated polling calls', async t => {
  const f = fixture(t);
  const entries = [entry()];
  await f.controller.update(entries, {focused: true});
  assert.equal(f.binds().length, 1);
  assert.equal(f.updates().length, 1);
  assert.equal(f.updates()[0].payload.flash, false);
  await f.controller.update(entries, {focused: true});
  assert.equal(f.updates().length, 1);

  await f.controller.update(entries, {focused: false});
  assert.equal(f.updates().at(-1).payload.flash, true);
  assert.equal(f.updates().at(-1).payload.count, 1);
  await f.controller.update(entries, {focused: false});
  assert.equal(f.updates().length, 2, 'Unchanged background refreshes must not restart native flashing');

  await f.controller.update(entries, {focused: true});
  await f.controller.update(entries, {focused: false});
  assert.deepEqual(f.updates().map(request => request.payload.flash), [false, true, false, true],
    'A still-unread notification must resume attention after another focus/blur transition');
  assert.equal(f.binds().length, 1);
});

test('a failed native update can retry the same unread state and still request flashing', async t => {
  let attempts = 0;
  const f = fixture(t, op => {
    if (op === 'attentionUpdate' && ++attempts === 1) throw new Error('temporary native failure');
  });
  const entries = [entry('source:question', 'question')];
  await f.controller.update(entries, {focused: false});
  assert.match(f.controller.state.error, /temporary native failure/);
  assert.equal(f.controller.lastSignature, '');
  await f.controller.update(entries, {focused: false});
  assert.equal(attempts, 2);
  assert.deepEqual(f.updates().map(request => request.payload.flash), [true, true]);
  assert.equal(f.updates().at(-1).payload.needsDecision, true);
  assert.equal(f.controller.state.error, undefined);
  assert.equal(f.controller.state.color, 'red');
  await f.controller.update(entries, {focused: false});
  assert.equal(attempts, 2, 'Only successful native updates may establish the unchanged-state cache');
});

test('a lost binding and a broker reset both rebind and restore flashing for existing unread entries', async t => {
  let updates = 0;
  const f = fixture(t, op => {
    if (op === 'attentionUpdate' && ++updates === 1) return {bound: false};
  });
  const entries = [entry()];
  await f.controller.update(entries, {focused: false});
  assert.equal(f.controller.state.bound, false);
  await f.controller.update(entries, {focused: false});
  assert.equal(f.binds().length, 2);
  assert.equal(f.updates().at(-1).payload.flash, true);
  f.controller.reset();
  await f.controller.update(entries, {focused: false});
  assert.equal(f.binds().length, 3);
  assert.equal(f.updates().length, 3);
  assert.equal(f.updates().at(-1).payload.flash, true);
});

test('marking read during binding cancels animation immediately and never submits the stale unread count', async t => {
  const entered = deferred();
  const release = deferred();
  const f = fixture(t, async op => {
    if (op === 'attentionBind') {entered.resolve(); await release.promise;}
  });
  t.after(() => release.resolve());
  const pending = f.controller.update([entry()], {focused: false});
  await entered.promise;
  assert.equal(f.timers.size, 1);
  const read = f.controller.update([]);
  assert.equal(f.timers.size, 0, 'Clearing unread must stop the timer before native discovery finishes');
  release.resolve();
  await Promise.all([pending, read]);
  assert.deepEqual(f.updates().map(request => request.payload), [{count: 0, needsDecision: false, flash: false}]);
  assert.equal(f.contexts.get('codexNotifier.windowTitle'), '');
  assert.equal(f.controller.state.count, 0);
  assert.equal(f.timers.size, 0);
});

test('disabling attention during binding cannot restore a stale title or submit unread state', async t => {
  const entered = deferred();
  const release = deferred();
  const f = fixture(t, async op => {
    if (op === 'attentionBind') {entered.resolve(); await release.promise;}
  });
  t.after(() => release.resolve());
  const entries = [entry()];
  const pending = f.controller.update(entries);
  await entered.promise;
  const disabled = f.controller.update(entries, {enabled: false});
  assert.equal(f.timers.size, 0);
  release.resolve();
  await Promise.all([pending, disabled]);
  assert.deepEqual(f.updates().map(request => request.payload.count), [0]);
  assert.equal(f.contexts.get('codexNotifier.windowTitle'), '');
  assert.equal(f.controller.state.count, 0);
  assert.equal(f.timers.size, 0);
});

test('disabling blinking keeps the unread text, while disabling attention stops even an already queued timer callback', async t => {
  const f = fixture(t);
  const entries = [entry()];
  await f.controller.update(entries);
  const staleFrame = [...f.timers.values()][0];
  assert.equal(typeof staleFrame, 'function');
  await f.controller.update(entries, {blink: false});
  assert.equal(f.contexts.get('codexNotifier.windowTitle'), '🟡 本轮已回复 1');
  assert.equal(f.timers.size, 0);
  assert.equal(f.updates().length, 1, 'Animation settings must not emit another native request');
  staleFrame();
  await settle();
  assert.equal(f.contexts.get('codexNotifier.windowTitle'), '🟡 本轮已回复 1');
  assert.equal(f.timers.size, 0);

  await f.controller.update(entries, {enabled: false});
  assert.equal(f.contexts.get('codexNotifier.windowTitle'), '');
  assert.equal(f.updates().at(-1).payload.count, 0);
  await f.controller.update(entries, {enabled: true});
  assert.equal(f.timers.size, 1);
  assert.equal(f.updates().at(-1).payload.flash, true);
});

test('disposing during binding stops animation and blocks late native updates or queued title frames', async t => {
  const entered = deferred();
  const release = deferred();
  const f = fixture(t, async op => {
    if (op === 'attentionBind') {entered.resolve(); await release.promise;}
  });
  t.after(() => release.resolve());
  const pending = f.controller.update([entry()]);
  await entered.promise;
  const staleFrame = [...f.timers.values()][0];
  f.controller.dispose();
  assert.equal(f.timers.size, 0);
  release.resolve();
  await pending;
  staleFrame();
  await settle();
  await f.controller.update([entry('source:later')]);
  await f.controller.title.commandQueue;
  assert.equal(f.contexts.get('codexNotifier.windowTitle'), '');
  assert.equal(f.timers.size, 0);
  assert.equal(f.updates().length, 0);
});
