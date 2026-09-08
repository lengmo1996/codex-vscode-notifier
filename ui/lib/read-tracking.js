'use strict';

function activeSession(vscode) {
  try {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputCustom) || input.viewType !== 'chatgpt.conversationEditor') return '';
    if (input.uri.scheme !== 'openai-codex' || input.uri.authority !== 'route') return '';
    const match = /^\/local\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(input.uri.path);
    return match?.[1] || '';
  } catch { return ''; }
}

class ReadTracker {
  constructor(vscode, {windowId, entries, acknowledge, enabled = () => false, suspended = () => false, log = () => {}}) {
    this.vscode = vscode;
    this.windowId = windowId;
    this.entries = entries;
    this.acknowledge = acknowledge;
    this.enabled = enabled;
    this.suspended = suspended;
    this.log = log;
    this.focused = vscode.window.state.focused;
    this.selected = activeSession(vscode);
    this.pending = new Set();
    this.disposed = false;
    this.subscriptions = [
      vscode.window.onDidChangeWindowState(state => this.onFocus(state.focused)),
      vscode.window.tabGroups.onDidChangeTabs(() => this.onTabs()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.onTabs()),
    ];
  }
  onFocus(focused) {
    const entered = focused && !this.focused;
    this.focused = focused;
    this.selected = activeSession(this.vscode);
    // A deliberate return to a window acknowledges its existing reminders.
    // New arrivals while it stays focused are not automatically consumed.
    if (entered && this.enabled()) this.read('');
  }
  onTabs() {
    const selected = activeSession(this.vscode);
    const changed = selected && selected !== this.selected;
    this.selected = selected;
    if (changed && this.focused && this.enabled()) this.read(selected);
  }
  read(session) {
    if (this.disposed || this.suspended()) return;
    const keys = this.entries().filter(entry => !entry.read && entry.targetWindowId === this.windowId &&
      (!session || entry.event.session_id === session) && !this.pending.has(entry.key)).map(entry => entry.key);
    if (!keys.length) return;
    // Capture keys at the focus event, so later arrivals stay unread.
    for (const key of keys) this.pending.add(key);
    Promise.resolve().then(() => {
      if (!this.disposed && !this.suspended() && this.enabled()) return this.acknowledge(keys);
    }).catch(error => this.log(error.message))
      .finally(() => {for (const key of keys) this.pending.delete(key);});
  }
  dispose() { this.disposed = true; for (const subscription of this.subscriptions) subscription.dispose(); }
}

module.exports = {activeSession, ReadTracker};
