'use strict'

let instance = null;

const exec = require('child-process-promise').exec;
const fConfig = require('../../net2/config.js').getConfig();
const log = require('../../net2/logger.js')(__filename);

const get_interfaces_list_async = require('bluebird').promisify(require('network').get_interfaces_list);
const activeInterface = fConfig.monitoringInterface || "eth0";

const platformLoader = require('../../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const model = platform.getName();
const serial = platform.getBoardSerial();

const rp = require('request-promise');

class FWDiag {
  constructor() {
    if(instance === null) {
      instance = this;
    }

    return instance;
  }

  async getNetworkInfo() {
    const list = await get_interfaces_list_async();
    for(const inter of list) {
      if(inter.name === activeInterface) {
        return inter;
      }
    }

    return null;
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
    const result = await exec(cmd);
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

  async prepareData(payload) {
    const inter = await this.getNetworkInfo();
    
    const ip = inter.ip_address;
    const gateway = inter.gateway_ip;
    const mac = inter.mac_address;

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
        uri: `${fConfig.firewallaDiagServerURL}/${data.gw}` || `https://api.firewalla.com/diag/api/v1/device/${data.gw}`,
        method: 'POST',
        json: data
      }
      const result = await rp(options);
      if(result && result.mode) {
        await rclient.setAsync("recommend_firewalla_mode", result.mode);
      }

      if(result && result.guessedRouter) {
        await rclient.setAsync("guessed_router", JSON.stringify(result.guessedRouter));
      }

      log.info("submitted info to diag server successfully with result", result);
    }
  }

  async prepareHelloData() {
    const inter = await this.getNetworkInfo();
    
    const firewallaIP = inter.ip_address;
    const mac = inter.mac_address;
    const gateway = inter.gateway_ip;

    const version = this.getVersion();

    const [gatewayMac, branch, longVersion, memory] = await require('bluebird').all([
      this.getGatewayMac(gateway),
      this.getBranchInfo(),
      this.getLongVersion(),
      this.getTotalMemory()
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
      serial
    };
  }

  async sayHello() {
    const data = await this.prepareHelloData();
    const options = {
      uri: `${fConfig.firewallaDiagServerURL}/hello` || `https://api.firewalla.com/diag/api/v1/device/hello`,
      method: 'POST',
      json: data
    }
    await rp(options);
    log.info("said hello to Firewalla Cloud");
  }
}

module.exports = new FWDiag();