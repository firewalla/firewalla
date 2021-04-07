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

const log = require("../net2/logger.js")(__filename);

const fs = require('fs');
const Firewalla = require('../net2/Firewalla.js');
const licensePath = Firewalla.getHiddenFolder() + "/license";

const Promise = require('bluebird');
const jsonfile = require('jsonfile')
const jsWriteFile = Promise.promisify(jsonfile.writeFile);
const jsReadFile = Promise.promisify(jsonfile.readFile);

async function getLicenseAsync() {
  try {
    const content = await jsReadFile(licensePath);
    return content;
  } catch (err) {
    return null;
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
    return null;
  }
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
