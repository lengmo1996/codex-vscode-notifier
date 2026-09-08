'use strict';
const {t, getLanguage} = require('./i18n');
const {WindowTitleController} = require('./window-title');
const {TitlePulse} = require('./title-pulse');

class WindowAttention {
  constructor(vscode, client, {log = () => {}, testing = false} = {}) {
    this.vscode = vscode; this.client = client; this.log = log; this.testing = testing;
    this.title = new WindowTitleController(vscode);
    this.pulse = new TitlePulse(async prefix => {
      const result = await this.title.update(prefix);
      if (!this.disposed && result.applied) { this.state.displayPrefix = prefix; this.state.frames = (this.state.frames || 0) + 1; }
      return result;
    }, {onError: error => this.log(t('窗口标题闪动：') + error.message)});
    this.state = {ready: false, bound: false, count: 0, prefix: ''};
    this.desired = {entries: [], enabled: true, focused: false, blink: true};
    this.chain = Promise.resolve(); this.disposed = false; this.lastSignature = ''; this.revision = 0; this.desiredSignature = '';
    this.nextBindAt = 0; this.lastError = '';
  }
  update(entries, {enabled = true, focused = false, blink = true} = {}) {
    this.desired = {entries, enabled, focused, blink};
    const signature = JSON.stringify([getLanguage(), enabled, focused, blink, entries.map(entry => [entry.key, entry.event.type])]);
    if (signature !== this.desiredSignature) { this.desiredSignature = signature; ++this.revision; }
    // Stop animation immediately even if native binding is still being awaited.
    if ((!entries.length || !enabled || !blink) && this.state.ready) {
      const prefix = enabled && entries.length ? this.state.prefix : '';
      this.pulse.update(prefix, false).catch(error => this.log(error.message));
    }
    // Serialize title nonce binding and native updates. Read the latest state
    // only when running so read/clear operations cannot leave stale yellow state.
    this.chain = this.chain.catch(() => {}).then(() => this.apply()).catch(error => {
      this.state.error = error.message;
      if (this.lastError !== error.message) { this.lastError = error.message; this.log(t('窗口任务栏提示：') + error.message); }
    });
    return this.chain;
  }
  reset() { this.state.bound = false; this.nextBindAt = 0; this.lastSignature = ''; }
  async apply() {
    if (this.disposed) return;
    if (!this.desired.enabled && !this.state.ready) return;
    if (!this.state.ready) {
      const result = await this.title.initialize();
      this.state.ready = !!result.supported && !!result.configured;
      if (!this.state.ready) throw new Error(result.reason || t('当前 VS Code 不支持窗口标题标记'));
    }
    const revision = this.revision;
    const {entries, enabled, focused, blink} = this.desired;
    const current = enabled ? entries : [];
    const decision = current.some(entry => ['approval', 'question'].includes(entry.event.type));
    const count = current.length;
    const prefix = count ? `${decision ? t('🔴 待处理') : t('🟡 本轮已回复')} ${count}` : '';
    const titleResult = await this.pulse.update(prefix, blink && count > 0);
    if (!titleResult.applied) throw new Error(titleResult.reason || t('窗口标题标记未应用'));
    if (this.disposed || revision !== this.revision) return;
    this.state.prefix = prefix; this.state.count = count;
    if (!this.state.bound && enabled && Date.now() >= this.nextBindAt) {
      this.nextBindAt = Date.now() + 60000;
      const marker = `[CodexNotifier:${this.client.clientId}]`;
      const result = await this.title.withBindingMarker(marker, async () => {
        for (let attempt = 0; attempt < 20 && !this.disposed; attempt++) {
          const bound = await this.client.request('attentionBind', {marker,
            pid: Number(process.env.VSCODE_PID), executable: process.execPath});
          if (bound.bound || bound.disabled) return bound;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw new Error(t('无法唯一定位当前窗口；标题标记已保留，将稍后重试任务栏颜色'));
      });
      this.state.bound = !!result.bound; this.state.disabled = !!result.disabled;
      if (result.disabled) this.nextBindAt = Infinity;
    }
    if (this.disposed || revision !== this.revision) return;
    const keys = new Set(current.map(entry => entry.key));
    // Unread notifications received in the foreground must start flashing on
    // blur too. Commit lastSignature only after success so failures can retry.
    const flash = !focused && count > 0;
    if (!this.state.bound) return;
    const signature = JSON.stringify([count, decision, focused, [...keys]]);
    if (signature === this.lastSignature) return;
    const result = await this.client.request('attentionUpdate', {count, needsDecision: decision, flash});
    if (!result.bound) { this.reset(); return; }
    this.state.color = result.color;
    if (this.testing) this.state.nativeTitle = result.title;
    this.lastSignature = signature; this.lastError = ''; delete this.state.error;
  }
  dispose() { this.disposed = true; this.pulse.dispose(); this.title.dispose(); }
}
module.exports = {WindowAttention};
