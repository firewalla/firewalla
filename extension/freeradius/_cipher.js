/*    Copyright 2016-2022 Firewalla Inc.
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


// TODO: Replace this with proper password save method
const exec = require('child-process-promise').exec;

const log = require('../../net2/logger.js')(__filename);

function getUserHome() {
    return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
}

const netbotPrivKeyPath = getUserHome() + "/.encipher/netbot.privkey.pem"

async function encrypt(plain, cfile, privKeyPath) {
    if (!privKeyPath) {
        privKeyPath = netbotPrivKeyPath
    }
    await exec(`echo '${plain}' | openssl rsautl -inkey ${privKeyPath} -encrypt | base64 > ${cfile}`).catch(e => null);
}

async function decrypt(cfile, privKeyPath) {
    if (!privKeyPath) {
        privKeyPath = netbotPrivKeyPath
    }
    return await exec(`cat ${cfile} | base64 --decode | openssl rsautl -inkey ${privKeyPath} -decrypt`).then(result => result.stdout.trim()).catch((err) => {});
}

module.exports = {
    encrypt,
    decrypt,
};
