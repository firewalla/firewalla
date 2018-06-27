/*    Copyright 2016 Firewalla LLC / Firewalla LLC
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
let instance = null;

const SysManager = require('../../net2/SysManager.js')
const sysManager = new SysManager();

const HostTool = require('../../net2/HostTool.js');
const hostTool = new HostTool();

const log = require('../../net2/logger.js')(__filename);

class BroNotice {
  constructor() {
    if(instance === null) {
      instance = this;
    }
  }

  async processSSHScan(alarm, broObj) {
    const subMessage = broObj.sub
    // sub message:
    //   Sampled servers:  10.0.1.182, 10.0.1.182, 10.0.1.182, 10.0.1.182, 10.0.1.182
    
    let addresses = subMessage.replace(/.*Sampled servers:  /, '').split(", ")
    addresses = addresses.filter((v, i, array) => {
      return array.indexOf(v) === i
    })

    if(addresses.length > 0) {
      const ip = addresses[0];
      alarm["p.device.ip"] = ip;
      alarm["p.device.name"] = ip;
      const mac = await hostTool.getMacByIP(ip);
      if(mac) {
        alarm["p.device.mac"] = mac;
      }
    }

    alarm["p.message"] = `${alarm["p.message"].replace(/\.$/, '')} on device: ${addresses.join(",")}`
  }

  async processPortScan(alarm, broObj) {

  }

  async processHeartbleed(alarm, broObj) {
    const from = broObj["src"];
    const to = broObj["dst"];

    let localIP = null;
    // initiated from myself
    if(sysManager.isLocalIP(from)) {
      alarm["p.local_is_client"] = "1";
    } else {
      // initiated from outside
      alarm["p.local_is_client"] = "0";
      alarm["p.action.block"] = true; // block automatically if initiated from outside in
    }
  }

  async processNotice(alarm, broObj) {
    const noticeType = alarm["p.noticeType"];

    if(!noticeType) {
      return;
    }

    switch(noticeType) {
      case "SSH::Password_Guessing":
      await this.processSSHScan(alarm, broObj);
      break;

      case "Heartbleed::SSL_Heartbeat_Attack":
      await this.processHeartbleed(alarm, broObj);
      break;

      case "Scan::Port_Scan":
      await this.processPortScan(alarm, broObj);
      break;

      default:
      // do nothing
      break;
    }
  }

  getBlockTarget(alarm) {
    return {
      type: "ip",
      target: alarm["p.dest.ip"]
    }
  }  
};

module.exports = new BroNotice();