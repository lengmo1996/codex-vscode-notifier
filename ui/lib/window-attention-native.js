'use strict';
const {t} = require('./i18n');
const {spawn} = require('node:child_process');
const path = require('node:path');

// One helper per broker, shared by every VS Code window. No foreground-window
// guesses: a title nonce identifies the window before a native handle is leased.
class WindowAttentionNative {
  constructor() { this.child = null; this.pending = new Map(); this.sequence = 0; this.closed = false; }
  start() {
    if (this.closed) throw new Error('Window attention helper is closed');
    if (this.child) return;
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', path.resolve(__dirname, '../assets/window-attention.ps1')], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    this.child = child;
    let buffer = '', diagnostic = '';
    const fail = error => {
      if (this.child !== child) return;
      this.child = null;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer); pending.reject(error); this.pending.delete(id);
      }
      child.kill();
    };
    this.failCurrent = fail;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 65536) return fail(new Error('Invalid window attention response'));
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        let data;
        try { data = JSON.parse(line); } catch { continue; }
        if (!data || typeof data !== 'object' || typeof data.requestId !== 'string') continue;
        const pending = this.pending.get(data.requestId);
        if (!pending) continue;
        this.pending.delete(data.requestId); clearTimeout(pending.timer);
        if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data.result);
      }
    });
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-1000); });
    child.stdin.on('error', fail); child.on('error', fail);
    child.on('exit', () => fail(new Error('Window attention helper exited' + (diagnostic ? ': ' + diagnostic : ''))));
  }
  request(op, payload = {}) {
    if (process.platform !== 'win32') return Promise.resolve({disabled: true});
    this.start();
    const requestId = String(++this.sequence);
    const child = this.child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.failCurrent(new Error(t('窗口任务栏组件响应超时'))), 12000);
      this.pending.set(requestId, {resolve, reject, timer});
      child.stdin.write(JSON.stringify({...payload, op, requestId}) + '\n', error => {
        if (!error || !this.pending.delete(requestId)) return;
        clearTimeout(timer); reject(error);
      });
    });
  }
  close() {
    this.closed = true;
    if (this.child) {
      const child = this.child;
      child.stdin.end(); // EOF releases native properties and attention state.
      const deadline = setTimeout(() => child.kill(), 2000);
      deadline.unref(); child.once('exit', () => clearTimeout(deadline));
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(new Error('Window attention helper closed'));
    }
    this.pending.clear();
  }
}
module.exports = {WindowAttentionNative};
