/*    Copyright 2016 Firewalla LLC / Firewalla LLC
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict';

const log = require('../net2/logger.js')(__filename);
const util = require('util');
const SSH = require('../extension/ssh/ssh.js');
const ssh = new SSH('info');
const f = require('../net2/Firewalla.js');
const cp = require('child_process');
const migrationFolder = f.getUserHome() + "/migration";
const crypto = require('crypto');
const fs = require('fs');

const execAsync = util.promisify(cp.exec);
const readFileAsync = util.promisify(fs.readFile);
const writeFileAsync = util.promisify(fs.writeFile);

const ENCRYPT_BATCH = 128;
const RSA_ENCRYPTION_KEY_SIZE = 256;

const RedisMigrator = require('./RedisMigrator.js');
const redisMigrator = new RedisMigrator();


async function _ensureMigrationFolder() {
  const cmd = "mkdir -p " + migrationFolder;
  await execAsync(cmd);
}

async function _ensureRemoteMigrationFolder(host, identity) {
  const cmd = "mkdir -p " + migrationFolder;
  await ssh.remoteCommand(host, cmd, f.getUserID(), identity);
}

async function _ensureRemoteHiddenFolder(host, identity) {
  const cmd = "mkdir -p " + f.getHiddenFolder();
  await ssh.remoteCommand(host, cmd, f.getUserID(), identity);
}

function _getPartitionFilePath(partition) {
  return `${migrationFolder}/data_export.${partition}.firewalla`;
}

function _publicEncrypt(pubKey, buffer) {
  let bytesEncrypted = 0;
  let encryptedBuffers = [];

  while (bytesEncrypted < buffer.length) {
    const bytesToEncrypt = Math.min(ENCRYPT_BATCH, buffer.length - bytesEncrypted);
    const tmpBuffer = new Buffer(bytesToEncrypt);
    buffer.copy(tmpBuffer, 0, bytesEncrypted, bytesEncrypted + bytesToEncrypt);
    const encryptedBuffer = crypto.publicEncrypt(pubKey, tmpBuffer);
    encryptedBuffers.push(encryptedBuffer);
    bytesEncrypted += bytesToEncrypt;
  }
  return Buffer.concat(encryptedBuffers)
}

function _privateDecrypt(privKey, buffer) {
  let decryptedBuffers = [];
  let totalBuffers = buffer.length / RSA_ENCRYPTION_KEY_SIZE;

  for (let i = 0; i < totalBuffers; i++) {
    const tmpBuffer = new Buffer(RSA_ENCRYPTION_KEY_SIZE);
    buffer.copy(tmpBuffer, 0, i * RSA_ENCRYPTION_KEY_SIZE, (i + 1) * RSA_ENCRYPTION_KEY_SIZE);
    const decryptedBuffer = crypto.privateDecrypt(privKey, tmpBuffer);
    decryptedBuffers.push(decryptedBuffer);
  }
  return Buffer.concat(decryptedBuffers);
}

async function exportDataPartition(partition, encryptionIdentity) {
  await _ensureMigrationFolder();
  const partitionFilePath = _getPartitionFilePath(partition);
  const content = await redisMigrator.export(partition); // content is buffer
  if (!encryptionIdentity) {
    // encryption is not applied
    await writeFileAsync(partitionFilePath, content);
  } else {
    const pubKey = await ssh.getRSAPEMPublicKey(encryptionIdentity);
    if (pubKey !== null) {
      const encryptedContent = _publicEncrypt(pubKey, content);
      await writeFileAsync(partitionFilePath, encryptedContent);
    } else throw util.format("identity %s not found.", encryptionIdentity);
  }
}

async function importDataPartition(partition, encryptionIdentity) {
  const partitionFilePath = _getPartitionFilePath(partition);
  let content = await readFileAsync(partitionFilePath); // content is buffer
  if (encryptionIdentity) {
    const privKey = await ssh.getRSAPEMPrivateKey(encryptionIdentity);
    if (privKey !== null) {
      content = _privateDecrypt(privKey, content);
    } else throw util.format("identity %s not found.", encryptionIdentity);
  }
  // import content
  await redisMigrator.import(content);
}

async function transferDataPartition(host, partition, transferIdentity) {
  await _ensureRemoteMigrationFolder(host, transferIdentity);
  const sourcePath = _getPartitionFilePath(partition);
  await ssh.scpFile(host, sourcePath, migrationFolder, false, transferIdentity, f.getUserID());
}

async function transferHiddenFolder(host, transferIdentity) {
  await _ensureRemoteHiddenFolder(host, transferIdentity);
  await ssh.scpFile(host, `${f.getHiddenFolder()}/config`, f.getHiddenFolder(), true, transferIdentity);
  await ssh.scpFile(host, `${f.getHiddenFolder()}/run`, f.getHiddenFolder(), true, transferIdentity);
}

module.exports = {
  exportDataPartition: exportDataPartition,
  importDataPartition: importDataPartition,
  transferDataPartition: transferDataPartition,
  transferHiddenFolder: transferHiddenFolder
}