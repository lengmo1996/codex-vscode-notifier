'use strict';
const {t} = require('./i18n');
const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');
const {spawn} = require('node:child_process');
const {Duplex} = require('node:stream');
const {EventEmitter} = require('node:events');
const {powershell, helper, tlsOptions, verifyPeer} = require('./ipc-security');
const MAX_QUEUE = 4 * 1024 * 1024;

class RelaySocket extends Duplex {
  constructor(server, id) { super(); this.server = server; this.id = id; this.writeId = 0; this.pendingWrite = null; }
  _read() {}
  _write(chunk, encoding, callback) {
    const writeId = String(++this.writeId); this.pendingWrite = {writeId, callback};
    if (!this.server.command({type: 'write', id: this.id, writeId, data: chunk.toString('base64')}))
      this.destroy(new Error(t('本机安全管道已关闭')));
  }
  _destroy(error, callback) {
    this.server.sockets.delete(this.id);
    this.server.command({type: 'close', id: this.id});
    if (this.pendingWrite) { const pending = this.pendingWrite; this.pendingWrite = null; pending.callback(error || new Error(t('本机安全管道已关闭'))); }
    callback(error);
  }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
}
class WindowsPipeServer extends EventEmitter {
  constructor() { super(); this.sockets = new Map(); this.child = null; this.listening = false; this.closed = false; }
  command(message) {
    const child = this.child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) return false;
    const line = JSON.stringify(message) + '\n';
    if (child.stdin.writableLength + Buffer.byteLength(line) > 6 * MAX_QUEUE) { this.fail(new Error(t('本机管道发送队列过大'))); return false; }
    child.stdin.write(line); return true;
  }
  fail(error) { if (this.closed) return; this.emit('error', error); this.close(); }
  listen(pipe) {
    const child = spawn(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', helper, '-Mode', 'Serve', '-Pipe', pipe], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    this.child = child;
    let buffer = '', diagnostic = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) return this.fail(new Error(t('本机管道组件输出异常')));
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        try {
          const message = JSON.parse(line);
          if (message.type === 'ready') { this.listening = true; this.emit('listening'); }
          else if (message.type === 'error') { const error = new Error(message.error); error.code = message.code; return this.fail(error); }
          else if (message.type === 'connection') {
            const socket = new RelaySocket(this, message.id); this.sockets.set(message.id, socket);
            socket.on('error', () => {}); this.emit('connection', socket);
          } else {
            const socket = this.sockets.get(message.id); if (!socket) continue;
            if (message.type === 'close') { socket.push(null); socket.destroy(); }
            else if (message.type === 'data') {
              const data = Buffer.from(message.data, 'base64');
              if (socket.readableLength + data.length > MAX_QUEUE) socket.destroy(new Error(t('本机管道接收队列过大')));
              else socket.push(data);
            } else if (message.type === 'written' && socket.pendingWrite?.writeId === message.writeId) {
              const pending = socket.pendingWrite; socket.pendingWrite = null; pending.callback();
            }
          }
        } catch (error) { return this.fail(error); }
      }
    });
    child.stderr.on('data', data => { diagnostic = (diagnostic + data.toString()).slice(-1000); });
    child.stdin.on('error', error => this.fail(error)); child.on('error', error => this.fail(error));
    child.on('exit', () => { if (!this.closed) this.fail(new Error(t('本机安全管道组件已退出：') + diagnostic)); });
    const startup = setTimeout(() => { if (!this.listening && !this.closed) this.fail(new Error(t('本机安全管道启动超时'))); }, 15000);
    startup.unref(); this.once('listening', () => clearTimeout(startup)); this.once('close', () => clearTimeout(startup));
    return this;
  }
  close(callback) {
    if (callback) this.once('close', callback);
    if (this.closed) return this;
    this.closed = true; this.listening = false;
    for (const socket of this.sockets.values()) socket.destroy();
    const child = this.child; this.child = null;
    if (child) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 2000); timer.unref();
      child.once('close', () => { clearTimeout(timer); this.emit('close'); });
    } else queueMicrotask(() => this.emit('close'));
    return this;
  }
}
function createSecureServer(identity) {
  const server = new EventEmitter();
  const transport = process.platform === 'win32' ? new WindowsPipeServer() : net.createServer();
  const connections = new Set();
  const tlsServer = tls.createServer({...tlsOptions(identity), requestCert: true, handshakeTimeout: 5000}, socket => {
    try { verifyPeer(socket, identity); } catch (error) { socket.destroy(error); return; }
    server.emit('connection', socket);
  });
  tlsServer.on('tlsClientError', (_error, socket) => socket.destroy());
  transport.on('connection', socket => {
    if (connections.size >= 64) { socket.destroy(); return; }
    connections.add(socket); socket.once('close', () => connections.delete(socket));
    tlsServer.emit('connection', socket);
  });
  transport.on('error', error => server.emit('error', error));
  transport.on('close', () => server.emit('close'));
  server.listen = pipe => {
    transport.once('listening', () => {
      try { if (process.platform !== 'win32') fs.chmodSync(pipe, 0o600); }
      catch (error) { transport.close(); server.emit('error', error); return; }
      server.emit('listening');
    });
    transport.listen(pipe); return server;
  };
  server.close = callback => {
    for (const socket of connections) socket.destroy();
    transport.close(callback); return server;
  };
  return server;
}
module.exports = {createSecureServer, WindowsPipeServer};
