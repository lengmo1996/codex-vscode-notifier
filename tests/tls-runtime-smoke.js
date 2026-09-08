'use strict';
// Synthetic identities and pipes only; usable under both Node and Electron.
const path = require('node:path');
const crypto = require('node:crypto');
const {once} = require('node:events');
const {BrokerClient} = require('../ui/lib/client');
const {startBroker} = require('../ui/lib/broker');
(async () => {
  const storage = path.resolve(__dirname, 'runtime', 'tls-runtime-' + crypto.randomUUID());
  const client = new BrokerClient(storage, path.resolve(__dirname, '../ui/lib/broker.js'));
  const broker = startBroker({storage, pipe: client.pipe, noNative: true});
  try {
    await once(broker.server, 'listening');
    const response = await client.request('ping');
    console.log(JSON.stringify({node: process.version, electron: process.versions.electron, version: response.version,
      protocol: client.socket.getProtocol(), cipher: client.socket.getCipher().standardName, authorized: client.socket.authorized}));
  } finally {client.dispose(); broker.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
