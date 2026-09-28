/*    Copyright 2016-2026 Firewalla Inc.
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

const util = require('util');
const childProcess = require('child_process');
const execAsync = util.promisify(childProcess.exec);
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const _ = require('lodash');

const log = require('../net2/logger.js')(__filename)

function q(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function redactMsg(msg) {
    return String(msg == null ? '' : msg).replace(/pass:('[^']*'|\S*)/g, 'pass:***');
}

async function getKeyType(keyPath, keypass = null) {
    const passArg = keypass != null ? `-passin pass:${q(keypass)}` : '';
    const cmd = `openssl pkey -in ${q(keyPath)} ${passArg} -noout -text`;
    const output = await execAsync(cmd).then(r => r.stdout.trim()).catch((err) => {
        log.warn(`Failed to ${redactMsg(cmd)},`, redactMsg(err.message));
        return null;
    });
    if (!output) {
        log.warn(`Failed to ${redactMsg(cmd)}, no key type found`);
        return null;
    }
    if (/^Private-Key.*bit, \d+ primes/m.test(output) || /\bmodulus:/.test(output)) return 'rsa';
    if (/ASN1 OID:|NIST CURVE:|^\s*pub:/m.test(output)) return 'ec';
    return null;
}

async function isPrivateKeyValid(keyPath, keypass = null) {
    const passArg = keypass != null ? `-passin pass:${q(keypass)}` : '';
    const cmd = `openssl rsa -in ${q(keyPath)} ${passArg} -check`;
    return await execAsync(cmd).then(r => true).catch((err) => {
        log.warn(`Check private key ${keyPath} failed,`, redactMsg(err.message));
        return false;
    });
}

async function isSignedByRootCA(caPath, certPath) {
    const cmd = `openssl verify -CAfile ${q(caPath)} ${q(certPath)}`;
    const output = await execAsync(cmd).then(r => r.stdout.trim()).catch((err) => {
        log.warn(`Failed to ${cmd},`, err);
        return "";
    });

    if (!output || !output.includes('OK')) {
        log.warn(`Failed to ${cmd},`, output);
        return false;
    }
    return true;
}

// certificate -> modulus hash
async function getCertModulusHash(certPath) {
    if (!await fs.accessAsync(certPath, fs.constants.F_OK).then(() => true).catch(() => false)) {
        log.warn(`Cert file ${certPath} does not exist`);
        return null;
    }
    const cmd = `openssl x509 -in ${q(certPath)} -noout -modulus | openssl md5`;
    return _getModulus(cmd);
}

// private key -> modulus hash
async function getKeyModulusHash(keyPath, keypass = null) {
    if (!await fs.accessAsync(keyPath, fs.constants.F_OK).then(() => true).catch(() => false)) {
        log.warn(`Key file ${keyPath} does not exist`);
        return null;
    }
    const passArg = keypass != null ? `-passin pass:${q(keypass)}` : '';
    const cmd = `openssl rsa -in ${q(keyPath)} ${passArg} -noout -modulus | openssl md5`;
    return _getModulus(cmd);
}

// certificate -> pubkey
async function getCertPubKey(certPath) {
    const cmd = `openssl x509 -in ${q(certPath)} -noout -pubkey`;
    return await execAsync(cmd).then(r => r.stdout.trim()).catch((err) => {
        log.warn(`Failed to ${cmd},`, err.message);
        return null;
    });
}

// private key -> pubkey
async function getKeyPubKey(keyPath, keypass = null) {
    const passArg = keypass != null ? `-passin pass:${q(keypass)}` : '';
    const cmd = `openssl pkey -in ${q(keyPath)} ${passArg} -pubout`;
    return await execAsync(cmd).then(r => r.stdout.trim()).catch((err) => {
        log.warn(`Failed to ${redactMsg(cmd)},`, redactMsg(err.message));
        return null;
    });
}

// verify the private key corresponds to the certificate.
// rsa: compare modulus hash;
// ec: compare public keys.
async function isKeyMatchCert(certPath, keyPath, keyType, keypass = null) {
    if (keyType === 'rsa') {
        const certHash = await getCertModulusHash(certPath);
        const keyHash = await getKeyModulusHash(keyPath, keypass);
        return certHash && keyHash && certHash === keyHash;
    }
    const certPub = await getCertPubKey(certPath);
    const keyPub = await getKeyPubKey(keyPath, keypass);
    return certPub && keyPub && certPub === keyPub;
}

async function _getModulus(cmd) {
    const output = await execAsync(cmd).then(r => r.stdout.trim()).catch((err) => {
        log.warn(`Failed to ${redactMsg(cmd)},`, redactMsg(err.message));
        return null;
    });

    if (!output || !output.includes('(stdin)= ')) {
        log.warn(`Failed to ${redactMsg(cmd)}, no modulus found: ${output}`);
        return null;
    }
    log.info(`Modulus found: ${output}`);
    const modulus = output.replace(/^.*\(stdin\)=\s*/s, '').trim();
    return modulus;
}

const openssl = {
    isPrivateKeyValid,
    isSignedByRootCA,
    isKeyMatchCert,
    getCertModulusHash,
    getCertPubKey,
    getKeyModulusHash,
    getKeyPubKey,
    getKeyType,
}

module.exports = openssl;