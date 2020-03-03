/*    Copyright 2019-2020 Firewalla INC
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

let log = require("../net2/logger.js")(__filename);

let fs = require('fs');
let Firewalla = require('../net2/Firewalla.js');
let path = Firewalla.getEncipherConfigFolder() + '/license';
let licensePath = Firewalla.getHiddenFolder() + "/license";

let Promise = require('bluebird');
let jsonfile = require('jsonfile')
let jsWriteFile = Promise.promisify(jsonfile.writeFile);
let jsReadFile = Promise.promisify(jsonfile.readFile);

async function getLicenseAsync() {
  try {
    return jsReadFile(licensePath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return getLegacyLicense();
    } else {
      return null;
    }
  }
}

function getLicense() {
  return getLicenseSync();
}

function getLicenseSync() {
  try {
    return jsonfile.readFileSync(licensePath)
  } catch (err) {
    log.error(`Failed to read license from ${licensePath}, ERROR: ${err}`);
    return getLegacyLicense();
  }
}

function getLegacyLicense() {
  if (!fs.existsSync(path)) {
    return null;
  }
  let license = fs.readFileSync(path, 'utf-8');
  if (license == null) {
    return null;
  }
  let licenseobj = JSON.parse(license);
  license = licenseobj.DATA;
  return licenseobj;
}

function getLicenseLicense() {
  let licenseobj = getLicense();
  if (licenseobj) {
    return licenseobj.DATA;
  } else {
    return null;
  }
}

function writeLicense(license) {
  return jsWriteFile(licensePath, license, {
    spaces: 2
  }) // ~/.firewalla/license
}

function writeLicenseAsync(license) {
  return writeLicense(license);
}

module.exports = {
  getLicense: getLicense,
  writeLicense: writeLicense,
  licensePath: licensePath,
  getLicenseSync: getLicenseSync,
  getLicenseAsync: getLicenseAsync,
  writeLicenseAsync: writeLicenseAsync,
  getLicenseLicense: getLicenseLicense
}
