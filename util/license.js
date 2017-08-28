'use strict'

let fs = require('fs');
let Firewalla = require('../net2/Firewalla.js');
let path = Firewalla.getEncipherConfigFolder() + '/license';

let license = null;
let signature = null;

function getLicense() {
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

function getLicenseLicense() {
    let licenseobj = getLicense();
    if (licenseobj) {
        return licenseobj.DATA;
    } else {
        return null;
    }
}

function verifyLicense(license) {
}

module.exports = {
   getLicense: getLicense,
   verifyLicense: verifyLicense,
   getLicenseLicense: getLicenseLicense
}

