'use strict';

// This command exists in VS Code's title service without a proposed-API gate.
// Check it at runtime: it is not a member of the stable vscode.window interface.
const REGISTER_COMMAND = 'registerWindowTitleVariable';
const CONTEXT_COMMAND = 'setContext';

function validIdentifier(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,100}$/u.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function titleText(value) {
  if (typeof value !== 'string') throw new Error('Window title prefix must be a string');
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 180);
}

class WindowTitleController {
  constructor(vscode, options = {}) {
    this.vscode = vscode;
    this.variableName = validIdentifier(options.variableName || 'codexNotification', 'window title variable');
    this.contextKey = validIdentifier(options.contextKey || 'codexNotifier.windowTitle', 'window title context key');
    this.token = '${' + this.variableName + '}';
    this.serialize = options.serialize || (operation => operation());
    this.desiredPrefix = '';
    this.disposed = false;
    this.binding = false;
    this.registered = false;
    this.initialization = null;
    this.commandQueue = Promise.resolve();
    this.bindingQueue = Promise.resolve();
    this.result = { supported: false, configured: false, scope: null };
  }

  initialize() {
    if (this.disposed) return Promise.resolve({ supported: false, configured: false, scope: null, reason: 'Window title controller is disposed' });
    if (!this.initialization) this.initialization = this._initialize();
    return this.initialization;
  }

  async _initialize() {
    try {
      const commands = await this.vscode.commands.getCommands(true);
      if (this.disposed) return this.result;
      if (!commands.includes(REGISTER_COMMAND)) {
        return this.result = { supported: false, configured: false, scope: null, reason: 'VS Code does not expose registerWindowTitleVariable' };
      }
      await this.vscode.commands.executeCommand(REGISTER_COMMAND, this.variableName, this.contextKey);
      this.registered = true;
      if (this.disposed) return this.result;
      const configured = await this.serialize(() => this._ensureTemplate());
      this.result = { supported: true, ...configured };
      if (configured.configured && !this.disposed) await this._setContext(this.desiredPrefix);
      return this.result;
    } catch (error) {
      return this.result = { supported: this.registered, configured: false, scope: this.result.scope, reason: error.message };
    }
  }

  _configuration() { return this.vscode.workspace.getConfiguration('window'); }

  _effectiveState() {
    const configuration = this._configuration();
    const inspection = configuration.inspect('title');
    const template = configuration.get('title');
    const workspaceOverride = inspection && inspection.workspaceValue !== undefined;
    return { configuration, template, scope: workspaceOverride ? 'workspace' : 'global',
      target: workspaceOverride ? this.vscode.ConfigurationTarget.Workspace : this.vscode.ConfigurationTarget.Global };
  }

  async _ensureTemplate() {
    let current = this._effectiveState();
    if (typeof current.template !== 'string') return { configured: false, scope: current.scope, reason: 'window.title is not a string' };
    if (current.template.includes(this.token)) return { configured: true, scope: current.scope, changed: false };

    // Re-read just before the write. Preserve the latest template, including a
    // workspace override added while initialization was in progress. No stale
    // snapshot is restored during disposal or after a later user edit.
    current = this._effectiveState();
    if (this.disposed) return { configured: false, scope: current.scope, reason: 'Window title controller is disposed' };
    if (typeof current.template !== 'string') return { configured: false, scope: current.scope, reason: 'window.title is not a string' };
    if (current.template.includes(this.token)) return { configured: true, scope: current.scope, changed: false };
    const template = this.token + '${separator}' + current.template;
    await current.configuration.update('title', template, current.target);
    const applied = this._configuration().get('title');
    return { configured: typeof applied === 'string' && applied.includes(this.token), scope: current.scope, changed: true,
      ...(typeof applied === 'string' && applied.includes(this.token) ? {} : { reason: 'An overriding window.title setting prevents the notification prefix' }) };
  }

  _setContext(value) {
    const run = async () => {
      if (this.disposed && value !== '') return false;
      if (!this.registered) return false;
      await this.vscode.commands.executeCommand(CONTEXT_COMMAND, this.contextKey, value);
      return true;
    };
    const pending = this.commandQueue.then(run, run);
    this.commandQueue = pending.catch(() => {});
    return pending;
  }

  _templateContainsVariable() {
    const template = this._configuration().get('title');
    return typeof template === 'string' && template.includes(this.token);
  }

  async update(prefix) {
    this.desiredPrefix = titleText(prefix);
    if (this.disposed) return { applied: false, reason: 'Window title controller is disposed' };
    const initialized = await this.initialize();
    if (!initialized.configured || !this._templateContainsVariable()) {
      return { applied: false, reason: initialized.reason || 'The window title template no longer contains the notification variable' };
    }
    // A friendly update arriving during native HWND discovery is retained and
    // restored by its finally block, without replacing the discovery marker.
    if (this.binding) return { applied: true, deferred: true };
    return { applied: await this._setContext(this.desiredPrefix) };
  }

  withBindingMarker(marker, bind) {
    if (typeof marker !== 'string' || !/^[A-Za-z0-9\[\]_.:-]{8,160}$/u.test(marker)) return Promise.reject(new Error('Invalid window binding marker'));
    if (typeof bind !== 'function') return Promise.reject(new Error('Window binding callback is required'));
    const run = async () => {
      const initialized = await this.initialize();
      if (this.disposed || !initialized.configured || !this._templateContainsVariable()) {
        throw new Error(initialized.reason || 'Window title binding is unavailable');
      }
      this.binding = true;
      try {
        await this._setContext(marker);
        if (this.disposed) throw new Error('Window title controller is disposed');
        // VS Code schedules native title updates asynchronously. The callback
        // should poll EnumWindows for this exact marker with a bounded timeout.
        return await bind(marker);
      } finally {
        this.binding = false;
        await this._setContext(this.disposed ? '' : this.desiredPrefix);
      }
    };
    const pending = this.bindingQueue.then(run, run);
    this.bindingQueue = pending.catch(() => {});
    return pending;
  }

  dispose() {
    this.disposed = true;
    this.desiredPrefix = '';
    // Leave the user's current template intact; an empty context resolves the
    // variable to no text. Uninstall instructions can remove the one token.
    return this._setContext('').catch(() => {});
  }
}

module.exports = { WindowTitleController, REGISTER_COMMAND, CONTEXT_COMMAND };
