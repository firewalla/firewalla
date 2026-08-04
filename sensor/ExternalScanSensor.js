/*    Copyright 2020-2021 Firewalla Inc.
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


const Sensor = require('./Sensor.js').Sensor;

const rclient = require('../util/redis_manager.js').getRedisClient();

const { rrWithErrHandling } = require('../util/requestWrapper.js')
const tokenManager = require('../util/FWTokenManager.js');
const _ = require('lodash');
const EncipherTool = require('../net2/EncipherTool.js');
const extensionManager = require('./ExtensionManager.js');
const sysManager = require('../net2/SysManager.js');
const Constants = require('../net2/Constants.js');
const encipherTool = new EncipherTool();
const delay = require('../util/util.js').delay;

const STATE_SCANNING = "scanning";
const STATE_IDLE = "idle";

const ERR_COOLDOWN = "ERR_CD";
const ERR_NO_PUB_IP = "ERR_NO_PUB_IP";

class ExternalScanSensor extends Sensor {
  constructor(config) {
    super(config);
  }

  async apiRun() {
    this.wanScanResults = {};
    this.wanScanStartTs = {};
    const scanCD = this.config.scanCooldown || 300;
    this.scanServerURL = this.config.scanServerURL || "https://scan.encipher.io:18888/scan";

    extensionManager.onCmd("startExternalScan", async (msg, data) => {
      const {target} = data;
      const wansToScan = [];
      const wans = sysManager.getWanInterfaces();
      const publicIps = sysManager.publicIps;
      const now = Date.now() / 1000;
      let errors = [];
      for (const wan of wans) {
        if (target === "0.0.0.0" || target === wan.uuid) {
          if (this.wanScanStartTs[wan.uuid] && now - this.wanScanStartTs[wan.uuid] < scanCD) {
            errors.push({err: ERR_COOLDOWN, wanUUID: wan.uuid, msg: `External scan on WAN ${wan.name} is on a cooldown`});
          } else {
            if (!_.has(publicIps, wan.name) && _.isEmpty(wan.ip6_addresses)) {
              errors.push({err: ERR_NO_PUB_IP, wanUUID: wan.uuid, msg: `WAN ${wan.name} does not have public IPv4/IPv6 addresses`});
            } else
              wansToScan.push(wan);
          }
        }
      }
      if (_.isEmpty(wansToScan)) {
        return {results: await this.getScanResults(), errors};
      }
      let finished = false;
      Promise.all(wansToScan.map(async (wan) => {
        if (!_.has(this.wanScanResults[wan.uuid]))
          this.wanScanResults[wan.uuid] = {};
        const scanResult = this.wanScanResults[wan.uuid];
        if (scanResult.state === STATE_SCANNING)
          return;
        scanResult.state = STATE_SCANNING;
        scanResult.ts = now;
        this.wanScanStartTs[wan.uuid] = now;
        await this.scanWAN(publicIps[wan.name], wan.ip6_addresses).then(async (result) => {
          scanResult.ets = Date.now() / 1000;
          scanResult.result = result;
          scanResult.state = STATE_IDLE;
          await this.saveScanResult(wan.uuid, scanResult);
        }).catch((err) => {
          log.error(`Failed to run external scan on WAN ${wan.uuid}`, err.message);
          scanResult.state = STATE_IDLE;
        });
      })).catch((err) => {
        log.error(`Failed to scan wans`, err.message);
      }).finally(() => {
        finished = true;
      });
      for (let i = 0; i != 20; i++) {
        await delay(3000);
        if (finished)
          break;
      }
      return {results: await this.getScanResults(), errors};
    });

    extensionManager.onGet("externalScanResults", async (msg, data) => {
      return {results: await this.getScanResults()};
    });
  }

  async scanWAN(ipv4, ipv6s) {
    const ips = [];
    if (ipv4)
      ips.push(ipv4);
    if (_.isArray(ipv6s)) {
      const publicIpv6s = sysManager.filterPublicIp6(ipv6s);
      if (!_.isEmpty(publicIpv6s))
        ips.push(publicIpv6s[0]); // do not scan too may ip addresses, otherwise HTTP 429 will be triggered from cloud
    }
    const result = [];
    const eid = await encipherTool.getEID();
    const token = await tokenManager.getToken()

    await Promise.all(ips.map(async ip => {
      const uri = `${this.scanServerURL}/${eid}/${ip}/${ip}`;
      log.info(`Send to cloud for external scan`, uri);
      const options = { uri, method: "GET", auth: { bearer: token }, json: true, maxAttempts: 2, retryDelay: 11 * 1000 };
      const response = await rrWithErrHandling(options);
      if (response && response.body) {
        if (_.isArray(response.body.scan))
          response.body.scan = response.body.scan.filter(entry => entry.portid !== "0")
        result.push(response.body);
      }
    }));
    return result;
  }

  async getScanResults() {
    const results = {};
    const redisResults = await rclient.hgetallAsync(Constants.REDIS_KEY_EXT_SCAN_RESULT) || {};
    const wans = sysManager.getWanInterfaces();
    for (const wan of wans) {
      if (_.has(redisResults, wan.uuid))
        results[wan.uuid] = JSON.parse(redisResults[wan.uuid]);
      if (_.has(this.wanScanResults, wan.uuid)) {
        results[wan.uuid] = Object.assign(results[wan.uuid] || {}, this.wanScanResults[wan.uuid]);
      }
    }
    for (const uuid of Object.keys(redisResults)) {
      if (!_.has(results, uuid))
        await rclient.hdelAsync(Constants.REDIS_KEY_EXT_SCAN_RESULT, uuid);
    }
    return results;
  }

  async saveScanResult(wanUUID, result) {
    await rclient.hsetAsync(Constants.REDIS_KEY_EXT_SCAN_RESULT, wanUUID, JSON.stringify(result));
  }
}

module.exports = ExternalScanSensor;