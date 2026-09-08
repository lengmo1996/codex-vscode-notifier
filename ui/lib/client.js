'use strict';
const {t, diagnostic} = require('./i18n');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {EventEmitter} = require('node:events');
const {BROKER_PROTOCOL_VERSION} = require('./broker-core');
const {loadIdentity, tlsOptions, verifyPeer, checkPeer, securityError} = require('./ipc-security');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class BrokerClient extends EventEmitter {
  constructor(storage, brokerScript, options = {}) {
    super();
    this.storage = storage;
    this.script = brokerScript;
    this.options = options;
    const suffix = crypto.createHash('sha256').update(path.resolve(storage)).digest('hex').slice(0, 24);
    this.pipe = process.platform === 'win32' ? `\\\\.\\pipe\\codex-notifier-secure-v1-p${BROKER_PROTOCOL_VERSION}-` + suffix : path.join(storage, `broker-secure-v1-p${BROKER_PROTOCOL_VERSION}.sock`);
    this.clientId = crypto.randomUUID();
    this.pending = new Map();
    this.socket = null;
    this.connecting = null;
    this.closed = false;
    this.authenticated = false;
  }

  async connect() {
    if (this.closed) throw new Error(t('通知连接已关闭'));
    if (this.socket && !this.socket.destroyed && this.authenticated) return;
    if (this.connecting) return this.connecting;
    this.connecting = this._connect();
    try { await this.connecting; } finally { this.connecting = null; }
  }

  async _connect() {
    this.identity = loadIdentity(this.storage);
    let launched = false;
    let lastError;
    for (let attempt = 0; attempt < 40 && !this.closed; attempt++) {
      try {
        await this._openSocket();
        const hello = await this._raw({op: 'hello', version: BROKER_PROTOCOL_VERSION, clientId: this.clientId});
        if (this.closed || !this.socket || this.socket.destroyed) throw new Error(t('通知连接已关闭'));
        if (hello?.version !== BROKER_PROTOCOL_VERSION) {
          const error = new Error(t('本机通知组件协议版本不匹配，请重载更新后的窗口'));
          error.code = 'BROKER_PROTOCOL_MISMATCH';
          throw error;
        }
        this.authenticated = true;
        if (!hello.capabilities?.includes('notification-language-v1')) this.emit('diagnostic', t('旧版通知后台仍在运行。请在任务空闲后关闭所有 VS Code 窗口，等待 10 秒再重新打开，以启用原生通知语言切换。'));
        this.emit('connected');
        return;
      } catch (error) {
        lastError = error;
        if (this.socket) this.socket.destroy();
        this.authenticated = false;
        if (error.code === 'BROKER_PROTOCOL_MISMATCH' || error.code === 'BROKER_AUTH_FAILED') throw error;
        if (this.closed) break;
        if (!launched) {
          launched = true;
          const child = spawn(process.execPath, [this.script, '--storage', this.storage, '--pipe', this.pipe], {
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe'],
            env: {...process.env, ELECTRON_RUN_AS_NODE: '1', ...this.options.env}
          });
          child.on('error', err => this.emit('diagnostic', t('通知组件启动失败：') + err.message));
          child.stderr.on('data', data => this.emit('diagnostic', data.toString('utf8').slice(0, 1000)));
          child.unref();
        }
        await delay(200);
      }
    }
    throw new Error(t('无法启动本机通知组件：') + (lastError?.message || t('连接超时')));
  }

  _openSocket() {
    return new Promise((resolve, reject) => {
      const raw = net.createConnection(this.pipe);
      let reachedServer = false;
      raw.once('connect', () => { reachedServer = true; });
      const socket = tls.connect({...tlsOptions(this.identity), socket: raw, checkServerIdentity: checkPeer(this.identity)});
      this.socket = socket;
      let buffer = '';
      const timeout = setTimeout(() => socket.destroy(reachedServer ? securityError(t('本机通知身份验证超时')) : new Error(t('本机连接超时'))), 5000);
      socket.setEncoding('utf8');
      socket.once('secureConnect', () => {
        try { verifyPeer(socket, this.identity); clearTimeout(timeout); resolve(); }
        catch (error) { socket.destroy(error); reject(error); }
      });
      socket.on('error', error => {
        clearTimeout(timeout);
        if (reachedServer && !this.authenticated && !['ENOENT', 'ECONNREFUSED'].includes(error.code)) error.code = 'BROKER_AUTH_FAILED';
        reject(error);
      });
      socket.on('data', chunk => {
        if (this.socket !== socket || this.closed) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer, 'utf8') > 4 * 1024 * 1024) {
          socket.destroy(new Error(t('通知响应过大')));
          return;
        }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const message = JSON.parse(line);
            if (message.requestId && this.pending.has(message.requestId)) {
              const deferred = this.pending.get(message.requestId);
              this.pending.delete(message.requestId); clearTimeout(deferred.timer);
              if (deferred.hello) {
                if (!message.ok) { deferred.reject(securityError(t('本机通知握手失败'))); socket.destroy(); return; }
                if (message.result?.version !== BROKER_PROTOCOL_VERSION) {
                  const error = new Error(t('本机通知组件协议版本不匹配，请重载更新后的窗口')); error.code = 'BROKER_PROTOCOL_MISMATCH';
                  deferred.reject(error); socket.destroy(); return;
                }
                this.authenticated = true;
              }
              message.ok ? deferred.resolve(message.result) : deferred.reject(new Error(diagnostic(String(message.error || t('通知请求失败')))));
            } else if (message.type && this.authenticated) {
              this.emit(message.type, message);
            } else if (!this.authenticated) {
              socket.destroy(securityError(t('认证完成前收到了通知消息'))); return;
            }
          } catch { socket.destroy(securityError(t('本机通知消息格式异常'))); return; }
        }
      });
      socket.on('close', () => {
        clearTimeout(timeout);
        // A pre-connect close need not carry an error event. Once connected,
        // this rejection is harmless because the opening promise is settled.
        reject(reachedServer ? securityError(t('本机通知连接在身份验证时关闭')) : new Error(t('本机通知连接在建立前关闭')));
        if (this.socket === socket) {
          const wasAuthenticated = this.authenticated;
          this.socket = null; this.authenticated = false;
          for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(t('本机通知连接中断'))); }
          this.pending.clear();
          if (!this.closed && wasAuthenticated) this.emit('disconnected');
        }
      });
    });
  }

  _raw(payload) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      if (!this.socket || this.socket.destroyed) return reject(new Error(t('通知组件未连接')));
      if (!this.authenticated && payload.op !== 'hello') return reject(securityError(t('本机通知身份验证尚未完成')));
      const timer = setTimeout(() => {
        this.pending.delete(requestId); reject(new Error(t('通知请求超时')));
      }, 15000);
      this.pending.set(requestId, {resolve, reject, timer, hello: payload.op === 'hello'});
      this.socket.write(JSON.stringify({...payload, requestId}) + '\n', error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(requestId); reject(error);
      });
    });
  }

  async request(op, payload = {}) { await this.connect(); return this._raw({...payload, op}); }
  dispose() {
    this.closed = true;
    this.socket?.destroy();
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(t('通知扩展已关闭'))); }
    this.pending.clear();
    this.removeAllListeners();
  }
}

module.exports = {BrokerClient};
