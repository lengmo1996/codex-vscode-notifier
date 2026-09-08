'use strict';
const {t} = require('./i18n');

// Verified against openai.chatgpt 26.901.22334: its custom editor accepts
// openai-codex://route/local/<id> and uses that window's Codex connection.
function sessionId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(t('这条通知没有有效的 Codex 会话标识，无法直接跳转。'));
  }
  return value;
}

function checkCancellation(isCancelled) {
  if (!isCancelled()) return;
  const error = new Error(t('通知数据已清理，已取消此前的跳转。'));
  error.code = 'PRIVACY_CANCELLED';
  throw error;
}

async function waitForTargetTab(vscode, target, timeoutMs, intervalMs, isCancelled) {
  const deadline = Date.now() + timeoutMs;
  const targetUri = target.toString();
  do {
    checkCancellation(isCancelled);
    try {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      if (input instanceof vscode.TabInputCustom && input.viewType === 'chatgpt.conversationEditor'
          && input.uri.toString() === targetUri) return;
    } catch {
      // Older hosts or unavailable tab metadata cannot confirm a valid editor.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
  } while (Date.now() <= deadline);
  throw new Error(t('未能确认目标 Codex 会话标签已打开，请检查此窗口中的 Codex 扩展后重试。'));
}

async function openCodexSession(vscode, value, {
  location = 'sidebar', previewOnly = false, tabWaitTimeoutMs = 2000, tabPollIntervalMs = 50, isCancelled = () => false,
  sidebarAuthority = 'openai.chatgpt',
} = {}) {
  checkCancellation(isCancelled);
  const id = sessionId(value);
  if (!['sidebar', 'editor'].includes(location)) throw new Error(t('未知的 Codex 会话打开位置。'));
  if (location === 'sidebar') {
    const scheme = vscode.env.uriScheme;
    if (!['vscode', 'vscode-insiders', 'vscode-exploration'].includes(scheme)) {
      throw new Error(t('当前 VS Code 环境不支持 Codex 会话侧栏跳转，请在通知设置中选择主编辑器。'));
    }
    const target = vscode.Uri.from({scheme, authority: sidebarAuthority, path: '/local/' + id});
    if (previewOnly) return {sessionId: id, uri: target.toString(), requested: false, previewOnly: true, method: 'sidebar'};
    const commands = await vscode.commands.getCommands(true);
    checkCancellation(isCancelled);
    if (!commands.includes('chatgpt.openSidebar')) throw new Error(t('当前窗口的 Codex 侧栏不可用，请先安装并启用 Codex 扩展。'));
    await vscode.commands.executeCommand('workbench.action.focusWindow');
    checkCancellation(isCancelled);
    const deadline = Date.now() + tabWaitTimeoutMs;
    while (!vscode.window.state.focused && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, tabPollIntervalMs));
      checkCancellation(isCancelled);
    }
    if (!vscode.window.state.focused) throw new Error(t('未能聚焦目标窗口，保留未读。'));
    await vscode.commands.executeCommand('chatgpt.openSidebar');
    checkCancellation(isCancelled);
    if (!vscode.window.state.focused) throw new Error(t('目标窗口已失去焦点，已取消会话跳转并保留未读。'));
    // VS Code 1.135's windowId query router matches numeric prefixes (1/16).
    // Omit that query and use its exact active-client routing after focusing
    // this destination window. Do not use asExternalUri or OS-level dispatch.
    await vscode.commands.executeCommand('vscode.open', target);
    checkCancellation(isCancelled);
    if (!vscode.window.state.focused) throw new Error(t('跳转期间窗口焦点改变，无法确认目标，保留未读。'));
    // Codex's URI handler queues the sidebar route. No public API attests that
    // its backend has finished resuming the conversation.
    return {sessionId: id, requested: true, method: 'sidebar'};
  }
  // The local registry can omit Codex on an SSH/container host. Dispatch to
  // the current window's editor service, which activates the right provider.
  const target = vscode.Uri.from({scheme: 'openai-codex', authority: 'route', path: '/local/' + id});
  if (previewOnly) return {sessionId: id, uri: target.toString(), requested: false, previewOnly: true, method: 'window-editor'};
  // Global extension URI dispatch can misroute windowId=1 to window:16 in
  // VS Code 1.135.0. Do not fall back to it if this window has no provider.
  await vscode.commands.executeCommand('vscode.openWith', target, 'chatgpt.conversationEditor', {
    viewColumn: vscode.ViewColumn.Active, preserveFocus: false, preview: false,
  });
  // openWith may resolve while displaying an error page. Confirm that the
  // expected custom editor exists; this does not attest backend resume success.
  checkCancellation(isCancelled);
  await waitForTargetTab(vscode, target, tabWaitTimeoutMs, tabPollIntervalMs, isCancelled);
  checkCancellation(isCancelled);
  await vscode.commands.executeCommand('workbench.action.focusWindow');
  checkCancellation(isCancelled);
  return {sessionId: id, requested: true, method: 'window-editor'};
}

module.exports = {sessionId, openCodexSession};
