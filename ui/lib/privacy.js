'use strict';
const {t, getLanguage, translator} = require('./i18n');

class PrivacyActions {
  constructor(vscode, {client, collector, clearOutput, refresh, showPolicy}) {
    Object.assign(this, {vscode, client, collector, clearOutput, refresh, showPolicy});
  }
  async clear({localOnly = false} = {}) {
    const t = translator(getLanguage()); // Keep modal labels stable while awaiting confirmation.
    await this.client.request('interact');
    const local = await this.client.request('privacyStatus');
    let remote;
    if (!localOnly) remote = await this.collector('previewPrivacyCleanup');
    if (remote && (remote.canClear === false || !remote.previewToken || remote.errors?.length)) throw new Error(t('采集缓存预览未通过；未清理数据。请查看当前环境状态。'));
    const detail = [
      t`本机：清理所有已连接窗口共享的通知历史、旧版本缓存和去重记录（约 ${local.totalBytes || 0} 字节）。`,
      remote ? t`当前环境：${remote.codexHome}\n清理已归属本扩展的采集缓存及审批提醒 Hook（约 ${remote.totalBytes || 0} 字节）。` : t('本次不清理服务器或容器中的采集缓存。'),
      t('其他服务器／容器需要分别连接后清理。清理后暂停本机通知接收；当前环境清理成功后也保持采集暂停。'),
      t('保留原始 Codex 对话、登录信息、项目文件、无关 Hook，以及不含会话标识的最小暂停控制和本机通信身份。'),
      remote?.legacyBackupCount ? t`发现 ${remote.legacyBackupCount} 份无法确认归属的旧 Hook 备份，将保留并在结果中列明。` : '',
      t('这是应用数据删除，不保证擦除磁盘恢复副本、系统日志或外部备份。')
    ].filter(Boolean).join('\n\n');
    const selected = await this.vscode.window.showWarningMessage(t('清理通知数据并暂停采集？'),
      {modal: true, detail}, t('清理并暂停'));
    if (selected !== t('清理并暂停')) return {cancelled: true};
    // Pause receiving first; a failed remote cleanup must not keep collecting.
    await this.client.request('privacyReset');
    this.clearOutput();
    await this.refresh();
    if (remote) {
      try {
        const result = await this.collector('clearPrivateData', {previewToken: remote.previewToken});
        if (!result?.cleared || result.errors?.length) throw new Error(result?.error || result?.errors?.join('；') || t('采集器未确认清理完成'));
        this.clearOutput();
        await this.vscode.window.showInformationMessage(t('本机通知缓存和当前环境采集缓存已清理，接收和采集保持暂停。其他远端环境需分别清理。'));
        return {cleared: true, paused: true, localOnly: false, collector: result};
      } catch (error) {
        throw new Error(t('本机通知缓存已清理并暂停接收；当前环境采集缓存未确认清理完成：') + error.message + t('。请重新预览后重试。'));
      }
    }
    await this.vscode.window.showInformationMessage(t('本机全部通知缓存已清理并暂停接收。服务器／容器采集缓存未作清理。'));
    return {cleared: true, paused: true, localOnly: true};
  }
  async resume() {
    const result = await this.collector('resumePrivateData');
    if (!result || result.ok === false || result.paused === true || result.error) {
      throw new Error(t('当前环境采集未恢复，本机保持暂停：') + (result?.error || t('采集器未确认恢复完成')));
    }
    await this.client.request('resumePrivacy');
    await this.refresh();
    await this.vscode.window.showInformationMessage(t('已恢复当前环境采集和本机通知接收。清理前的事件不会补回；审批提醒如已移除，需要重新配置并信任。'));
    return {paused: false};
  }
  async menu() {
    const selected = await this.vscode.window.showQuickPick([
      {label: t('阅读隐私说明'), action: 'policy', description: t('数据范围、隔离边界、保留和清理')},
      {label: t('清理当前环境及本机通知数据'), action: 'clear', description: t('先预览；清理后暂停采集和接收')},
      {label: t('仅清理本机全部通知缓存'), action: 'local', description: t('远端未连接时也可用')},
      {label: t('恢复当前环境采集和本机接收'), action: 'resume', description: t('不会补回清理前的事件')}
    ], {title: t('Codex 通知隐私与数据清理')});
    if (selected?.action === 'policy') return this.showPolicy();
    if (selected?.action === 'clear') return this.clear();
    if (selected?.action === 'local') return this.clear({localOnly: true});
    if (selected?.action === 'resume') return this.resume();
  }
}
module.exports = {PrivacyActions};
