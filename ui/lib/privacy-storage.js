'use strict';
const {t} = require('./i18n');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONTROL_FILE = 'broker-privacy.json';
const DEFAULT_RETENTION_DAYS = 7;
const DAY = 86400000;
const CACHE_NAME = /^(?:broker-state(?:-v[2-5])?\.json(?:\.\d+\.[a-f0-9]{12}\.tmp)?|broker-token)$/u;

function retentionDays(value) {
  if (!Number.isInteger(value) || value < 1 || value > 30) throw new Error(t('缓存保留天数必须为 1–30 的整数'));
  return value;
}
function normalized(value) { return process.platform === 'win32' ? value.toLowerCase() : value; }
function checkDirectory(storage) {
  const absolute = path.resolve(storage);
  const info = fs.lstatSync(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || normalized(fs.realpathSync(absolute)) !== normalized(absolute)) {
    throw new Error(t('通知存储目录包含链接或重定向，已停止清理'));
  }
  return absolute;
}
function checkedFile(storage, name, allowMissing = false) {
  if (path.basename(name) !== name) throw new Error('Invalid privacy file name');
  const root = checkDirectory(storage);
  const file = path.join(root, name);
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || normalized(fs.realpathSync(file)) !== normalized(file) || info.nlink > 1) {
      throw new Error(t('通知缓存包含链接或非普通文件，已停止清理'));
    }
    return {file, info};
  } catch (error) { if (allowMissing && error.code === 'ENOENT') return {file, info: null}; throw error; }
}
function writeControl(storage, control) {
  const {file} = checkedFile(storage, CONTROL_FILE, true);
  const temporary = file + '.tmp-' + crypto.randomUUID();
  try {
    fs.writeFileSync(temporary, JSON.stringify(control), {flag: 'wx', mode: 0o600});
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
function readControl(storage) {
  const {file, info} = checkedFile(storage, CONTROL_FILE, true);
  if (!info) return {version: 1, retentionDays: DEFAULT_RETENTION_DAYS, paused: false, cutoff: 0};
  if (info.size > 4096) throw new Error(t('隐私控制文件异常；已停止接收通知'));
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value?.version !== 1 || typeof value.paused !== 'boolean' || !Number.isFinite(value.cutoff) || value.cutoff < 0) {
    throw new Error(t('隐私控制文件异常；已停止接收通知'));
  }
  return {version: 1, retentionDays: retentionDays(value.retentionDays), paused: value.paused, cutoff: value.cutoff};
}
function cacheFiles(storage) {
  checkDirectory(storage);
  return fs.readdirSync(storage).filter(name => CACHE_NAME.test(name)).sort().map(name => {
    const {info} = checkedFile(storage, name);
    return {name, bytes: info.size, modifiedAt: info.mtimeMs};
  });
}
function removeCacheFiles(storage, names) {
  // Validate every candidate before the first deletion. No recursive operations.
  for (const name of names) {
    if (!CACHE_NAME.test(name)) throw new Error('Refusing to remove non-cache file');
    checkedFile(storage, name, true);
  }
  let removed = 0;
  for (const name of names) {
    const {file, info} = checkedFile(storage, name, true);
    if (info) { fs.unlinkSync(file); removed++; }
  }
  return removed;
}
module.exports = {CONTROL_FILE, DEFAULT_RETENTION_DAYS, DAY, retentionDays, checkedFile,
  checkDirectory, readControl, writeControl, cacheFiles, removeCacheFiles};
