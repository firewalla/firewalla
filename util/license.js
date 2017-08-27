'use strict'

let fs = require('fs');
let Firewalla = require('../net2/Firewalla.js');
let path = Firewalla.getEncipherConfigFolder() + '/license';
let licensePath = Firewalla.getHiddenFolder() + "/license";

let Promise = require('bluebird');
let jsonfile = require('jsonfile')
let jsWriteFile = Promise.promisify(jsonfile.writeFile);
let jsReadFile = Promise.promisify(jsonfile.readFile);

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let license = null;
let signature = null;

function getLicense() {
  return async(() => {
    try {
      return await (jsReadFile(licensePath));
    } catch(err) {
      if(err.code === 'ENOENT') {
        return getLegacyLicense();
      } else {
        return null;
      }
    }
  })();
}

function getLicenseSync() {
  try {
    return jsonfile.readFileSync(licensePath)
  } catch(err) {
    return getLegacyLicense();
  }
}

function getLegacyLicense() {
    if (!fs.existsSync(path)) {
        return null;
    }
    let license = fs.readFileSync(path,'utf-8');
    if (license == null) {
        return null;
    }
    let licenseobj = JSON.parse(license);
    license = licenseobj.DATA;
    signature = licenseobj.SIGNATURE;
    return licenseobj;
}

function verifyLicense(license) {
}

function writeLicense(license) {
  return jsWriteFile(licensePath, license, {spaces: 2}) // ~/.firewalla/license
}

module.exports = {
   getLicense: getLicense,
   verifyLicense: verifyLicense,
   writeLicense: writeLicense,
   licensePath: licensePath,
   getLicenseSync:getLicenseSync
}
