'use strict';

function text(value, limit, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value) || (required && !value)) throw new Error('Invalid window metadata');
  return value;
}
function normalizePath(value) {
  let result = value.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^\/?[a-z]:(?:\/|$)/i.test(result)) result = result.replace(/^\//, '').toLowerCase();
  if (result.startsWith('//')) result = result.toLowerCase();
  return result || (value ? '/' : '');
}
function matchLength(cwd, roots) {
  const target = normalizePath(cwd);
  let best = -1;
  for (const raw of roots) {
    const root = normalizePath(raw);
    if (!root) continue;
    if (target === root || target.startsWith(root === '/' ? '/' : root + '/')) best = Math.max(best, root.length);
  }
  return best;
}

class WindowRegistry {
  constructor(now = Date.now) { this.windows = new Map(); this.now = now; }
  update(clientId, value) {
    if (!value || value.id !== clientId || typeof value.focused !== 'boolean') throw new Error('Window must belong to the authenticated client');
    if (value.workspaceCwds !== undefined && (!Array.isArray(value.workspaceCwds) || value.workspaceCwds.length > 64)) throw new Error('Invalid workspace roots');
    const window = {id: clientId, label: text(value.label, 200), sourceId: text(value.sourceId, 256),
      workspaceUri: text(value.workspaceUri, 8192), workspaceCwd: text(value.workspaceCwd, 2048),
      workspaceCwds: (value.workspaceCwds || []).map(root => text(root, 2048)), focused: value.focused,
      routeUri: text(value.routeUri, 8192)};
    if (value.language !== undefined) {
      if (!['zh-CN', 'en'].includes(value.language)) throw new Error('Invalid notification language');
      window.language = value.language;
    }
    const previous = this.windows.get(clientId);
    if (value.policy !== undefined) {
      if (!value.policy || typeof value.policy !== 'object' || Array.isArray(value.policy)) throw new Error('Invalid notification policy');
      window.policy = {};
      for (const key of ['notificationsEnabled', 'desktopNotifications', 'sound', 'soundOnDone', 'desktopOnDone', 'notifyOnDone', 'notifyOnApproval', 'notifyOnQuestion', 'onlyWhenUnfocused']) {
        if (value.policy[key] !== undefined) {
          if (typeof value.policy[key] !== 'boolean') throw new Error('Invalid notification policy');
          window.policy[key] = value.policy[key];
        }
      }
    }
    window.lastFocusedAt = window.focused && !previous?.focused ? this.now() : previous?.lastFocusedAt || 0;
    if (previous && JSON.stringify(previous) === JSON.stringify(window)) return false;
    this.windows.set(clientId, window);
    return true;
  }
  remove(clientId) { return this.windows.delete(clientId); }
  select(record, observedBy = new Set()) {
    const candidates = [];
    for (const window of this.windows.values()) {
      const sameSource = window.sourceId === record.source.id;
      if (!sameSource && !(record.event.type === 'test' && observedBy.has(window.id))) continue;
      const roots = [...window.workspaceCwds, window.workspaceCwd].filter(Boolean);
      const length = matchLength(record.event.cwd || '', roots);
      if (sameSource && roots.length && record.event.cwd && length < 0) continue;
      candidates.push({window, length: Math.max(0, length)});
    }
    candidates.sort((a, b) => b.length - a.length || b.window.lastFocusedAt - a.window.lastFocusedAt || a.window.id.localeCompare(b.window.id));
    return candidates[0]?.window;
  }
}
module.exports = {WindowRegistry, normalizePath, matchLength};
