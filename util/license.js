'use strict'

let log = require("../net2/logger.js")(__filename);

let fs = require('fs');
let Firewalla = require('../net2/Firewalla.js');
let path = Firewalla.getEncipherConfigFolder() + '/license';
let licensePath = Firewalla.getHiddenFolder() + "/license";

let Promise = require('bluebird');
let jsonfile = require('jsonfile')
let jsWriteFile = Promise.promisify(jsonfile.writeFile);
let jsReadFile = Promise.promisify(jsonfile.readFile);

let license = null;
let signature = null;

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
  signature = licenseobj.SIGNATURE;
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

function verifyLicense(license) {}

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
  verifyLicense: verifyLicense,
  writeLicense: writeLicense,
  licensePath: licensePath,
  getLicenseSync: getLicenseSync,
  getLicenseAsync: getLicenseAsync,
  writeLicenseAsync: writeLicenseAsync,
  getLicenseLicense: getLicenseLicense
}
