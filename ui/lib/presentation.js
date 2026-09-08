'use strict';
const {t} = require('./i18n');
const LABELS = {done: '本轮已回复', approval: '等待批准', question: '等待回答', test: '通知测试'};

function clean(value, limit = 400) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit) : '';
}

function projectName(cwd) { return clean(cwd).replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() || t('未提供项目'); }

function eventTitle(entry) {
  return `${t(LABELS[entry.event?.type] || '会话更新')} · ${clean(entry.source?.label || entry.source?.host) || t('未知来源')}`;
}

function attention(entries, windowId) {
  const unread = entries.filter(entry => !entry.read);
  const local = unread.filter(entry => entry.targetWindowId === windowId);
  const priority = {approval: 0, question: 1, done: 2, test: 3};
  local.sort((a, b) => (priority[a.event.type] ?? 4) - (priority[b.event.type] ?? 4) || b.receivedAt - a.receivedAt);
  return {local, unread, needsDecision: local.some(entry => ['approval', 'question'].includes(entry.event.type))};
}

function historyGroups(entries, windowId) {
  const ordered = [...entries].sort((a, b) => b.receivedAt - a.receivedAt);
  return [
    {id: 'current-unread', title: t('本窗口待处理'), unread: true, entries: ordered.filter(entry => !entry.read && entry.targetWindowId === windowId)},
    {id: 'other-unread', title: t('其他窗口／未连接的待处理'), unread: true, entries: ordered.filter(entry => !entry.read && entry.targetWindowId !== windowId)},
    {id: 'read', title: t('已读'), unread: false, entries: ordered.filter(entry => entry.read)},
  ].filter(group => group.entries.length > 0);
}

function notificationOptions(config, focused, type) {
  const enabled = config.get('notificationsEnabled', true);
  const filter = {done: 'notifyOnDone', approval: 'notifyOnApproval', question: 'notifyOnQuestion'}[type];
  const active = enabled && (!filter || config.get(filter, true)) && (!config.get('onlyWhenUnfocused', false) || !focused);
  return {desktop: active && config.get('desktopNotifications', true) && (type !== 'done' || config.get('desktopOnDone', false)),
    sound: active && config.get('sound', true) && (type !== 'done' || config.get('soundOnDone', true))};
}

function validEnvelope(payload) {
  if (!payload || payload.version !== 1 || !['event', 'status'].includes(payload.kind)) return false;
  if (!payload.source || typeof payload.source.id !== 'string' || !payload.source.id || payload.source.id.length > 256) return false;
  if (payload.kind === 'status') return payload.status && typeof payload.status.state === 'string';
  const event = payload.event;
  return event && event.version === 1 && typeof event.id === 'string' && event.id.length > 0 && event.id.length <= 256 &&
    ['done', 'approval', 'question', 'test'].includes(event.type);
}

module.exports = {clean, projectName, eventTitle, notificationOptions, validEnvelope, attention, historyGroups};
