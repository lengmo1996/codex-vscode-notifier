'use strict';

// Run by the real VS Code extension-test host. Uses only Node and vscode APIs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const UI_ID = 'lengmo1996.codex-notifier-ui';
const REMOTE_ID = 'lengmo1996.codex-notifier-collector';
const REQUIRED = ['testNotification', 'showHistory', 'pause', 'resume',
  'configureApprovalHook', 'showStatus', 'internal.receive', 'internal.snapshot',
  'privacy', 'clearPrivateData', 'clearLocalPrivateData', 'resumePrivateData', 'checkInstallation', 'chooseLanguage'];

async function waitFor(operation, predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let current;
  while (Date.now() < deadline) {
    current = await operation();
    if (predicate(current)) return current;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`${description}; last value: ${JSON.stringify(current).slice(0, 1600)}`);
}

const command = (name, ...args) => vscode.commands.executeCommand(`codexNotifier.${name}`, ...args);
const snapshot = () => command('internal.snapshot');
const history = value => value.history || value.entries;
const accepted = receipt => receipt === true || !!(receipt && receipt.accepted);

exports.run = async function run() {
  assert.equal(process.env.CODEX_NOTIFIER_TEST_MODE, '1',
    'Set CODEX_NOTIFIER_TEST_MODE=1 to disable native notification side effects');
  const testHome = process.env.CODEX_NOTIFIER_TEST_HOME;
  const fixturePath = process.env.CODEX_NOTIFIER_TEST_ROLLOUT;
  assert.ok(testHome && fixturePath, 'Run packaging/prepare-host-test.py first and pass its environment');
  assert.equal(path.resolve(vscode.workspace.getConfiguration('codexNotifier').get('localCodexHome', '')),
    path.resolve(testHome), 'The isolated user-data settings must be written before VS Code starts');
  assert.ok(path.resolve(fixturePath).startsWith(path.resolve(testHome) + path.sep));
  assert.ok(fs.existsSync(path.join(testHome, '.codex-notifier-extension-test')),
    'Refuse to test hooks in a directory without the test-only marker');

  const results = [];
  async function test(name, operation) {
    await operation();
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  }

  try {
    await test('Local UI activates its embedded collector while Remote stays idle locally', async () => {
      for (const id of [UI_ID, REMOTE_ID]) {
        const extension = vscode.extensions.getExtension(id);
        assert.ok(extension, `Missing development extension ${id}`);
        await extension.activate();
        assert.ok(extension.isActive, `${id} did not activate`);
      }
      const registered = new Set(await vscode.commands.getCommands(true));
      for (const name of REQUIRED) assert.ok(registered.has(`codexNotifier.${name}`), `Missing command ${name}`);
      assert.ok(registered.has('codexNotifier.local.status'));
      assert.equal(registered.has('codexNotifier.remote.status'), false, 'Remote must not register its collector locally');
      assert.deepEqual(vscode.extensions.getExtension(UI_ID).packageJSON.extensionPack, [REMOTE_ID]);
      const installation = await command('checkInstallation');
      assert.equal(installation.remote, false);
      assert.equal(installation.state, 'available');
      const config = vscode.workspace.getConfiguration('codexNotifier');
      assert.equal(config.get('autoReadOnWindowFocus'), false, 'Window-wide auto-read must be off by default');
      assert.equal(config.get('openLocation'), 'sidebar', 'Sidebar must be the default open location');
    });

    const source = { id: `host-suite-${Date.now()}`, label: 'Host test fixture', host: 'test-host',
      home: testHome, cwd: path.join(testHome, 'fixture-project') };
    const prefix = `host-event-${Date.now()}`;
    const samples = ['done', 'approval', 'question'].map((type, index) => ({
      version: 1, kind: 'event', source,
      event: { version: 1, originator: 'codex_vscode', type, id: `${prefix}-${index}`, timestamp: Date.now() / 1000,
        host: source.host, label: source.label, cwd: source.cwd,
        session_id: 'bfa8ee7e-d7c8-40b6-ac84-f3de88888888', turn_id: `${prefix}-turn-${index}` }
    }));

    await test('Done, approval and question events reach persistent history', async () => {
      await command('resume');
      for (const payload of samples) assert.ok(accepted(await command('internal.receive', payload)));
      const value = await waitFor(snapshot,
        s => history(s).filter(item => item.event.id.startsWith(prefix)).length === 3,
        'All three event types should appear');
      for (const payload of samples) {
        const item = history(value).find(entry => entry.event.id === payload.event.id);
        assert.equal(item.event.type, payload.event.type);
        assert.equal(item.source.id, source.id);
      }
      assert.ok(value.unread >= 3, 'Unread indicator should count the three incoming events');
    });

    await test('Language switches live in the real UI and collector without changing unread state or process', async () => {
      const settings = vscode.workspace.getConfiguration('codexNotifier');
      assert.equal(settings.get('language'), 'zh-CN');
      const before = await snapshot();
      const initial = await command('local.status');
      try {
        await settings.update('language', 'en', vscode.ConfigurationTarget.Global);
        const english = await waitFor(snapshot, s => s.language === 'en' && s.groups.every(group => !/[\u3400-\u9fff]/u.test(group.title)), 'History should render in English');
        assert.deepEqual(history(english).map(item => [item.key, item.read]), history(before).map(item => [item.key, item.read]));
        const collector = await waitFor(() => command('local.status'), s => /Collector|Starting/.test(s.message), 'Collector should render English status');
        assert.equal(collector.collectorPid, initial.collectorPid);
        assert.equal(english.unread, before.unread);
        assert.ok(english.statusText.includes('Other windows'));
      } finally {await settings.update('language', 'zh-CN', vscode.ConfigurationTarget.Global);}
      await waitFor(snapshot, s => s.language === 'zh-CN' && s.groups.some(group => /待处理/.test(group.title)), 'History should return to Chinese');
    });

    await test('Replayed event is acknowledged without duplicating history or unread count', async () => {
      const before = await snapshot();
      const receipt = await command('internal.receive', samples[0]);
      assert.ok(accepted(receipt));
      const after = await snapshot();
      assert.equal(history(after).filter(item => item.event.id === samples[0].event.id).length, 1);
      assert.equal(history(after).length, history(before).length);
      assert.equal(after.unread, before.unread);
    });

    await test('Pause retains incoming history and resume restores delivery state', async () => {
      await command('pause');
      assert.equal((await snapshot()).paused, true);
      const payload = JSON.parse(JSON.stringify(samples[0]));
      payload.event.id = `${prefix}-paused`;
      assert.ok(accepted(await command('internal.receive', payload)));
      assert.ok(history(await snapshot()).some(item => item.event.id === payload.event.id));
      await command('resume');
      assert.equal((await snapshot()).paused, false);
    });

    await test('Public test and status commands run without native UI in test mode', async () => {
      await command('testNotification');
      await command('showStatus');
    });

    await test('Approval hook installer preserves unrelated hooks in isolated Codex home', async () => {
      const hooksPath = path.join(testHome, 'hooks.json');
      const before = JSON.stringify(JSON.parse(fs.readFileSync(hooksPath, 'utf8')));
      assert.ok(before.includes('codex-notifier-unrelated-fixture'));
      await command('configureApprovalHook');
      const installed = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
      assert.ok(JSON.stringify(installed).includes('codex-notifier-unrelated-fixture'));
      assert.notEqual(JSON.stringify(installed), before, 'Installer should append its own hook');
      const first = JSON.stringify(installed);
      await command('configureApprovalHook');
      assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(hooksPath, 'utf8'))), first,
        'Repeated installation should not duplicate hooks');
      const status = await command('local.status');
      assert.equal(path.resolve(status.codexHome), path.resolve(testHome));
      assert.equal(status.hookConfigured, true);
    });

    await test('Embedded local collector test event crosses the extension command bridge', async () => {
      const beforeKeys = new Set(history(await snapshot()).map(item => item.key));
      await command('local.test');
      await waitFor(snapshot, s => history(s).some(item => item.event.type === 'test' &&
        !beforeKeys.has(item.key) && item.source.id !== source.id),
      'Remote Python follower should deliver its spooled test event', 30000);
    });

    await test('Embedded local collector detects VS Code completion and question rollout records', async () => {
      const sessionId = process.env.CODEX_NOTIFIER_TEST_SESSION;
      assert.ok(sessionId, 'Fixture session ID is required');
      const stamp = new Date().toISOString();
      const records = [
        { timestamp: stamp, type: 'event_msg', payload: { type: 'task_complete',
          turn_id: `${prefix}-collector-turn`, last_agent_message: 'PRIVATE_FIXTURE_RESPONSE_MUST_NOT_BE_FORWARDED' } },
        { timestamp: stamp, type: 'response_item', payload: { type: 'function_call',
          name: 'request_user_input', call_id: `${prefix}-collector-question`,
          arguments: JSON.stringify({ questions: [{ question: 'PRIVATE_FIXTURE_QUESTION_MUST_NOT_BE_FORWARDED' }] }) } }
      ];
      const appId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const appPath = path.join(path.dirname(fixturePath), 'rollout-desktop-' + appId + '.jsonl');
      fs.writeFileSync(appPath, [
        {timestamp: stamp, type: 'session_meta', payload: {id: appId, cwd: vscode.workspace.workspaceFolders[0].uri.fsPath,
          source: 'vscode', originator: 'codex_work_desktop'}}, ...records,
      ].map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8');
      fs.appendFileSync(fixturePath, records.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8');
      await command('local.restart');
      const value = await waitFor(snapshot, s => {
        const types = new Set(history(s).filter(item => item.event.session_id === sessionId).map(item => item.event.type));
        return types.has('done') && types.has('question');
      }, 'Collector should forward completion and question metadata', 90000);
      const entries = history(value).filter(item => item.event.session_id === sessionId);
      assert.ok(!JSON.stringify(entries).includes('PRIVATE_FIXTURE_'), 'Conversation contents must stay on the source');
      assert.equal(history(value).some(item => item.event.session_id === appId), false,
        'Desktop-origin sessions in the same home and workspace must stay out of notifications');
    });

    await test('App and older unclassified collector events are silently ignored at the broker boundary', async () => {
      const before = history(await snapshot()).length;
      for (const originator of ['codex_work_desktop', undefined]) {
        const receipt = await command('internal.receive', {...samples[0], event: {...samples[0].event,
          id: prefix + '-blocked-' + (originator || 'old'), originator}});
        assert.equal(receipt.accepted, true);
        assert.equal(receipt.ignored, true);
      }
      assert.equal(history(await snapshot()).length, before);
    });

    await test('History view command opens successfully', async () => {
      await command('showHistory');
      assert.ok(Array.isArray(history(await snapshot())));
    });

    await test('Unread groups and attention are scoped to the actual destination window', async () => {
      const value = await snapshot();
      const actual = history(value).filter(item => item.event.session_id === process.env.CODEX_NOTIFIER_TEST_SESSION);
      assert.ok(actual.length >= 2);
      assert.ok(actual.every(item => item.targetWindowId === value.windowId));
      assert.ok(value.localUnread >= 2);
      assert.ok(value.groups.some(group => group.id === 'current-unread' && group.count >= 2));
      assert.equal(value.statusColor, 'statusBarItem.errorBackground');
    });

    await test('Default sidebar navigation reads only the clicked reminder and creates no editor tabs', async () => {
      const before = await snapshot();
      const entry = history(before).find(item => !item.read && item.event.session_id === process.env.CODEX_NOTIFIER_TEST_SESSION && item.event.type === 'done');
      assert.ok(entry);
      const otherUnread = history(before).filter(item => !item.read && item.key !== entry.key).map(item => item.key);
      assert.ok(otherUnread.length >= 2);
      const beforeTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).length;
      const result = await command('showEntry', entry.key);
      assert.equal(result.routed, true);
      const after = await waitFor(snapshot, value => value.lastNavigation?.method === 'sidebar' &&
        history(value).find(item => item.key === entry.key)?.read, 'Sidebar request should read only its notification');
      if (process.env.CODEX_NOTIFIER_TEST_EDITOR === '1') {
        const received = await waitFor(() => vscode.commands.executeCommand('codexRouteFixture.sidebarSnapshot'),
          value => value?.uri?.endsWith('/local/' + entry.event.session_id), 'Real URI handler must receive sidebar route');
        assert.equal(received.workspace, vscode.workspace.workspaceFolders[0].uri.toString());
        assert.equal(received.visible, true);
        assert.equal(vscode.Uri.parse(received.uri).query, '', 'Sidebar route must avoid windowId prefix collisions');
      }
      assert.equal(vscode.window.tabGroups.all.flatMap(group => group.tabs).length, beforeTabs);
      for (const key of otherUnread) assert.equal(history(after).find(item => item.key === key)?.read, false);
    });

    await test('The editor setting opens the exact session and leaves other reminders unread', async () => {
      await vscode.workspace.getConfiguration('codexNotifier').update('openLocation', 'editor', vscode.ConfigurationTarget.Global);
      const before = await snapshot();
      const entry = history(before).find(item => item.event.session_id === process.env.CODEX_NOTIFIER_TEST_SESSION && item.event.type === 'question');
      assert.ok(entry);
      const result = await command('showEntry', entry.key);
      assert.equal(result.routed, true);
      const after = await waitFor(snapshot, value => value.lastNavigation?.sessionId === entry.event.session_id &&
        history(value).find(item => item.key === entry.key)?.read,
        'The destination window should resolve the specific session URI');
      const actual = process.env.CODEX_NOTIFIER_TEST_EDITOR === '1';
      const fixture = actual ? await vscode.commands.executeCommand('codexRouteFixture.snapshot') : null;
      if (actual) {
        assert.ok(fixture, 'The real VS Code custom-editor provider must receive the command');
        assert.equal(fixture.workspace, vscode.workspace.workspaceFolders[0].uri.toString());
        assert.equal(fixture.viewType, 'chatgpt.conversationEditor');
        assert.equal(after.lastNavigation.requested, true);
        const opened = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab =>
          tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === fixture.uri &&
          tab.input.viewType === 'chatgpt.conversationEditor');
        assert.ok(opened, 'The destination window must contain the requested Codex custom-editor tab');
        assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab, opened,
          'The requested conversation tab must be selected');
      }
      const uri = vscode.Uri.parse(actual ? fixture.uri : after.lastNavigation.uri);
      assert.equal(uri.scheme, 'openai-codex');
      assert.equal(uri.authority, 'route');
      assert.equal(uri.path, '/local/' + entry.event.session_id);
      assert.equal(uri.query, '', 'The editor route must not go through windowId-based global URL routing');
      assert.equal(history(after).find(item => item.key === entry.key).read, true);
      assert.ok(after.groups.some(group => group.id === 'read'));
      assert.equal(!!after.lastNavigation.previewOnly, !actual);
      for (const other of history(before).filter(item => !item.read && item.key !== entry.key)) {
        assert.equal(history(after).find(item => item.key === other.key)?.read, false);
      }
      await vscode.workspace.getConfiguration('codexNotifier').update('openLocation', 'sidebar', vscode.ConfigurationTarget.Global);
    });

    await test('Mark all read preserves history and clears unread indicator', async () => {
      const before = history(await snapshot()).map(item => item.key).sort();
      await command('markRead');
      const after = await snapshot();
      assert.equal(after.unread, 0);
      assert.equal(after.localUnread, 0);
      assert.equal(after.statusColor, undefined);
      assert.deepEqual(history(after).map(item => item.key).sort(), before);
    });

    await test('A failed destination navigation preserves unread state', async () => {
      const realSource = (await command('local.status')).source;
      await command('internal.receive', {version: 1, kind: 'event', source: realSource, event: {
        version: 1, originator: 'codex_vscode', type: 'done', id: prefix + '-invalid-navigation', timestamp: Date.now() / 1000,
        cwd: realSource.cwd, session_id: 'not-a-codex-session', turn_id: prefix + '-invalid-navigation',
        host: realSource.host, label: realSource.label}});
      const before = await snapshot();
      const entry = history(before).find(item => item.event.id === prefix + '-invalid-navigation');
      assert.ok(entry);
      await command('showEntry', entry.key);
      const after = await waitFor(snapshot, value => value.lastNavigationFailure?.key === entry.key, 'The destination must report navigation failure');
      assert.equal(history(after).find(item => item.key === entry.key).read, false);
      assert.equal(after.localUnread, 1);
    });

    await test('Window title variable and native taskbar target track pending state', async () => {
      const native = process.env.CODEX_NOTIFIER_ATTENTION_TEST === '1';
      const value = await waitFor(snapshot, s => s.windowAttention.ready && s.windowAttention.prefix.includes('本轮已回复') &&
        (!native || s.windowAttention.bound && s.windowAttention.color === 'yellow'), 'Title and optional native taskbar must be updated', 30000);
      assert.equal(value.windowAttention.count, 1);
      assert.ok(vscode.workspace.getConfiguration('window').get('title').includes('${codexNotification}'));
      const first = value.windowAttention.displayPrefix;
      const other = await waitFor(snapshot, s => s.windowAttention.displayPrefix && s.windowAttention.displayPrefix !== first,
        'Unread title should alternate its visible dot', 5000);
      assert.ok(other.windowAttention.displayPrefix.includes('本轮已回复 1'));
      await waitFor(snapshot, s => s.windowAttention.displayPrefix === first, 'Title should continue pulsing without another notification', 5000);
      await command('markRead');
      await waitFor(snapshot, s => s.windowAttention.prefix === '' && s.windowAttention.displayPrefix === '' &&
        (!native || s.windowAttention.color === 'none'), 'Read must clear the native indicator');
      await new Promise(resolve => setTimeout(resolve, 1800));
      assert.equal((await snapshot()).windowAttention.displayPrefix, '');
    });

    await test('Single deletion and clear-read remove history without losing pending reminders or replaying deleted events', async () => {
      const before = await snapshot();
      const selected = history(before).find(item => item.read && item.event.id === samples[0].event.id);
      assert.ok(selected);
      assert.equal((await command('deleteEntry', selected.key)).deleted, 1);
      assert.equal(history(await snapshot()).some(item => item.key === selected.key), false);
      assert.equal((await command('internal.receive', samples[0])).duplicate, true);
      const source = (await command('local.status')).source;
      const payload = {version: 1, kind: 'event', source, event: {...samples[0].event,
        id: prefix + '-pending-after-clear-read', cwd: source.cwd}};
      await command('internal.receive', payload);
      await command('clearRead');
      const after = await snapshot();
      assert.equal(after.unread, 1);
      assert.equal(history(after).length, 1);
      assert.equal(history(after)[0].event.id, payload.event.id);
      await command('clearHistory');
      assert.equal(history(await snapshot()).length, 0);
    });

    await test('Privacy cleanup uses the isolated collector, preserves original data and resumes only explicitly', async () => {
      const settings = vscode.workspace.getConfiguration('codexNotifier');
      assert.equal(settings.get('soundOnDone'), true);
      assert.equal(settings.get('historyRetentionDays'), 7);
      assert.equal(settings.get('localCacheRetentionDays'), 7);
      const originalSession = fs.readFileSync(fixturePath);
      const originalHooks = JSON.parse(fs.readFileSync(path.join(testHome, 'hooks.json'), 'utf8'));
      const unrelated = originalHooks.hooks.PermissionRequest.filter(group => group.hooks.some(hook => hook.command === 'echo codex-notifier-unrelated-fixture'));
      assert.equal(unrelated.length, 1);
      const preview = await command('local.previewPrivacyCleanup');
      assert.equal(preview.canClear, true);
      assert.match(preview.previewToken, /^[a-f0-9]{64}$/);
      const result = await command('local.clearPrivateData', {previewToken: preview.previewToken});
      assert.equal(result.cleared, true, JSON.stringify(result));
      assert.equal(result.paused, true);
      assert.deepEqual(fs.readFileSync(fixturePath), originalSession);
      assert.equal(result.managedHookRemoved, true);
      const remaining = JSON.parse(fs.readFileSync(path.join(testHome, 'hooks.json'), 'utf8'));
      assert.deepEqual(remaining.hooks.PermissionRequest, unrelated, 'Cleanup removes its own hook and preserves unrelated hooks');
      const paused = await command('local.privacyStatus');
      assert.equal(paused.paused, true);
      assert.equal((await command('local.resumePrivateData')).resumed, true);
      assert.equal((await command('local.privacyStatus')).paused, false);
    });

    const report = { passed: results.length, failed: 0, results,
      vscodeVersion: vscode.version, ui: UI_ID, remote: REMOTE_ID,
      nativeAttention: process.env.CODEX_NOTIFIER_ATTENTION_TEST === '1',
      actualEditorCommand: process.env.CODEX_NOTIFIER_TEST_EDITOR === '1',
      scope: 'Real local VS Code extension host with isolated fixtures. Editor command reaches a real custom-editor provider when actualEditorCommand=true; no user conversation or SSH backend is resumed.' };
    if (process.env.CODEX_NOTIFIER_TEST_REPORT) {
      fs.writeFileSync(process.env.CODEX_NOTIFIER_TEST_REPORT, JSON.stringify(report, null, 2) + '\n');
    }
    console.log(JSON.stringify(report));
    if (process.env.CODEX_NOTIFIER_VISUAL_REVIEW === '1') {
      const realSource = (await command('local.status')).source;
      for (const [index, type] of ['done'].entries()) {
        await command('internal.receive', {version: 1, kind: 'event', source: realSource, event: {
          version: 1, originator: 'codex_vscode', type, id: 'visual-' + Date.now() + '-' + index, timestamp: Date.now() / 1000,
          cwd: realSource.cwd, session_id: process.env.CODEX_NOTIFIER_TEST_SESSION, turn_id: 'visual-turn-' + index,
          host: realSource.host, label: realSource.label}});
      }
      await command('showHistory');
      await vscode.commands.executeCommand('workbench.action.closePanel');
      fs.writeFileSync(path.join(path.dirname(process.env.CODEX_NOTIFIER_TEST_REPORT), 'visual-ready'), 'ready');
      const release = path.join(path.dirname(process.env.CODEX_NOTIFIER_TEST_REPORT), 'visual-done');
      const deadline = Date.now() + 120000;
      while (!fs.existsSync(release) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
    }
  } catch (error) {
    if (process.env.CODEX_NOTIFIER_TEST_REPORT) {
      fs.writeFileSync(process.env.CODEX_NOTIFIER_TEST_REPORT, JSON.stringify({
        passed: results.length, failed: 1, results, error: error.stack || String(error),
        vscodeVersion: vscode.version
      }, null, 2) + '\n');
    }
    throw error;
  }
};
