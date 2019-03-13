/*    Copyright 2019 Firewalla LLC / Firewalla LLC
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

    if(addresses.length == 0) {
      alarm["p.local.decision"] == "ignore";
      return;
    }

    const scanSrc = broObj.src;
    const scanTarget = addresses[0];

    let deviceIP = null;
    let destIP = null;

    if(sysManager.isLocalIP(scanTarget)) {
      deviceIP = scanTarget;
      destIP = scanSrc;
      alarm["p.local_is_client"] = 0;
    } else {
      deviceIP = scanSrc;
      destIP = scanTarget;
      alarm["p.local_is_client"] = 1;
    }

    alarm["p.device.ip"] = deviceIP;
    alarm["p.device.name"] = deviceIP;

    const mac = await hostTool.getMacByIP(deviceIP);
    if(mac) {
      alarm["p.device.mac"] = mac;
    }

    alarm["p.dest.ip"] = destIP;

    alarm["p.message"] = `${alarm["p.message"].replace(/\.$/, '')} on device: ${addresses.join(",")}`
  }

  async processPortScan(alarm, broObj) {

  }

  async processHeartbleed(alarm, broObj) {
    this.checkDirectionAndAutoBlock(alarm, broObj);
  }

  async processSSHInterestingLogin(alarm, broObj) {
    const sub = broObj["sub"];

    if(sub) {
      alarm["p.dest.name"] = sub;
    }
  }

  async processTeamCymru(alarm, broObj) {
    this.checkDirectionAndAutoBlock(alarm, broObj);

    alarm['p.file.url'] = broObj.file_desc;
    alarm['p.file.mime'] = broObj.file_mime_type;
    alarm['e.detail'] = broObj.sub;
    alarm["p.action.block"] = true; // block automatically if initiated from outside in
  }

  async processSQLInjection(alarm, broObj) {
    this.checkDirectionAndAutoBlock(alarm, broObj);
  }

  async processNotice(alarm, broObj) {
    const noticeType = alarm["p.noticeType"];

    if(!noticeType || !broObj) {
      return;
    }

    alarm["e.bro.raw"] = JSON.stringify(broObj);

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

      case "SSH::Interesting_Hostname_Login":
        await this.processSSHInterestingLogin(alarm, broObj);
        break;

      case "TeamCymruMalwareHashRegistry::Match":
        await this.processTeamCymru(alarm, broObj);
        break;

      case 'HTTP::SQL_Injection_Attacker':
      case 'HTTP::SQL_Injection_Victim':
        await this.processSQLInjection(alarm, broObj);
        break

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

  checkDirectionAndAutoBlock(alarm, broObj) {
    const src = broObj["src"];

    if(sysManager.isLocalIP(src)) {
      alarm["p.local_is_client"] = "1";
    } else {
      // initiated from outside
      alarm["p.local_is_client"] = "0";
      alarm["p.action.block"] = true; // block automatically if initiated from outside in
    }
  }
};

module.exports = new BroNotice();
