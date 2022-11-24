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
const key = require('../extension/common/key.js');

const execAsync = util.promisify(cp.exec);
const readFileAsync = util.promisify(fs.readFile);
const writeFileAsync = util.promisify(fs.writeFile);

const RedisMigrator = require('./RedisMigrator.js');
const redisMigrator = new RedisMigrator();

function _randomPassword() {
  const password = key.randomPassword(32);
  return password;
}

async function _ensureMigrationFolder() {
  const cmd = "mkdir -p " + migrationFolder;
  await execAsync(cmd);
}

async function _ensureRemoteMigrationFolder(host, identity) {
  const cmd = "mkdir -p " + migrationFolder;
  await ssh.remoteCommand(host, cmd, f.getUserID(), identity);
}

async function _ensureRemoteHiddenFolder(host, identity) {
  let cmd = "mkdir -p " + f.getHiddenFolder() + "/run";
  await ssh.remoteCommand(host, cmd, f.getUserID(), identity);
  cmd = "mkdir -p " + f.getHiddenFolder() + "/config";
  await ssh.remoteCommand(host, cmd, f.getUserID(), identity);
}

function _getPartitionFilePath(partition) {
  return `${migrationFolder}/data_export.${partition}.firewalla`;
}

function _getPartitionKeyFilePath(partition) {
  return `${migrationFolder}/data_export.${partition}.firewalla.key`;
}

function _encryptAES(key, buffer) {
  const iv = Buffer.alloc(16);
  iv.fill(0);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(key), iv);
  let crypted = cipher.update(buffer);
  crypted = Buffer.concat([crypted, cipher.final()]);
  return crypted;
}

function _encryptAESStream(key) {
  const iv = Buffer.alloc(16);
  iv.fill(0);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(key), iv);
  return cipher;
}

function _decryptAES(key, buffer) {
  const iv = Buffer.alloc(16);
  iv.fill(0);
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(key), iv);
  let decrypted = decipher.update(buffer);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted;
}

function _decryptAESStream(key) {
  const iv = Buffer.alloc(16);
  iv.fill(0);
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(key), iv);
  return decipher;
}

async function exportDataPartition(partition, encryptionIdentity) {
  await _ensureMigrationFolder();
  const partitionFilePath = _getPartitionFilePath(partition);
  if (!encryptionIdentity) {
    // encryption is not applied
    const partitionFileStream = fs.createWriteStream(partitionFilePath);
    await redisMigrator.export(partition, partitionFileStream);
  } else {
    const pubKey = await ssh.getRSAPEMPublicKey(encryptionIdentity);
    const partitionKeyFilePath = _getPartitionKeyFilePath(partition);
    const password = _randomPassword();
    if (pubKey !== null) {
      const encryptedPassword = crypto.publicEncrypt(pubKey, Buffer.from(password));
      await writeFileAsync(partitionKeyFilePath, encryptedPassword);
      const cipherStream = _encryptAESStream(password);
      const partitionFileStream = fs.createWriteStream(partitionFilePath);
      cipherStream.pipe(partitionFileStream);
      await redisMigrator.export(partition, cipherStream);
    } else throw util.format("identity %s not found.", encryptionIdentity);
  }
}

async function importDataPartition(partition, encryptionIdentity) {
  const partitionFilePath = _getPartitionFilePath(partition);
  let partitionInputStream = fs.createReadStream(partitionFilePath);
  if (encryptionIdentity) {
    const privKey = await ssh.getRSAPEMPrivateKey(encryptionIdentity);
    const partitionKeyFilePath = _getPartitionKeyFilePath(partition);
    const encryptedPassword = await readFileAsync(partitionKeyFilePath);
    if (privKey !== null) {
      const password = crypto.privateDecrypt(privKey, encryptedPassword);
      const decipherStream = _decryptAESStream(password);
      partitionInputStream = partitionInputStream.pipe(decipherStream);
    } else throw util.format("identity %s not found.", encryptionIdentity);
  }
  await redisMigrator.import(partitionInputStream);
}

async function transferDataPartition(host, partition, transferIdentity) {
  await _ensureRemoteMigrationFolder(host, transferIdentity);
  const sourcePath = _getPartitionFilePath(partition);
  await ssh.scpFile(host, sourcePath, migrationFolder, false, transferIdentity, f.getUserID());
  const keyFilePath = _getPartitionKeyFilePath(partition);
  if (fs.existsSync(keyFilePath)) {
    await ssh.scpFile(host, keyFilePath, migrationFolder, false, transferIdentity, f.getUserID());
  }
}

async function transferHiddenFolder(host, transferIdentity) {
  await _ensureRemoteHiddenFolder(host, transferIdentity);
  await ssh.scpFile(host, `${f.getHiddenFolder()}/config`, f.getHiddenFolder(), true, transferIdentity);
  // the reason why not just copy the whole /run folder lies in that saved_xx should not be override on target host
  await ssh.scpFile(host, `${f.getHiddenFolder()}/run/dnsmasq-*`, f.getHiddenFolder() + "/run/", false, transferIdentity); // this should take care of dnsmasq-hosts and dnsmasq-alt-hosts
  await ssh.scpFile(host, `${f.getHiddenFolder()}/run/dnsmasq.resolv.conf`, f.getHiddenFolder() + "/run/", false, transferIdentity);

}

module.exports = {
  exportDataPartition: exportDataPartition,
  importDataPartition: importDataPartition,
  transferDataPartition: transferDataPartition,
  transferHiddenFolder: transferHiddenFolder
}