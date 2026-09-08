'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const {once} = require('node:events');
const {spawn, spawnSync} = require('node:child_process');
const {BrokerClient} = require('../ui/lib/client');
const {startBroker} = require('../ui/lib/broker');
const {loadIdentity, tlsOptions, checkPeer, powershell, helper} = require('../ui/lib/ipc-security');
const script = path.resolve(__dirname, '../ui/lib/broker.js');
const storage = name => path.resolve(__dirname, '.ipc-test-data', name + '-' + crypto.randomUUID());
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function nativeIdentity(directory) {
  return spawnSync(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-Mode', 'Key', '-Storage', directory], {windowsHide: true, encoding: 'utf8', timeout: 30000});
}

test('a fake plaintext broker cannot obtain a persistent credential or inject pre-authentication events', {timeout: 15000}, async t => {
  const directory = storage('fake-server'); fs.mkdirSync(directory, {recursive: true});
  const legacy = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(path.join(directory, 'broker-token'), legacy);
  const identity = loadIdentity(directory);
  const client = new BrokerClient(directory, 'must-not-launch-after-authentication-failure.js');
  const events = [], captures = [];
  for (const event of ['connected', 'openEntry', 'historyChanged', 'privacyReset']) client.on(event, () => events.push(event));
  const sockets = new Set();
  const fake = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {});
    socket.on('data', data => {
      captures.push(data);
      socket.write(JSON.stringify({requestId: 'guess', ok: true, result: {version: 5}}) + '\n' + JSON.stringify({type: 'openEntry', key: 'injected'}) + '\n');
    });
  });
  t.after(() => {client.dispose(); for (const socket of sockets) socket.destroy(); fake.close();});
  fake.listen(client.pipe); await once(fake, 'listening');
  await assert.rejects(client.connect(), error => error.code === 'BROKER_AUTH_FAILED');
  assert.deepEqual(events, []); assert.equal(client.authenticated, false);
  const wire = Buffer.concat(captures);
  assert.ok(wire.length > 0);
  assert.equal(wire.includes(Buffer.from(legacy)), false);
  if (identity.pfx) assert.equal(wire.includes(identity.pfx), false);
  assert.equal(wire.includes(Buffer.from('"op":"hello"')), false);
});

test('unauthenticated plaintext operations and an unrelated client identity cannot reach broker state', {timeout: 20000}, async t => {
  const directory = storage('reject-client');
  const client = new BrokerClient(directory, script);
  const broker = startBroker({storage: directory, pipe: client.pipe, noNative: true});
  t.after(() => {client.dispose(); broker.close();});
  await once(broker.server, 'listening');
  await client.connect();
  const history = await client.request('history');
  const raw = net.createConnection(client.pipe); raw.on('error', () => {});
  await once(raw, 'connect');
  raw.write(JSON.stringify({requestId: 'attack', op: 'privacyReset'}) + '\n');
  await new Promise(resolve => raw.once('close', resolve));
  assert.equal((await client.request('privacyStatus')).paused, false);
  assert.deepEqual(await client.request('history'), history);
  const serverIdentity = loadIdentity(directory);
  const unrelated = loadIdentity(storage('wrong-identity'));
  const wrong = tls.connect({...tlsOptions({...unrelated, ca: serverIdentity.ca}), socket: net.createConnection(client.pipe),
    checkServerIdentity: checkPeer(serverIdentity)});
  wrong.on('error', () => {}); t.after(() => wrong.destroy());
  wrong.on('secureConnect', () => wrong.write(JSON.stringify({requestId: 'attack', op: 'privacyReset'}) + '\n'));
  await new Promise(resolve => wrong.once('close', resolve));
  assert.equal((await client.request('privacyStatus')).paused, false);
  assert.equal((await client.request('ping')).clients, 1);
});

test('an unrelated TLS server certificate is rejected before any application bytes are sent', {timeout: 15000}, async t => {
  const directory = storage('wrong-server'); loadIdentity(directory);
  const other = loadIdentity(storage('wrong-server-identity'));
  const client = new BrokerClient(directory, 'must-not-launch.js');
  let applications = 0;
  const fake = tls.createServer({...tlsOptions(other), requestCert: false, rejectUnauthorized: false}, socket => {
    socket.on('data', () => applications++);
  });
  fake.on('tlsClientError', () => {});
  t.after(() => {client.dispose(); fake.close();});
  fake.listen(client.pipe); await once(fake, 'listening');
  await assert.rejects(client.connect(), error => error.code === 'BROKER_AUTH_FAILED');
  assert.equal(applications, 0); assert.equal(client.authenticated, false);
});

