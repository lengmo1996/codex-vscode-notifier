'use strict';
const {t, getLanguage, configureLanguage, message: describe, renderMessage} = require('./i18n');

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const {settings, settingKey, makeSource, hookIsConfigured, JsonLines, restartDelay, EventBridge} = require('./core');

function createController(vscode, context, dependencies = {}) {
  let languageOverride;
  configureLanguage(() => languageOverride || vscode.workspace.getConfiguration('codexNotifier').get('language', 'zh-CN'));
  const spawn = dependencies.spawn || childProcess.spawn;
  const commandPrefix = dependencies.commandPrefix || 'codexNotifier.remote';
  const configKeyPrefix = dependencies.configKeyPrefix || '';
  const localMode = configKeyPrefix === 'local';
  const configKey = key => settingKey(key, configKeyPrefix);
  const output = vscode.window.createOutputChannel(dependencies.outputName || t('Codex Notifier — Collector'));
  const script = path.join(context.extensionPath, 'scripts', 'collector.py');
  let config;
  let source;
  let child = null;
  let generation = 0;
  let failureCount = 0;
  let restartTimer = null;
  let disposed = false;
  let lastHeartbeat = 0;
  let privacyPaused = false;
  let cleanupInProgress = false;
  let currentStatus = {state: 'stopped', messageSpec: describe('Collector is not started.')};
  const renderedStatus = () => ({...currentStatus, message: renderMessage(currentStatus.messageSpec)});
  const operations = new Set();
  const log = message => output.appendLine(`${new Date().toISOString()} ${message}`);
  const bridge = new EventBridge((...args) => vscode.commands.executeCommand(...args), log);

  function updateSettings() {
    config = settings(vscode.workspace.getConfiguration('codexNotifier'), {}, configKeyPrefix);
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    source = makeSource(config, {
      hostname: os.hostname(), remoteName: localMode ? '' : vscode.env.remoteName || '', cwd: folder?.fsPath || '',
    });
  }

  function setStatus(state, message) {
    currentStatus = {state, messageSpec: message};
    bridge.status(source, renderedStatus());
    log(`${t(state)}: ${renderMessage(message)}`);
  }

  function stopChild() {
    generation += 1;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    const previous = child;
    child = null;
    lastHeartbeat = 0;
    if (previous) {
      try { previous.kill(); } catch { /* It may already have exited. */ }
    }
    return previous;
  }

  function start() {
    if (disposed || child) return;
    if (cleanupInProgress || privacyPaused) {
      setStatus('stopped', describe('Privacy cleanup paused collection; resume it explicitly to collect new notifications.'));
      return;
    }
    if (localMode && !hasWorkspace()) {
      setStatus('stopped', describe('Open a local folder or workspace to start the local collector.'));
      return;
    }
    if (!vscode.workspace.isTrusted) {
      setStatus('stopped', describe('Workspace is not trusted; collector processes and hook changes are disabled.'));
      return;
    }
    if (!config.enabled) {
      setStatus('stopped', describe('Collector disabled in settings.'));
      return;
    }
    const token = ++generation;
    let failed = false;
    const fail = reason => {
      if (failed || token !== generation || disposed) return;
      failed = true;
      const previous = child;
      child = null;
      lastHeartbeat = 0;
      try { previous?.kill(); } catch { /* No remaining process. */ }
      const delay = restartDelay(++failureCount);
      setStatus('error', describe`${reason} Retrying in ${delay / 1000} seconds; check the Python path and Codex home.`);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        start();
      }, delay);
    };
    setStatus('starting', describe('Starting Codex event collector.'));
    const framing = new JsonLines(event => {
      if (token !== generation || disposed) return;
      if (event.type === 'heartbeat') {
        lastHeartbeat = Date.now();
        privacyPaused = event.privacyPaused === true;
        if (privacyPaused) {
          bridge.queue.length = 0;
          setStatus('stopped', describe('Privacy cleanup paused collection; resume it explicitly to collect new notifications.'));
          return;
        }
        // A process that repeatedly starts then crashes must retain backoff.
        if (Date.now() - startedAt >= 30000) failureCount = 0;
        if (currentStatus.state !== 'connected') setStatus('connected', describe('Collector is reading Codex event metadata.'));
        else bridge.status(source, renderedStatus());
      } else bridge.event(source, event);
    });
    const startedAt = Date.now();
    try {
      child = spawn(config.python, [...config.pythonArgs, '-u', script, 'follow', '--retention-days', String(config.retentionDays), '--codex-home', config.codexHome], {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: {...process.env, PYTHONIOENCODING: 'utf-8'},
      });
      child.stdout.on('data', data => framing.push(data));
      // Drain stderr without relaying arbitrary text from an executable or environment.
      child.stderr.on('data', () => {});
      child.on('error', error => fail(t`Collector process could not start (${error.code || t('spawn error')}).`));
      child.on('close', (code, signal) => fail(t`Collector exited (${code === null ? signal || 'unknown' : code}).`));
    } catch (error) {
      fail(t`Collector process could not start (${error.code || t('spawn error')}).`);
    }
    // Also detect a process that starts but never produces its first heartbeat.
    lastHeartbeat = startedAt;
  }

  function restart() {
    stopChild();
    failureCount = 0;
    updateSettings();
    start();
  }

  function requireTrust() {
    if (localMode && !hasWorkspace()) throw new Error(t('请先在此窗口打开本地文件夹或工作区，再运行本地采集器。'));
    if (vscode.workspace.isTrusted) return;
    throw new Error(t('请先信任此工作区，再运行采集器或配置审批 Hook。'));
  }

  function hasWorkspace() {
    return Boolean(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length);
  }

  async function runAction(action, parameters = {}) {
    requireTrust();
    if (cleanupInProgress && action !== 'clear-private-data') throw new Error(t('隐私清理正在执行，请稍后重试。'));
    updateSettings();
    return new Promise((resolve, reject) => {
      let process;
      let buffer = Buffer.alloc(0);
      let complete = false;
      const finish = (error, result) => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        operations.delete(process);
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => {
        try { process?.kill(); } catch { /* Already closed. */ }
        finish(new Error(t('采集器命令超时；请检查 Python 和 Codex home 设置。')));
      }, 15000);
      try {
        const args = [...config.pythonArgs, '-u', script, action, '--retention-days', String(config.retentionDays), '--codex-home', config.codexHome];
        if (action === 'install' && config.label) args.push('--label', config.label);
        if (parameters.previewToken) args.push('--preview-token', parameters.previewToken);
        process = spawn(config.python, args, {
          shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: {...global.process.env, PYTHONIOENCODING: 'utf-8'},
        });
        operations.add(process);
        process.stdout.on('data', chunk => {
          if (buffer.length + chunk.length > 64 * 1024) {
            process.kill();
            finish(new Error(t('采集器返回内容超过允许大小。')));
          } else buffer = Buffer.concat([buffer, chunk]);
        });
        process.stderr.on('data', () => {});
        process.on('error', error => finish(new Error(t`无法运行 Python（${error.code || t('启动失败')}）。请检查 codexNotifier.${configKey('pythonPath')}。`)));
        process.on('close', code => {
          if (code !== 0) return finish(new Error(t`采集器命令失败（退出码 ${code}）。请检查 Python、目录权限和 hooks.json 格式。`));
          try { finish(null, JSON.parse(buffer.toString('utf8').trim())); }
          catch { finish(new Error(t('采集器没有返回有效结果。'))); }
        });
      } catch (error) {
        finish(new Error(t`无法启动采集器命令（${error.code || t('启动失败')}）。`));
      }
    });
  }

  async function status() {
    updateSettings();
    let hookConfigured = false;
    let hookReadError = false;
    try {
      const hooks = path.join(config.codexHome, 'hooks.json');
      if ((await fs.stat(hooks)).size > 1024 * 1024) hookReadError = true;
      else hookConfigured = hookIsConfigured(JSON.parse((await fs.readFile(hooks, 'utf8')).replace(/^\uFEFF/, '')));
    } catch (error) {
      hookReadError = error.code !== 'ENOENT';
    }
    return {
      source, ...renderedStatus(), codexHome: config.codexHome, python: config.python,
      pythonArgs: [...config.pythonArgs], enabled: config.enabled,
      workspaceTrusted: vscode.workspace.isTrusted, hookConfigured, hookReadError,
      hookTrust: 'unknown', uiConnected: bridge.connected, pendingEvents: bridge.queue.length,
      lastHeartbeat: lastHeartbeat || null, collectorPid: child?.pid || null,
      retentionDays: config.retentionDays, privacyPaused,
    };
  }

  async function reportAction(action, parameters) {
    try {
      const result = await runAction(action, parameters);
      if (action === 'install') {
        void vscode.window.showInformationMessage(t('审批提醒 Hook 已配置。请在 Codex 设置 → Hooks → PermissionRequest 中核对 vscode-notifier/remote_notifier.py，然后点击 Trust。扩展无法代替你信任 Hook。'));
      } else if (action === 'uninstall') {
        void vscode.window.showInformationMessage(t('已移除此扩展管理的审批提醒 Hook；其他配置和备份已保留。'));
      }
      return result;
    } catch (error) {
      void vscode.window.showErrorMessage(error.message);
      return {ok: false, error: error.message};
    }
  }

  async function setCollectorEnabled(enabled) {
    const configuration = vscode.workspace.getConfiguration('codexNotifier');
    const key = configKey('collectorEnabled');
    const inspected = configuration.inspect?.(key);
    const target = inspected?.workspaceFolderValue !== undefined ? 3 : hasWorkspace() ? 2 : 1;
    await configuration.update(key, enabled, target);
  }

  async function stopForPrivacy() {
    const processes = [...new Set([child, ...operations].filter(Boolean))];
    const waits = processes.map(process => new Promise((resolve, reject) => {
      if (process.exitCode !== null && process.exitCode !== undefined) return resolve();
      const timer = setTimeout(() => reject(new Error(t('采集进程未及时退出；已暂停，未执行数据清理。'))), 2000);
      process.once('close', () => {clearTimeout(timer); resolve();});
    }));
    stopChild();
    for (const process of operations) {try {process.kill();} catch { /* Already closed. */ }}
    await Promise.all(waits);
  }

  async function clearPrivateData(parameters = {}) {
    let ownsCleanup = false;
    try {
      requireTrust();
      if (!/^[0-9a-f]{64}$/.test(parameters.previewToken || '')) throw new Error(t('请先预览本环境的隐私清理清单，再确认清理。'));
      if (cleanupInProgress) throw new Error(t('隐私清理正在执行，请稍后重试。'));
      cleanupInProgress = true;
      ownsCleanup = true;
      privacyPaused = true;
      bridge.queue.length = 0;
      await stopForPrivacy();
      let settingsWarning;
      try {await setCollectorEnabled(false);} catch {settingsWarning = t('无法写入暂停设置；本进程及持久隐私暂停标记仍会阻止采集。');}
      const result = await runAction('clear-private-data', parameters);
      setStatus('stopped', describe('Notification data cleanup finished; collection remains paused.'));
      return {...result, ...(settingsWarning ? {settingsWarning} : {})};
    } catch (error) {
      void vscode.window.showErrorMessage(error.message);
      return {ok: false, error: error.message, paused: privacyPaused};
    } finally {if (ownsCleanup) cleanupInProgress = false;}
  }

  async function resumePrivateData() {
    try {
      requireTrust();
      if (cleanupInProgress) throw new Error(t('隐私清理正在执行，请稍后重试。'));
      privacyPaused = true;
      await stopForPrivacy();
      await setCollectorEnabled(true);
      const result = await runAction('resume-private-data');
      privacyPaused = false;
      restart();
      return result;
    } catch (error) {
      void vscode.window.showErrorMessage(error.message);
      return {ok: false, error: error.message, paused: privacyPaused};
    }
  }

  updateSettings();
  const subscriptions = [
    vscode.commands.registerCommand(`${commandPrefix}.status`, status),
    vscode.commands.registerCommand(`${commandPrefix}.setLanguage`, language => {
      if (!['zh-CN', 'en'].includes(language)) return {accepted: false};
      const changed = getLanguage() !== language;
      languageOverride = language;
      if (changed) log(t('采集器语言已更新。'));
      return {accepted: true, language: getLanguage()};
    }),
    vscode.commands.registerCommand(`${commandPrefix}.configureApprovalHook`, () => reportAction('install')),
    vscode.commands.registerCommand(`${commandPrefix}.removeApprovalHook`, () => reportAction('uninstall')),
    vscode.commands.registerCommand(`${commandPrefix}.test`, async () => {
      if (!config.enabled) {
        const error = t`采集器已暂停。请启用 codexNotifier.${configKey('collectorEnabled')} 后测试采集链路。`;
        void vscode.window.showErrorMessage(error);
        return {ok: false, error};
      }
      return reportAction('test');
    }),
    vscode.commands.registerCommand(`${commandPrefix}.restart`, () => { restart(); return status(); }),
    vscode.commands.registerCommand(`${commandPrefix}.privacyStatus`, () => reportAction('privacy-status')),
    vscode.commands.registerCommand(`${commandPrefix}.previewPrivacyCleanup`, () => reportAction('preview-privacy-cleanup')),
    vscode.commands.registerCommand(`${commandPrefix}.clearPrivateData`, clearPrivateData),
    vscode.commands.registerCommand(`${commandPrefix}.resumePrivateData`, resumePrivateData),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (['codexHome', 'pythonPath', 'sourceLabel', 'collectorEnabled', 'cacheRetentionDays'].some(key => event.affectsConfiguration(`codexNotifier.${configKey(key)}`))) restart();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(restart),
  ];
  if (localMode && vscode.workspace.onDidChangeWorkspaceFolders) {
    subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(restart));
  }
  const retryTimer = setInterval(() => {
    void bridge.flush();
    if (child && lastHeartbeat && Date.now() - lastHeartbeat > 45000) {
      // Killing the process lets its close callback apply normal exponential backoff.
      log(t('Collector heartbeat timed out; restarting.'));
      lastHeartbeat = Date.now();
      try { child.kill(); } catch { restart(); }
    }
  }, 2000);
  start();

  function dispose() {
    if (disposed) return;
    disposed = true;
    stopChild();
    clearInterval(retryTimer);
    bridge.status(source, {state: 'stopped', message: t('Workspace collector closed.')});
    bridge.dispose();
    for (const process of operations) { try { process.kill(); } catch { /* Already exited. */ } }
    for (const subscription of subscriptions) subscription.dispose();
    output.dispose();
  }
  context.subscriptions.push({dispose});
  return {status, restart, dispose};
}

function activate(context) {
  const vscode = require('vscode');
  if (!vscode.env.remoteName) return;
  createController(vscode, context);
}

module.exports = {activate, createController};
