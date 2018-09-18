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
const unlinkAsync = util.promisify(fs.unlink);


async function _ensureMigrationFolder() {
  const cmd = "mkdir -p " + migrationFolder;
  await execAsync(cmd);
}

async function _ensureRemoteMigrationFolder(host, identity) {
  const cmd = "mkdir -p " + migrationFolder;
  await ssh.remoteCommand(host, cmd, f.getUserID(), identity);
}

function _getTmpPartitionFilePath(partition) {
  return `${migrationFolder}/data_export.${partition}.firewalla.tmp`;
}

function _getPartitionFilePath(partition) {
  return `${migrationFolder}/data_export.${partition}.firewalla`;
}

async function exportDataPartition(partition, encryptionIdentity) {
  await _ensureMigrationFolder();
  const tmpPartitionFilePath = _getTmpPartitionFilePath(partition);
  const partitionFilePath = _getPartitionFilePath(partition);
  let cmd = "touch " + tmpPartitionFilePath;
  await execAsync(cmd);
  const content = await readFileAsync(tmpPartitionFilePath);
  await unlinkAsync(tmpPartitionFilePath);
  if (encryptionIdentity === null) {
    // encryption is not applied
    await writeFileAsync(partitionFilePath, content);
  } else {
    const pubKey = await ssh.getRSAPEMPublicKey(encryptionIdentity);
    if (pubKey !== null) {
      const encryptedContent = crypto.publicEncrypt(pubKey, content);
      await writeFileAsync(partitionFilePath, encryptedContent);
    } else throw util.format("identity %s not found.", encryptionIdentity);
  }
}

async function importDataPartition(partition, encryptionIdentity) {
  const partitionFilePath = _getPartitionFilePath(partition);
  var content = await readFileAsync(partitionFilePath);
  if (encryptionIdentity !== null) {
    const privKey = await ssh.getRSAPEMPrivateKey(encryptionIdentity);
    if (privKey !== null) {
      content = crypto.privateDecrypt(privKey, content);
    } else throw util.format("identity %s not found.", encryptionIdentity);
  }
  // import content
}

async function transferDataPartition(host, partition, transferIdentity) {
  await _ensureRemoteMigrationFolder(host, transferIdentity);
  const sourcePath = _getPartitionFilePath(partition);
  await ssh.scpFile(host, sourcePath, migrationFolder, false, transferIdentity, f.getUserID());
}

async function transferHiddenFolder(host, identity) {
  await ssh.scpFile(host, `${f.getHiddenFolder()}/config`, f.getHiddenFolder, true, identity);
  await ssh.scpFile(host, `${f.getHiddenFolder()}/run`, f.getHiddenFolder, true, identity);
}

module.exports = {
  exportDataPartition: exportDataPartition,
  importDataPartition: importDataPartition,
  transferDataPartition: transferDataPartition,
  transferHiddenFolder: transferHiddenFolder
}