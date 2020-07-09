/*    Copyright 2019 Firewalla INC
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

'use strict'

let instance = null;

const exec = require('child-process-promise').exec;
const fConfig = require('../../net2/config.js').getConfig();
const log = require('../../net2/logger.js')(__filename);

const sysManager = require('../../net2/SysManager.js');

const platformLoader = require('../../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const model = platform.getName();
const serial = platform.getBoardSerial();
const fs = require('fs');
const Promise = require('bluebird');

const f = require('../../net2/Firewalla.js');

Promise.promisifyAll(fs);

const { rrWithErrHandling } = require('../../util/requestWrapper.js')

class FWDiag {
  constructor() {
    if(instance === null) {
      instance = this;
    }

    return instance;
  }

  getEndpoint() {
    return fConfig.firewallaDiagServerURL || `https://api.firewalla.com/diag/api/v1/device/`
  }

  async getGatewayMac(gatewayIP) {
    const pingCmd = `ping -q -c 1 -w 2 ${gatewayIP} || /bin/true`;
    await exec(pingCmd);

    const arpCmd = `arp -a -n | grep ${gatewayIP} -w | awk '{print $4}'`;
    const result = await exec(arpCmd);
    const mac = result.stdout;
    if(mac) {
      return mac.substring(0, 11);
    } else {
      return null;
    }
  }

  async getGatewayName(gatewayIP) {
    const cmd = `arp ${gatewayIP} | tail -n 1 | awk '{print $1}'`;
    // return empty if command execute failed
    const result = await exec(cmd).catch(() => "");
    const name = result.stdout;
    return name.replace(/\n$/, '')
  }

  async getBranchInfo() {
    const result = await exec("git rev-parse --abbrev-ref HEAD");
    return result && result.stdout && result.stdout.replace(/\n$/, '')
  }

  getVersion() {
    return fConfig.version;
  }

  async getLongVersion() {
    const result = await exec("git describe --tags");
    return result && result.stdout && result.stdout.replace(/\n$/, '')
  }

  async getTotalMemory() {
    const result = await exec("free -m | awk '/Mem:/ {print $2}'");
    return result && result.stdout && result.stdout.replace(/\n$/, '')
  }

  async getGID() {
    const result = await exec("redis-cli hget sys:ept gid");
    return result && result.stdout && result.stdout.replace(/\n$/, '')
  }

  async hasLicenseFile() {
    const filePath = `${f.getHiddenFolder()}/license`;
    try {
      await fs.accessAsync(filePath, fs.constants.F_OK);
      return true;
    } catch (err) {
      return false;
    }
  }

  async prepareData(payload) {
    const inter = sysManager.getDefaultWanInterface()

    const ip = inter.ip_address;
    const gateway = inter.gateway_ip;
    const mac = platform.getSignatureMac();

    const gatewayMac = await this.getGatewayMac(gateway);
    const gatewayName = await this.getGatewayName(gateway);

    const ts = Math.floor(new Date() / 1000);

    return Object.assign({}, payload, {
      gw: gateway,
      fw: ip,
      mac: mac,
      ts: ts,
      gw_mac: gatewayMac,
      gw_name: gatewayName,
      model: model
    });
  }

  async submitInfo(payload) {
    const data = await this.prepareData(payload);
    if(data.gw) {
      const rclient = require('../../util/redis_manager.js').getRedisClient();

      const options = {
        uri:  this.getEndpoint() + data.gw,
        method: 'POST',
        json: data,
        maxAttempts: 2,
        timeout: 10000
      }
      const result = await rrWithErrHandling(options);
      if(result && result.mode) {
        await rclient.setAsync("recommend_firewalla_mode", result.mode);
      }

      if(result && result.guessedRouter) {
        await rclient.setAsync("guessed_router", JSON.stringify(result.guessedRouter));
      }

      log.info(`submitted ${payload.event} info to diag server successfully with result ${JSON.stringify(result)}`);
    }
  }

  async getCpuTemperature() {
    try {
      return platform.getCpuTemperature()
    } catch(err) {
      return -1;
    }
  }

  async prepareHelloData() {
    const inter = sysManager.getDefaultWanInterface()

    const firewallaIP = inter.ip_address;
    const mac = platform.getSignatureMac();
    const gateway = inter.gateway_ip;

    const version = this.getVersion();

    const [gatewayMac, branch, longVersion, memory, gid, hasLicense, nicSpeed, cpuTemp] =
      await Promise.all([
        this.getGatewayMac(gateway),
        this.getBranchInfo(),
        this.getLongVersion(),
        this.getTotalMemory(),
        this.getGID(),
        this.hasLicenseFile(),
        platform.getNetworkSpeed(),
        this.getCpuTemperature()
      ]);

    return {
      mac,
      firewallaIP,
      gatewayMac,
      branch,
      version,
      longVersion,
      memory,
      model,
      serial,
      gid,
      hasLicense,
      nicSpeed,
      cpuTemp
    };
  }

  async sayHello() {
    const data = await this.prepareHelloData();
    const options = {
      uri: this.getEndpoint() + 'hello',
      method: 'POST',
      json: data,
      maxAttempts: 2,
      timeout: 10000
    }
    await rrWithErrHandling(options);
    log.info("said hello to Firewalla Cloud");
  }

  async log(level, data) {
    const sysData = await this.prepareHelloData();
    const options = {
      uri: this.getEndpoint() + 'log/' + level,
      method: 'POST',
      json: Object.assign({}, data, sysData),
      maxAttempts: 2,
      timeout: 10000
    }
    log.info(`Sending diag log, [${level}] ${JSON.stringify(data)}`);
    await rrWithErrHandling(options);
  }
}

module.exports = new FWDiag();
