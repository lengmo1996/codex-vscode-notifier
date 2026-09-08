'use strict';
const {t, getLanguage, translator} = require('./i18n');
const REMOTE_ID = 'lengmo1996.codex-notifier-collector';

// The UI host's extension registry cannot reliably identify remote extensions.
// Query commands across hosts, then request status in the current environment.
async function inspectInstallation(vscode) {
  const remote = !!vscode.env.remoteName;
  const command = `codexNotifier.${remote ? 'remote' : 'local'}.status`;
  try {
    const commands = await vscode.commands.getCommands(true);
    if (!commands.includes(command)) return {state: remote ? 'missing' : 'unavailable', remote};
    const collector = await vscode.commands.executeCommand(command);
    return collector ? {state: 'available', remote, collector} : {state: 'unavailable', remote};
  } catch {
    // Activation or Python errors do not imply the component is uninstalled.
    return {state: 'unavailable', remote};
  }
}

async function showInstallation(vscode, result) {
  const t = translator(getLanguage());
  if (result.remote && result.state === 'missing') {
    await vscode.commands.executeCommand('workbench.extensions.search', `@id:${REMOTE_ID}`);
    const action = await vscode.window.showInformationMessage(
      t('已定位配套采集组件。请在扩展页面选择“安装到 SSH／容器”，并确认已在当前环境启用。安装后如需重载，请等任务空闲。'), t('重新检查'));
    if (action === t('重新检查')) await vscode.commands.executeCommand('codexNotifier.checkInstallation');
  } else {
    const message = result.state === 'available'
      ? (result.remote ? t('当前 SSH／容器的采集组件已连接。') : t('本地采集组件已内置，无需另装远端组件。'))
      : t('采集组件尚未就绪，请查看状态并检查是否已启用、工作区是否受信任及 Python 设置。');
    const action = await vscode.window.showInformationMessage(message, t('查看连接状态'));
    if (action === t('查看连接状态')) await vscode.commands.executeCommand('codexNotifier.showStatus');
  }
  return result;
}

module.exports = {REMOTE_ID, inspectInstallation, showInstallation};
