'use strict';
const {t, getLanguage} = require('./i18n');
const {clean, projectName, eventTitle, historyGroups} = require('./presentation');

class HistoryView {
  constructor(vscode, windowId) {
    this.vscode = vscode;
    this.windowId = windowId;
    this.entries = [];
    this.groups = [];
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }
  update(entries) {
    this.entries = entries;
    this.groups = historyGroups(entries, this.windowId);
    this.changed.fire();
  }
  getChildren(element) { return element?.entries || this.groups; }
  getParent(entry) { return this.groups.find(group => group.entries.some(item => item.key === entry.key)); }
  getTreeItem(entry) {
    const vscode = this.vscode;
    if (entry.entries) {
      const item = new vscode.TreeItem(`${entry.title} (${entry.entries.length})`, entry.unread ?
        vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = entry.id;
      item.iconPath = new vscode.ThemeIcon(entry.unread ? 'circle-filled' : 'check-all',
        new vscode.ThemeColor(entry.unread ? 'list.warningForeground' : 'descriptionForeground'));
      item.contextValue = entry.unread ? 'unreadNotificationGroup' : 'readNotificationGroup';
      return item;
    }
    const project = projectName(entry.event.cwd);
    const label = `${entry.read ? t('已读') : t('● 未读')} · ${project} · ${eventTitle(entry).split(' · ')[0]}`;
    const item = new vscode.TreeItem(entry.read ? label : {label, highlights: [[0, label.length]]}, vscode.TreeItemCollapsibleState.None);
    item.id = entry.key;
    const date = new Date(entry.receivedAt);
    item.description = `${clean(entry.targetWindowLabel || entry.source.label || entry.source.host, 160)} · ${date.toLocaleTimeString(getLanguage())}`;
    item.tooltip = t`${entry.read ? t('已读') : t('未读')} · ${eventTitle(entry)}\n目标窗口：${clean(entry.targetWindowLabel) || t('尚未连接')}\n目录：${clean(entry.event.cwd)}\n会话：${clean(entry.event.session_id)}\n${date.toLocaleString(getLanguage())}\n单击静默标记并打开对应会话`;
    item.iconPath = new vscode.ThemeIcon(entry.read ? 'check' : 'circle-filled', new vscode.ThemeColor(entry.read ?
      'descriptionForeground' : ['approval', 'question'].includes(entry.event.type) ? 'list.errorForeground' : 'list.warningForeground'));
    item.command = {command: 'codexNotifier.showEntry', title: t('打开对应会话并标为已读'), arguments: [entry.key]};
    item.contextValue = entry.read ? 'readNotification' : 'unreadNotification';
    item.accessibilityInformation = {label: `${label}，${item.description}`};
    return item;
  }
  dispose() { this.changed.dispose(); }
}
module.exports = {HistoryView};