test('private Windows storage and every named-pipe instance grant access only to the current SID', {skip: process.platform !== 'win32', timeout: 20000}, async t => {
  const directory = storage('acl');
  const client = new BrokerClient(directory, script);
  const broker = startBroker({storage: directory, pipe: client.pipe, noNative: true});
  t.after(() => {client.dispose(); broker.close();});
  await once(broker.server, 'listening'); await client.connect();
  await client.request('retention', {days: 8});
  const probe = `$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
    $root=$env:CODEX_NOTIFIER_TEST_STORAGE; $acls=@([IO.Directory]::GetAccessControl($root),[IO.File]::GetAccessControl([IO.Path]::Combine($root,'ipc-security-v1/identity.dpapi')),[IO.File]::GetAccessControl([IO.Path]::Combine($root,'broker-privacy.json')));
    $pipe=New-Object IO.Pipes.NamedPipeClientStream('.', $env:CODEX_NOTIFIER_TEST_PIPE.Substring(9), [IO.Pipes.PipeDirection]::InOut);
    try {$pipe.Connect(3000); $acls += $pipe.GetAccessControl(); foreach($acl in $acls) {
      $allow=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.AccessControlType -eq 'Allow'});
      if(@($allow | Where-Object {$_.IdentityReference -ne $sid}).Count -ne 0) {throw 'foreign ACL grant'};
      if($acl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $sid) {throw 'foreign owner'};
    }; Write-Output 'private'} finally {$pipe.Dispose()}`;
  const result = spawnSync(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', probe],
    {encoding: 'utf8', windowsHide: true, timeout: 10000, env: {...process.env, CODEX_NOTIFIER_TEST_STORAGE: directory, CODEX_NOTIFIER_TEST_PIPE: client.pipe}});
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /private/);
});

test('Windows credential initialization rejects ancestor junctions, hardlinks, and unrelated child directories before ACL changes', {skip: process.platform !== 'win32', timeout: 30000}, () => {
  const fixture = storage('links'); fs.mkdirSync(fixture, {recursive: true});
  const target = path.join(fixture, 'target'); fs.mkdirSync(target);
  const junction = path.join(fixture, 'junction'); fs.symlinkSync(target, junction, 'junction');
  const redirected = nativeIdentity(path.join(junction, 'storage'));
  assert.notEqual(redirected.status, 0); assert.match(redirected.stderr, /reparse point/);
  assert.equal(fs.existsSync(path.join(target, 'storage')), false);
  const directory = path.join(fixture, 'hardlink-storage'); fs.mkdirSync(directory);
  const original = path.join(fixture, 'original.json'); fs.writeFileSync(original, '{"preserved":true}');
  fs.linkSync(original, path.join(directory, 'broker-state-v5.json'));
  const linked = nativeIdentity(directory);
  assert.notEqual(linked.status, 0); assert.match(linked.stderr, /hard links/);
  assert.equal(fs.readFileSync(original, 'utf8'), '{"preserved":true}');
  const unknown = path.join(fixture, 'unknown-storage'); fs.mkdirSync(path.join(unknown, 'foreign'), {recursive: true});
  const refused = nativeIdentity(unknown);
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /Unexpected directory/);
  assert.equal(fs.existsSync(path.join(unknown, 'ipc-security-v1')), false);
});

test('concurrent Windows initialization shares one protected identity', {skip: process.platform !== 'win32', timeout: 20000}, async () => {
  const directory = storage('concurrent');
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
      '-Mode', 'Key', '-Storage', directory], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '', error = '';
    child.stdout.on('data', data => {output += data;}); child.stderr.on('data', data => {error += data;});
    child.on('error', reject);
    child.on('exit', status => { if (status) reject(new Error(error)); else resolve(JSON.parse(output).cert); });
  });
  const values = await Promise.all([run(), run(), run()]);
  assert.equal(new Set(values).size, 1);
});
