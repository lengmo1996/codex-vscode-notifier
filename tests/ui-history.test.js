'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {attention} = require('../ui/lib/presentation');
const {HistoryView} = require('../ui/lib/history');
const mock = {
  EventEmitter: class {fire() {} dispose() {}},
  TreeItem: class {constructor(label, state) {this.label = label; this.collapsibleState = state;}},
  ThemeIcon: class {constructor(id, color) {this.id = id; this.color = color;}},
  ThemeColor: class {constructor(id) {this.id = id;}},
  TreeItemCollapsibleState: {None: 0, Collapsed: 1, Expanded: 2},
};
const entry = (key, window, read, type = 'done') => ({key, targetWindowId: window, targetWindowLabel: window,
  receivedAt: 1000, read, source: {label: 'container'}, event: {type, cwd: '/project/' + key, session_id: 'session'}});

test('only the owning window gets colored attention and decisions sort before completion', () => {
  const entries = [entry('done', 'a', false), entry('approval', 'b', false, 'approval'), entry('read', 'a', true)];
  assert.equal(attention(entries, 'a').local.length, 1);
  assert.equal(attention(entries, 'a').needsDecision, false);
  assert.equal(attention(entries, 'b').needsDecision, true);
  assert.equal(attention(entries, 'c').local.length, 0);
  entries.push(entry('question', 'a', false, 'question'));
  assert.equal(attention(entries, 'a').local[0].key, 'question');
});

test('history separates current and other unread entries from collapsed read entries', () => {
  const view = new HistoryView(mock, 'a');
  view.update([entry('one', 'a', false), entry('two', 'b', false), entry('old', 'a', true)]);
  assert.deepEqual(view.getChildren().map(group => group.id), ['current-unread', 'other-unread', 'read']);
  assert.equal(view.getTreeItem(view.groups[0]).collapsibleState, 2);
  assert.equal(view.getTreeItem(view.groups[2]).collapsibleState, 1);
  assert.equal(view.getTreeItem(view.groups[0]).contextValue, 'unreadNotificationGroup');
  assert.equal(view.getTreeItem(view.groups[1]).contextValue, 'unreadNotificationGroup');
  assert.equal(view.getTreeItem(view.groups[2]).contextValue, 'readNotificationGroup');
  const unread = view.getTreeItem(view.groups[0].entries[0]);
  const read = view.getTreeItem(view.groups[2].entries[0]);
  assert.match(unread.label.label, /未读/);
  assert.ok(unread.label.highlights.length);
  assert.match(read.label, /已读/);
  assert.equal(unread.iconPath.color.id, 'list.warningForeground');
  assert.equal(read.iconPath.color.id, 'descriptionForeground');
  assert.equal(unread.command.command, 'codexNotifier.showEntry');
  assert.equal(unread.contextValue, 'unreadNotification');
  assert.equal(read.contextValue, 'readNotification');
});

test('history refresh after deleting one item or clearing read items preserves remaining unread groups', () => {
  const view = new HistoryView(mock, 'a');
  const local = entry('local', 'a', false);
  const other = entry('other', 'b', false);
  const read = entry('old', 'a', true);
  view.update([local, other, read]);
  view.update([local, other]);
  assert.deepEqual(view.groups.map(group => group.id), ['current-unread', 'other-unread']);
  assert.equal(view.getParent(read), undefined);
  view.update([other]);
  assert.deepEqual(view.groups.map(group => group.id), ['other-unread']);
  assert.equal(view.getParent(local), undefined);
  view.update([]);
  assert.deepEqual(view.getChildren(), []);
  view.dispose();
});
