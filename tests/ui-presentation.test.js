'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {notificationOptions, validEnvelope, projectName, eventTitle} = require('../ui/lib/presentation');
const config = values => ({get: (key, fallback) => key in values ? values[key] : fallback});

test('foreground alert opens only the selected notification; dismissal and privacy reset do nothing', async () => {
  const {showWindowAlert} = require('../ui/lib/presentation');
  const opened = []; let history = 0, reset = false, dismiss = false;
  const vscode = {window: {state: {focused: true}, showInformationMessage: async (_, action) => dismiss ? undefined : action}};
  const handlers = {open: key => opened.push(key), history: () => history++, cancelled: () => reset};
  await showWindowAlert(vscode, {title: 'Codex', body: 'done', keys: ['a']}, handlers);
  assert.deepEqual(opened, ['a']);
  await showWindowAlert(vscode, {title: 'Codex', body: 'done', keys: ['b', 'c']}, handlers);
  assert.equal(history, 1);
  dismiss = true;
  await showWindowAlert(vscode, {keys: ['d']}, handlers);
  dismiss = false;
  vscode.window.showInformationMessage = async (_, action) => {reset = true; return action;};
  await showWindowAlert(vscode, {keys: ['e']}, handlers);
  assert.deepEqual(opened, ['a']);
});

test('pausing suppresses both display and sound while keeping the ingest path available', () => {
  assert.deepEqual(notificationOptions(config({notificationsEnabled: false}), false, 'approval'), {desktop: false, sound: false});
});
test('sound and desktop are independent settings', () => {
  assert.deepEqual(notificationOptions(config({desktopNotifications: false, soundOnDone: true}), false, 'done'), {desktop: false, sound: true});
  assert.deepEqual(notificationOptions(config({sound: false}), false, 'question'), {desktop: true, sound: false});
});

test('reply-end sounds are independently controlled while questions and approvals remain audible', () => {
  assert.deepEqual(notificationOptions(config({}), false, 'done'), {desktop: false, sound: true});
  assert.deepEqual(notificationOptions(config({soundOnDone: false}), false, 'done'), {desktop: false, sound: false});
  assert.equal(notificationOptions(config({desktopOnDone: true}), false, 'done').desktop, true);
  assert.equal(notificationOptions(config({soundOnDone: true}), false, 'done').sound, true);
  assert.equal(notificationOptions(config({soundOnDone: false}), false, 'approval').sound, true);
  assert.equal(notificationOptions(config({soundOnDone: false}), false, 'question').sound, true);
  assert.equal(notificationOptions(config({sound: false, soundOnDone: true}), false, 'done').sound, false);
});
test('background-only and event filters are honored', () => {
  assert.deepEqual(notificationOptions(config({onlyWhenUnfocused: true}), true, 'done'), {desktop: false, sound: false});
  assert.deepEqual(notificationOptions(config({notifyOnDone: false}), false, 'done'), {desktop: false, sound: false});
  assert.deepEqual(notificationOptions(config({notifyOnDone: false}), false, 'approval'), {desktop: true, sound: true});
});
test('invalid tool messages never enter the event path', () => {
  assert.equal(validEnvelope({version: 1, kind: 'event', source: {id: 'a'}, event: {type: 'unknown', id: 'x', version: 1}}), false);
  assert.equal(validEnvelope({version: 1, kind: 'event', source: {id: 'a'}, event: {type: 'question', id: 'x', version: 1}}), true);
  assert.equal(validEnvelope({version: 1, kind: 'status', source: {id: 'a'}, status: {state: 'connected'}}), true);
});
test('history labels preserve source and project without exposing question content', () => {
  assert.equal(projectName('/projects/rgb2t/'), 'rgb2t');
  assert.equal(projectName('D:\\projects\\rgb2t'), 'rgb2t');
  const text = eventTitle({source: {label: 'H100\ncontainer'}, event: {type: 'approval', prompt: 'private'}});
  assert.ok(text.includes('H100 container'));
  assert.ok(!text.includes('private'));
});
