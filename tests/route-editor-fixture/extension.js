'use strict';
const vscode = require('vscode');
let last = null;
let lastSidebar = null;
let sidebarView;
exports.activate = context => {
  if (process.env.CODEX_NOTIFIER_TEST_EDITOR !== '1') throw new Error('This fixture may only run in isolated tests');
  context.subscriptions.push(vscode.commands.registerCommand('codexRouteFixture.snapshot', () => last));
  context.subscriptions.push(vscode.commands.registerCommand('codexRouteFixture.sidebarSnapshot', () => lastSidebar));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('codexRouteFixture.sidebar', {
    resolveWebviewView(view) {
      sidebarView = view;
      view.webview.html = '<!doctype html><html><body>Isolated sidebar fixture; no Codex backend.</body></html>';
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('chatgpt.openSidebar', () =>
    vscode.commands.executeCommand('codexRouteFixture.sidebar.focus')));
  context.subscriptions.push(vscode.window.registerUriHandler({handleUri(uri) {
    lastSidebar = {uri: uri.toString(), workspace: vscode.workspace.workspaceFolders?.[0]?.uri.toString(), visible: sidebarView?.visible};
  }}));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider('chatgpt.conversationEditor', {
    async openCustomDocument(uri) {
      return {uri, dispose() {}};
    },
    async resolveCustomEditor(document, panel) {
      last = {uri: document.uri.toString(), workspace: vscode.workspace.workspaceFolders?.[0]?.uri.toString(),
        viewType: panel.viewType};
      panel.webview.html = '<!doctype html><html><body><h1>Notifier route test</h1><p>This is an isolated fixture, not a Codex conversation.</p></body></html>';
    }
  }, {supportsMultipleEditorsPerDocument: false}));
};
