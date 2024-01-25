/*    Copyright 2019-2023 Firewalla Inc.
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

const log = require("./logger.js")(__filename);

const f = require('../net2/Firewalla.js');
const PlatformLoader = require('../platform/PlatformLoader.js')
const platform = PlatformLoader.getPlatform()
const Config = require('./config.js')
const sem = require('../sensor/SensorEventManager.js').getInstance();
const { rrWithErrHandling } = require('../util/requestWrapper.js')

const util = require('util')
const rp = util.promisify(require('request'))
const _ = require('lodash');

// not exposing these methods/properties
async function localGet(endpoint, retry = 5) {
  if (!platform.isFireRouterManaged())
    throw new Error('Forbidden')

  const response = await rrWithErrHandling({
    uri: fwapcInterface + endpoint,
    method: "GET",
    maxAttempts: retry,   // (default) try 5 times
    retryDelay: 1000,  // (default) wait for 1s before trying again
    json: true,
  })

  return response.body
}

async function localSet(endpoint, body, retry = 5) {
  if (!platform.isFireRouterManaged())
    throw new Error('Forbidden')

  const response = await rrWithErrHandling({
    uri: fwapcInterface + endpoint,
    method: "POST",
    maxAttempts: retry,   // (default) try 5 times
    retryDelay: 1000,  // (default) wait for 1s before trying again
    json: body,
  })

  return response.body
}

async function getConfig() {
  return localGet("/config/active")
}

async function setConfig(config) {
  return localSet("/config/set", config)
}


async function getWANInterfaces() {
  return localGet("/config/wans")
}

async function getLANInterfaces() {
  return localGet("/config/lans")
}

async function getInterfaces() {
  return localGet("/config/interfaces")
}

async function getInterface(intf) {
  return localGet(`/config/interfaces/${intf}`, 2)
}

// internal properties
let fwapcInterface = null
let staStatus = null
let staStatusTs = 0;

class FWAPC {
  constructor() {
    log.info(`platform is: ${platform.constructor.name}`);

    const fwConfig = Config.getConfig();

    if (!fwConfig.fwapc || !fwConfig.fwapc.interface) return null

    const intf = fwConfig.fwapc.interface;
    fwapcInterface = `http://${intf.host}:${intf.port}/${intf.version}`;
  }

  isReady() {
    return this.ready
  }

  async getAllSTAStatus(live = false) {
    if (live || Date.now() / 1000 - staStatusTs > 15) {
      staStatus = await localGet("/status/station", 1).then(resp => resp.info);
      staStatusTs = Date.now() / 1000;
    }
    return Object.assign({}, staStatus);
  }

  async getSTAStatus(mac) {
    return await localGet(`/ap/sta_status/${mac}`, 1).then(resp => resp && resp.status);
  }

  async getAssetsStatus() {
    return localGet("/status/ap", 1).then(resp => resp.info);
  }

  async getConfig() {
    return localGet("/config/active", 1);
  }

  async staBssSteer(staMAC, targetAP, targetSSID, targetBand) {
    const options = {
      method: "POST",
      headers: {
        "Accept": "application/json"
      },
      url: fwapcInterface + "/ap/bss_steer",
      json: true,
      body: {
        staMAC, targetAP, targetSSID, targetBand
      }
    };
    const resp = await rp(options);
    return {code: resp.statusCode, body: resp.body};
  }

  async setConfig(config) {
    const options = {
      method: "POST",
      headers: {
        "Accept": "application/json"
      },
      url: fwapcInterface + "/config/set",
      json: true,
      body: config
    };

    const resp = await rp(options)
    if (resp.statusCode !== 200) {
      throw new Error("Error setting firerouter config: " + resp.body);
    }

    return resp.body
  }

}

const instance = new FWAPC();
module.exports = instance;
