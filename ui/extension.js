'use strict';
const {t, getLanguage, configureLanguage, renderMessage, diagnostic} = require('./lib/i18n');
const vscode = require('vscode');
const path = require('node:path');
const {BrokerClient} = require('./lib/client');
const {clean, projectName, eventTitle, notificationOptions, validEnvelope, attention, showWindowAlert} = require('./lib/presentation');
const {HistoryView} = require('./lib/history');
const {openCodexSession} = require('./lib/navigation');
const {WindowAttention} = require('./lib/window-attention');
const {ReadTracker} = require('./lib/read-tracking');
const {PrivacyActions} = require('./lib/privacy');
const {inspectInstallation, showInstallation} = require('./lib/installation');
const TESTING = process.env.CODEX_NOTIFIER_TEST_MODE === '1';
let current;

async function activate(context) {
  configureLanguage(() => vscode.workspace.getConfiguration('codexNotifier').get('language', 'zh-CN'));
  const output = vscode.window.createOutputChannel(t('Codex 会话通知'));
  const client = new BrokerClient(context.globalStorageUri.fsPath, path.join(context.extensionPath, 'lib', 'broker.js'));
  const history = new HistoryView(vscode, client.clientId);
  const view = vscode.window.createTreeView('codexNotifier.history', {treeDataProvider: history, showCollapseAll: false});
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBar.command = 'codexNotifier.openNext';
  let snapshot = {entries: [], unread: 0};
  let sourceStatus = null;
  let installationState = null;
  let installationTimer;
  let refreshPromise = null;
  let refreshAgain = false;
  let disposed = false;
  let lastFailureAt = 0;
  let lastRegistration = '';
  let lastNavigation = null;
  let lastNavigationFailure = null;
  let opening = Promise.resolve();
  let privacyGeneration = 0;
  let navigating = false;
  const outdatedSources = new Set();
  const config = () => vscode.workspace.getConfiguration('codexNotifier');
  const log = message => output.appendLine(`${new Date().toLocaleTimeString(getLanguage())} ${diagnostic(message)}`);
  const windowAttention = new WindowAttention(vscode, client, {log, testing: TESTING});
  function windowInfo() {
    const folders = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri);
    const folder = folders[0];
    const paths = folders.map(uri => uri.scheme === 'file' ? uri.fsPath : uri.path);
    const cwd = paths[0] || sourceStatus?.source?.cwd || '';
    const project = vscode.workspace.name || (cwd ? projectName(cwd) : t('空窗口'));
    const environment = sourceStatus?.source?.label || vscode.env.remoteName || t('本机');
    const policy = Object.fromEntries(['notificationsEnabled', 'desktopNotifications', 'sound', 'soundOnDone', 'desktopOnDone', 'notifyOnDone', 'notifyOnApproval', 'notifyOnQuestion', 'onlyWhenUnfocused']
      .map(key => [key, config().get(key, !['onlyWhenUnfocused', 'desktopOnDone'].includes(key))]));
    return {id: client.clientId, label: clean(`${project} · ${environment}`, 200),
      sourceId: sourceStatus?.source?.id || '', workspaceUri: (vscode.workspace.workspaceFile || folder)?.toString() || '',
      workspaceCwd: cwd, workspaceCwds: paths, focused: vscode.window.state.focused, routeUri: '', policy, language: getLanguage()};
  }
  async function syncWindow() {
    if (disposed) return;
    const info = windowInfo();
    const signature = JSON.stringify(info);
    if (signature === lastRegistration) return;
    lastRegistration = signature;
    try {
      // Synchronize the current window's remote host without restarting collection.
      await remoteCommand('codexNotifier.remote.setLanguage', getLanguage()).catch(() => {});
      await client.request('retention', {days: config().get('historyRetentionDays', 7)});
      await client.request('window', {window: info});
    }
    catch (error) { lastRegistration = ''; throw error; }
  }
  function updateBadge() {
    const paused = snapshot.privacyPaused || !config().get('notificationsEnabled', true);
    const collectorError = sourceStatus?.status?.state === 'error';
    const pending = attention(snapshot.entries || [], client.clientId);
    const localCount = pending.local.length;
    windowAttention.update(pending.local, {enabled: config().get('taskbarAttention', true), focused: vscode.window.state.focused,
      blink: config().get('blinkWindowTitle', true)});
    statusBar.command = collectorError && !localCount ? 'codexNotifier.showStatus' : 'codexNotifier.openNext';
    const icon = collectorError ? 'warning' : paused ? 'bell-slash' : localCount ? 'bell-dot' : 'bell';
    const project = vscode.workspace.name || projectName(sourceStatus?.source?.cwd || '');
    statusBar.text = `$(${icon}) Codex${localCount ? t` · ${clean(project, 24)} · ${localCount} 待处理` : snapshot.unread ? t` · 其他窗口 ${snapshot.unread}` : ''}`;
    statusBar.backgroundColor = collectorError || localCount ? new vscode.ThemeColor(
      pending.needsDecision ? 'statusBarItem.errorBackground' : 'statusBarItem.warningBackground') : undefined;
    statusBar.tooltip = t`${windowInfo().label}\n本窗口 ${localCount} 条待处理，所有窗口共 ${snapshot.unread} 条未读\n点击打开下一条待处理会话`;
    if (paused) statusBar.tooltip += t('\n声音和弹窗已暂停，仍记录历史');
    if (snapshot.privacyPaused) {
      statusBar.tooltip = t`${windowInfo().label}\n隐私清理后已暂停接收，不记录新通知。点击通知菜单 → 隐私与数据清理 → 恢复。`;
      statusBar.text = t('$(shield) Codex · 接收已暂停');
      statusBar.command = 'codexNotifier.privacy';
    }
    if (collectorError) statusBar.tooltip += localCount ? t('\n当前远端采集异常；可从通知菜单查看状态') : t('\n当前远端采集异常，点击查看状态');
    view.badge = localCount ? {value: localCount, tooltip: t`本窗口 ${localCount} 条待处理通知`} : undefined;
    view.description = t`本窗口 ${localCount} · 全部 ${snapshot.unread}`;
    view.message = snapshot.entries?.length ? undefined : t('新提醒会出现在这里。单击将静默打开对应会话；跳转请求被接受后标为已读。');
    if (installationState?.state === 'missing' && !sourceStatus) {
      view.message = t('当前 SSH／容器尚未连接采集组件。打开通知菜单 → 检查／安装当前环境组件。');
      if (!localCount && !snapshot.privacyPaused) {
        statusBar.text = t('$(extensions) Codex · 需安装远端组件');
        statusBar.command = 'codexNotifier.checkInstallation';
        statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusBar.tooltip = t('点击检查并安装当前 SSH／容器的采集组件。');
      }
    }
    statusBar.show();
  }
  async function refresh() {
    if (disposed) return snapshot;
    if (refreshPromise) { refreshAgain = true; return refreshPromise; }
    refreshPromise = (async () => {
      snapshot = await client.request('history');
      if (!disposed) { history.update(snapshot.entries || []); updateBadge(); }
      return snapshot;
    })();
    try { return await refreshPromise; } finally {
      refreshPromise = null;
      if (refreshAgain && !disposed) { refreshAgain = false; refresh().catch(error => log(error.message)); }
    }
  }
  async function failure(message) {
    message = diagnostic(message);
    log(message);
    if (!TESTING && Date.now() - lastFailureAt > 60000) {
      lastFailureAt = Date.now();
      const action = await vscode.window.showWarningMessage(message, t('查看日志'));
      if (action) output.show(true);
    }
  }
  async function remoteCommand(command, ...args) {
    try { return await vscode.commands.executeCommand(vscode.env.remoteName ? command : command.replace('codexNotifier.remote.', 'codexNotifier.local.'), ...args); }
    catch (error) {
      throw new Error((vscode.env.remoteName ? t('当前环境的远端采集组件不可用。请从通知菜单选择“检查／安装当前环境组件”。') :
        t('本地采集器尚未就绪。请打开受信任的本地文件夹，并检查本机 Python 和 Codex Home 设置。')) +
        (TESTING ? ` (${error.message})` : ''));
    }
  }
  const register = (command, fn) => context.subscriptions.push(vscode.commands.registerCommand(command, async (...args) => {
    try { return await fn(...args); } catch (error) { await failure(error.message); if (TESTING) throw error; return {accepted: false, error: error.message}; }
  }));
  async function checkInstallation() {
    const result = await inspectInstallation(vscode);
    if (!disposed) { installationState = result; updateBadge(); }
    return result;
  }
  register('codexNotifier.checkInstallation', async () => {
    const result = await checkInstallation();
    return TESTING ? result : showInstallation(vscode, result);
  });

  register('codexNotifier.internal.receive', async payload => {
    if (!validEnvelope(payload)) return {accepted: false, error: 'Invalid event envelope'};
    if (payload.kind === 'status') {
      sourceStatus = {...payload, status: {...payload.status, message: renderMessage(payload.status.messageSpec, getLanguage(), payload.status.message)}};
      installationState = {state: 'available', remote: !!vscode.env.remoteName};
      await syncWindow();
      updateBadge();
      if (payload.status.state === 'error') failure(`${clean(payload.source.label)}：${clean(sourceStatus.status.message, 1000)}`).catch(() => {});
      return {accepted: true};
    }
    await syncWindow();
    const options = notificationOptions(config(), vscode.window.state.focused, payload.event.type);
    const receipt = await client.request('event', {source: payload.source, event: payload.event, options});
    if (receipt.ignored && !payload.event.originator && !outdatedSources.has(payload.source.id)) {
      outdatedSources.add(payload.source.id);
      log(t`${clean(payload.source.label)}：旧采集器没有会话来源标识，已忽略此类提醒。请升级远端采集组件至 0.2.0，并在任务空闲后重载对应窗口。`);
    }
    await refresh();
    return receipt;
  });
  register('codexNotifier.internal.snapshot', async () => {
    const data = await refresh();
    return {...data, history: data.entries || [], paused: data.privacyPaused || !config().get('notificationsEnabled', true), status: sourceStatus,
      windowId: client.clientId, localUnread: attention(data.entries || [], client.clientId).local.length,
      windowAttention: {...windowAttention.state},
      ...(TESTING ? {lastNavigation, lastNavigationFailure, language: getLanguage(), groups: history.groups.map(group => ({id: group.id, title: group.title, count: group.entries.length})), statusText: statusBar.text,
        statusColor: statusBar.backgroundColor?.id} : {})};
  });
  register('codexNotifier.testNotification', async () => {
    const source = {id: `test-${vscode.env.machineId}`, label: t('Windows 本机测试'), host: t('本机'), home: '', cwd: ''};
    const receipt = await client.request('test', {source, options: {desktop: true, sound: config().get('sound', true)}});
    await refresh();
    log(t('已提交一条本机测试通知；是否可见可听取决于 Windows 通知和音量设置。'));
    return receipt;
  });
  register('codexNotifier.pause', async () => { await config().update('notificationsEnabled', false, vscode.ConfigurationTarget.Global); updateBadge(); return {paused: true}; });
  register('codexNotifier.resume', async () => { await config().update('notificationsEnabled', true, vscode.ConfigurationTarget.Global); updateBadge(); return {paused: false}; });
  register('codexNotifier.showHistory', async () => { await client.request('interact'); await refresh(); await vscode.commands.executeCommand('codexNotifier.history.focus'); });
  register('codexNotifier.markRead', async () => { await client.request('markRead'); await refresh(); });
  register('codexNotifier.clearRead', async () => { const result = await client.request('clearRead'); await refresh(); return result; });
  register('codexNotifier.deleteEntry', async value => {
    const key = typeof value === 'string' ? value : value?.key;
    if (!key) return;
    const result = await client.request('deleteEntry', {key});
    await refresh();
    return result;
  });
  register('codexNotifier.clearHistory', async () => { await client.request('clear'); await refresh(); });
  register('codexNotifier.configureApprovalHook', () => remoteCommand('codexNotifier.remote.configureApprovalHook'));
  register('codexNotifier.removeApprovalHook', () => remoteCommand('codexNotifier.remote.removeApprovalHook'));
  register('codexNotifier.settings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'codexNotifier'));
  register('codexNotifier.chooseLanguage', async () => {
    const selected = await vscode.window.showQuickPick([
      {label: '中文', description: '默认 / Default', value: 'zh-CN'},
      {label: 'English', value: 'en'},
    ], {title: '通知语言 / Notification language', placeHolder: '中文 / English'});
    if (selected) await config().update('language', selected.value, vscode.ConfigurationTarget.Global);
  });
  register('codexNotifier.chooseOpenLocation', async () => {
    const currentLocation = config().get('openLocation', 'sidebar');
    const selected = await vscode.window.showQuickPick([
      {label: t('Codex 插件会话侧栏'), description: currentLocation === 'sidebar' ? t('当前选择 · 默认') : t('默认'), value: 'sidebar'},
      {label: t('中间主编辑器区域'), description: currentLocation === 'editor' ? t('当前选择') : '', value: 'editor'},
    ], {title: t('点击通知后在哪里打开会话')});
    if (selected) await config().update('openLocation', selected.value, vscode.ConfigurationTarget.Global);
  });
  register('codexNotifier.showStatus', async () => {
    let remote;
    try { remote = await remoteCommand('codexNotifier.remote.status'); } catch (error) { remote = {error: error.message}; }
    await refresh();
    log(t('当前环境状态：\n') + JSON.stringify(remote, null, 2));
    output.show(true);
    return {remote, unread: snapshot.unread, paused: !config().get('notificationsEnabled', true)};
  });
  register('codexNotifier.testCollector', () => remoteCommand('codexNotifier.remote.test'));
  register('codexNotifier.restartCollector', () => remoteCommand('codexNotifier.remote.restart'));
  const privacyActions = new PrivacyActions(vscode, {client,
    collector: (action, ...args) => remoteCommand('codexNotifier.remote.' + action, ...args),
    clearOutput: () => output.clear(), refresh,
    showPolicy: () => vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.join(context.extensionPath, 'PRIVACY.md')))});
  register('codexNotifier.privacy', () => privacyActions.menu());
  register('codexNotifier.clearPrivateData', () => privacyActions.clear());
  register('codexNotifier.clearLocalPrivateData', () => privacyActions.clear({localOnly: true}));
  register('codexNotifier.resumePrivateData', () => privacyActions.resume());
  async function openRoutedEntry(entry, generation) {
    navigating = true;
    try { return await navigateEntry(entry, generation); }
    finally { navigating = false; }
  }
  async function navigateEntry(entry, generation) {
    const cancelled = () => generation !== privacyGeneration || disposed;
    if (cancelled()) return;
    await client.request('interact');
    if (cancelled()) return;
    if (!entry.event.session_id && entry.event.type === 'test') {
      await vscode.commands.executeCommand('codexNotifier.history.focus');
      if (cancelled()) return;
      await client.request('markRead', {key: entry.key});
      if (cancelled()) return;
      await refresh();
      return {test: true};
    }
    const result = await openCodexSession(vscode, entry.event.session_id,
      {location: config().get('openLocation', 'sidebar'),
        previewOnly: TESTING && process.env.CODEX_NOTIFIER_TEST_EDITOR !== '1', isCancelled: cancelled,
        ...(TESTING && process.env.CODEX_NOTIFIER_TEST_EDITOR === '1' ? {sidebarAuthority: 'notifier-test.notifier-route-fixture'} : {})});
    if (cancelled()) return;
    lastNavigation = result;
    await client.request('markRead', {key: entry.key});
    if (cancelled()) return;
    await refresh();
    if (cancelled()) return;
    log(t`已请求在目标窗口的 Codex ${result.method === 'sidebar' ? t('会话侧栏') : t('主编辑器')}打开会话：${clean(entry.targetWindowLabel || windowInfo().label)} · ${clean(entry.event.session_id)}`);
    return lastNavigation;
  }
  register('codexNotifier.showEntry', async value => {
    const generation = privacyGeneration;
    const key = typeof value === 'string' ? value : value?.key;
    await refresh();
    if (generation !== privacyGeneration) return;
    const entry = snapshot.entries.find(item => item.key === key);
    if (!entry) return;
    await client.request('interact', {key});
    if (generation !== privacyGeneration) return;
    const result = await client.request('openEntry', {key});
    if (generation !== privacyGeneration) return;
    if (!result.routed) {
      log(t`${eventTitle(entry)}\n目录：${clean(entry.event.cwd)}\n会话：${clean(entry.event.session_id)}\n目标窗口尚未连接，保留未读。`);
      if (!TESTING) {
        const choice = await vscode.window.showWarningMessage(t('对应窗口尚未连接通知组件。请打开该 SSH／容器窗口，或在升级后重载该窗口。'), t('复制会话 ID'));
        if (choice && generation === privacyGeneration) await vscode.env.clipboard.writeText(entry.event.session_id || '');
      }
    }
    return result;
  });
  register('codexNotifier.markEntryRead', async value => {
    const key = typeof value === 'string' ? value : value?.key;
    if (key) await client.request('markRead', {key});
    await refresh();
  });
  register('codexNotifier.openNext', async () => {
    await refresh();
    const pending = attention(snapshot.entries || [], client.clientId);
    const next = pending.local[0] || pending.unread[0];
    if (next) return vscode.commands.executeCommand('codexNotifier.showEntry', next.key);
    return vscode.commands.executeCommand('codexNotifier.showHistory');
  });
  register('codexNotifier.showEntryDetails', async value => {
    const generation = privacyGeneration;
    const key = typeof value === 'string' ? value : value?.key;
    await client.request('interact');
    await refresh();
    if (generation !== privacyGeneration) return;
    const entry = snapshot.entries.find(item => item.key === key);
    if (entry) { log(JSON.stringify(entry, null, 2)); output.show(true); }
  });
  register('codexNotifier.menu', async () => {
    await client.request('interact');
    const paused = !config().get('notificationsEnabled', true);
    const items = [
      {label: '$(globe) 语言 / Language', command: 'codexNotifier.chooseLanguage'},
      {label: t('$(layout-sidebar-right) 选择会话打开位置'), command: 'codexNotifier.chooseOpenLocation'},
      {label: t('$(extensions) 检查／安装当前环境组件'), command: 'codexNotifier.checkInstallation'},
      {label: t('$(history) 查看通知历史'), command: 'codexNotifier.showHistory'},
      {label: t('$(clear-all) 清空已读通知'), command: 'codexNotifier.clearRead'},
      {label: t('$(trash) 清空全部通知'), command: 'codexNotifier.clearHistory'},
      {label: t('$(beaker) 测试本机弹窗和声音'), command: 'codexNotifier.testNotification'},
      {label: t('$(debug-disconnect) 测试当前窗口采集链路'), command: 'codexNotifier.testCollector'},
      {label: paused ? t('$(bell) 恢复提醒') : t('$(bell-slash) 暂停提醒（继续记录）'), command: paused ? 'codexNotifier.resume' : 'codexNotifier.pause'},
      {label: t('$(shield) 配置当前环境的审批提醒'), command: 'codexNotifier.configureApprovalHook'},
      {label: t('$(pulse) 查看连接状态'), command: 'codexNotifier.showStatus'},
      {label: t('$(settings-gear) 通知设置'), command: 'codexNotifier.settings'},
      {label: t('$(shield) 隐私与数据清理'), command: 'codexNotifier.privacy'}
    ];
    const selected = await vscode.window.showQuickPick(items, {title: t('Codex 会话通知')});
    if (selected) await vscode.commands.executeCommand(selected.command);
  });

  client.on('diagnostic', log);
  client.on('privacyReset', () => {
    privacyGeneration++;
    lastNavigation = null; lastNavigationFailure = null;
    output.clear();
    snapshot = {entries: [], unread: 0, privacyPaused: true};
    history.update([]); updateBadge();
    refresh().catch(error => log(error.message));
  });
  client.on('historyChanged', () => refresh().catch(error => log(error.message)));
  client.on('desktopAlert', message => {
    if (!config().get('notificationsEnabled', true) || !config().get('desktopNotifications', true)) return;
    const generation = privacyGeneration;
    showWindowAlert(vscode, message, {
      cancelled: () => disposed || generation !== privacyGeneration,
      open: key => vscode.commands.executeCommand('codexNotifier.showEntry', key),
      history: () => vscode.commands.executeCommand('codexNotifier.showHistory'),
    }).catch(error => log(error.message));
  });
  client.on('connected', () => { log(t('本机通知组件已连接')); lastRegistration = ''; windowAttention.reset(); syncWindow().catch(error => log(error.message)); });
  client.on('disconnected', () => { lastRegistration = ''; log(t('本机通知组件断开，将自动重连')); });
  client.on('openEntry', message => {
    if (!message.entry || message.entry.key !== message.key) return;
    const generation = privacyGeneration;
    opening = opening.catch(() => {}).then(() => openRoutedEntry(message.entry, generation));
    opening.catch(error => {
      if (generation !== privacyGeneration || error.code === 'PRIVACY_CANCELLED') return;
      lastNavigationFailure = {key: message.key, error: error.message}; return failure(error.message);
    });
  });
  client.on('navigationUnavailable', () => {
    failure(t('这条通知对应的窗口尚未连接。请打开对应 SSH／容器窗口，或在升级后重载该窗口。')).catch(() => {});
  });
  client.on('actionError', message => { failure(clean(message.error, 1000)).catch(() => {}); });
  client.on('deliveryError', message => {
    const relevant = (message.entries || []).filter(entry => !sourceStatus || entry.source.id === sourceStatus.source.id);
    if (!relevant.length) return;
    failure(t('Windows 系统通知显示失败，更新已保存在通知历史。') + clean(message.error, 200)).catch(() => {});
  });
  context.subscriptions.push(output, history, view, statusBar, vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('codexNotifier.language')) {
      history.update(snapshot.entries || []);
      if (sourceStatus) sourceStatus.status.message = renderMessage(sourceStatus.status.messageSpec, getLanguage(), sourceStatus.status.message);
      log(t('语言已切换为中文。'));
    }
    if (event.affectsConfiguration('codexNotifier')) { lastRegistration = ''; updateBadge(); syncWindow().catch(error => log(error.message)); }
  }), vscode.window.onDidChangeWindowState(() => { updateBadge(); syncWindow().catch(error => log(error.message)); }),
  vscode.workspace.onDidChangeWorkspaceFolders(() => { lastRegistration = ''; syncWindow().catch(error => log(error.message)); }),
  {dispose() { disposed = true; windowAttention.dispose(); clearInterval(reconnectTimer); clearTimeout(installationTimer); client.dispose(); }});
  if (vscode.env.remoteName) {
    const scheduleCheck = () => {
      clearTimeout(installationTimer);
      installationTimer = setTimeout(() => { checkInstallation().catch(error => log(error.message)); }, 10000);
    };
    context.subscriptions.push(vscode.extensions.onDidChange(scheduleCheck));
    scheduleCheck();
  }
  const reconnectTimer = setInterval(() => { syncWindow().then(refresh).catch(error => log(error.message)); }, 15000);
  current = {client};
  context.subscriptions.push(new ReadTracker(vscode, {windowId: client.clientId,
    entries: () => snapshot.entries || [], enabled: () => config().get('autoReadOnWindowFocus', false),
    suspended: () => navigating, log,
    acknowledge: async keys => {await client.request('markRead', {keys}); await refresh();}}));
  if (!vscode.env.remoteName) {
    // Preserve explicitly configured local values from the former standalone
    // workspace collector. Never copy remote machine settings into local mode.
    for (const [oldKey, newKey] of [['codexHome', 'localCodexHome'], ['pythonPath', 'localPythonPath'],
      ['sourceLabel', 'localSourceLabel'], ['collectorEnabled', 'localCollectorEnabled']]) {
      const previous = config().inspect(oldKey);
      const next = config().inspect(newKey);
      for (const [field, target] of [['globalValue', vscode.ConfigurationTarget.Global],
        ['workspaceValue', vscode.ConfigurationTarget.Workspace]]) {
        if (previous?.[field] !== undefined && next?.[field] === undefined) {
          await config().update(newKey, previous[field], target);
        }
      }
    }
    const {createController} = require('./collector/src/extension');
    createController(vscode, {extensionPath: path.join(context.extensionPath, 'collector'), subscriptions: context.subscriptions},
      {commandPrefix: 'codexNotifier.local', configKeyPrefix: 'local', outputName: t('Codex 通知 · 本地采集')});
  }
  updateBadge();
  syncWindow().then(refresh).catch(error => failure(error.message));
}

function deactivate() { current?.client.dispose(); current = null; }
module.exports = {activate, deactivate};
