'use strict';
const {t} = require('./i18n');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const identities = new Map();
const TLS_CIPHERS = 'TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-CHACHA20-POLY1305';
const powershell = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const helper = path.resolve(__dirname, '../assets/secure-pipe.ps1');
function securityError(message) { const error = new Error(message); error.code = 'BROKER_AUTH_FAILED'; return error; }

function privatePosixPath(file, directory) {
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || info.uid !== process.getuid() || (!directory && info.nlink !== 1))
    throw securityError(t('通知存储所有者或文件类型异常'));
  fs.chmodSync(file, directory ? 0o700 : 0o600);
}
function posixIdentity(storage) {
  for (let current = path.resolve(storage); ; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw securityError(t('通知存储路径包含链接')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
  fs.mkdirSync(storage, {recursive: true, mode: 0o700});
  privatePosixPath(storage, true);
  const directory = path.join(storage, 'ipc-security-v1');
  fs.mkdirSync(directory, {mode: 0o700, recursive: true}); privatePosixPath(directory, true);
  const file = path.join(directory, 'identity.json');
  if (!fs.existsSync(file)) {
    const temporary = fs.mkdtempSync(path.join(directory, '.identity-'));
    try {
      const key = path.join(temporary, 'key.pem'), cert = path.join(temporary, 'cert.pem');
      const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
        '-days', '3650', '-subj', '/CN=Codex-Notifier-' + crypto.randomUUID(), '-addext', 'extendedKeyUsage=serverAuth,clientAuth'],
      {encoding: 'utf8', timeout: 30000, windowsHide: true});
      if (result.error || result.status !== 0) throw securityError(t('创建本机 TLS 身份失败；非 Windows 平台需要系统 OpenSSL'));
      const identity = JSON.stringify({key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(cert, 'utf8')});
      const staged = path.join(temporary, 'identity.json'); fs.writeFileSync(staged, identity, {mode: 0o600});
      try { fs.linkSync(staged, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
  }
  privatePosixPath(file, false);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function loadIdentity(storage) {
  const directory = path.resolve(storage);
  if (identities.has(directory)) return identities.get(directory);
  let identity;
  try {
    if (process.platform === 'win32') {
      const result = spawnSync(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', helper, '-Mode', 'Key', '-Storage', directory], {encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 65536});
      if (result.error || result.status !== 0) throw securityError(t('无法保护本机通知存储或加载身份：') + (result.error?.message || result.stderr.trim()).slice(0, 1000));
      const data = JSON.parse(result.stdout);
      const raw = Buffer.from(data.cert, 'base64');
      identity = {pfx: Buffer.from(data.pfx, 'base64'), passphrase: '', cert: new crypto.X509Certificate(raw).toString(),
        ca: new crypto.X509Certificate(Buffer.from(data.ca, 'base64')).toString()};
    } else identity = posixIdentity(directory);
    identity.raw = new crypto.X509Certificate(identity.cert).raw;
    const certificate = new crypto.X509Certificate(identity.cert);
    if (certificate.publicKey.asymmetricKeyDetails?.modulusLength < 2048 || Date.parse(certificate.validTo) <= Date.now())
      throw securityError(t('本机通知身份无效或已过期'));
  } catch (error) { if (!error.code?.startsWith('BROKER_')) error.code = 'BROKER_AUTH_FAILED'; throw error; }
  identities.set(directory, identity);
  return identity;
}
function tlsOptions(identity) {
  const credential = identity.pfx ? {pfx: identity.pfx, passphrase: ''} : {key: identity.key, cert: identity.cert};
  return {...credential, ca: [identity.ca || identity.cert], minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3', ciphers: TLS_CIPHERS,
    honorCipherOrder: true, rejectUnauthorized: true};
}
function verifyPeer(socket, identity) {
  const raw = socket.getPeerCertificate()?.raw;
  if (!socket.authorized || !Buffer.isBuffer(raw) || raw.length !== identity.raw.length || !crypto.timingSafeEqual(raw, identity.raw))
    throw securityError(t('本机通知组件身份验证失败'));
  if (!['TLSv1.2', 'TLSv1.3'].includes(socket.getProtocol())) throw securityError(t('不支持的本机安全协议'));
}
function checkPeer(identity) {
  return (_hostname, certificate) => {
    const raw = certificate?.raw;
    if (!Buffer.isBuffer(raw) || raw.length !== identity.raw.length || !crypto.timingSafeEqual(raw, identity.raw))
      return securityError(t('本机通知组件身份验证失败'));
  };
}
module.exports = {loadIdentity, tlsOptions, verifyPeer, checkPeer, securityError, powershell, helper};
