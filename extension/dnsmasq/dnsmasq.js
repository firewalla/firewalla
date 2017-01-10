/**
 * Created by Melvin Tu on 04/01/2017.
 */

'use strict';

let instance = null;
let log = null;

let fs = require('fs');
let util = require('util');
let key = require('../common/key.js');
let jsonfile = require('jsonfile');

let Firewalla = require('../../net2/Firewalla.js');
let f = new Firewalla("config.json", 'info');
let fHome = firewalla.getFirewallaHome();

let domainFilterFile = fHome + "/extension/dnsmasq/filter.json";

module.exports = class {
    constructor(loglevel) {
        if (instance == null) {
            log = require("../../net2/logger.js")("dnsmasq", loglevel);

            instance = this;
        }
        return instance;
    }

    install(callback) {
        // need to check whether dnsmasq has already installed

    }

    uninstall(callback) {

    }

    start(callback) {

    }

    stop(callback) {

    }

}
