/*    Copyright 2016-2020 Firewalla Inc.
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

const sysManager = require('../../net2/SysManager.js')

const HostTool = require('../../net2/HostTool.js');
const hostTool = new HostTool();

const log = require('../../net2/logger.js')(__filename);

class BroNotice {
  constructor() {
    if (instance === null) {
      instance = this;
    }
  }

  //  src: guesser
  //  sub: target
  //  dst: no presence
  async processSSHScan(alarm, broObj) {
    const subMessage = broObj.sub
    // sub message:
    //   Sampled servers:  10.0.1.182, 10.0.1.182, 10.0.1.182, 10.0.1.182, 10.0.1.182

    let addresses = subMessage.replace(/.*Sampled servers: {2}/, '').split(", ")
    addresses = addresses.filter((v, i, array) => {
      return array.indexOf(v) === i
    })

    if (addresses.length == 0) {
      alarm["p.local.decision"] = "ignore";
      return null;
    }
    let deivceNames = [];
    for (const address of addresses) {
      let deviceName = await hostTool.getName(address);
      deviceName = deviceName ? deviceName : address;
      deivceNames.push(deviceName)
    }

    let target = addresses[0];

    if (alarm["p.device.ip"] == broObj.src) {
      // attacker is internal device
      alarm["p.local_is_client"] = "1";
      alarm["p.dest.ip"] = target;
    } else {
      // attacker is external device
      alarm["p.local_is_client"] = "0";
      alarm["p.device.ip"] = target;
      alarm["device"] = target;
    }

    alarm["p.message"] = `${alarm["p.message"].replace(/\.$/, '')} on device: ${deivceNames.join(",")}`
  }

  //  src: scanner
  //  dst: target
  //  sub: "local" || "remote"
  async processPortScan(alarm, broObj) {
    if (alarm["p.device.ip"] == broObj.src) {
      alarm["p.local_is_client"] = "1";
    } else {
      alarm["p.local_is_client"] = "0";
    }
    let srcName = null;
    let dstName = null;
    if (sysManager.isLocalIP(alarm["p.device.ip"])) {
      srcName = await hostTool.getName(alarm["p.device.ip"]);
    }
    if (sysManager.isLocalIP(alarm["p.dest.ip"])) {
      dstName = await hostTool.getName(alarm["p.dest.ip"]);
    }
    alarm['p.message'] = `${srcName ? srcName : alarm["p.device.ip"]} was scanning ports of ${dstName ? dstName + `(${alarm["p.dest.ip"]})`: alarm["p.dest.ip"]}.`;
  }

  async processHeartbleed(alarm, broObj) {
    if (sysManager.isLocalIP(broObj["src"])) {
      alarm["p.local_is_client"] = "1";
    } else {
      // initiated from outside
      alarm["p.local_is_client"] = "0";
      alarm["p.action.block"] = true; // block automatically if initiated from outside in
    }

    if (alarm['p.noticeType'] == 'Heartbleed::SSL_Heartbeat_Attack_Success')
      alarm['p.action.block'] = true; // block automatically if attack succeed
  }

  //  sub: interesting host name
  async processSSHInterestingLogin(alarm, broObj) {
    const sub = broObj["sub"];

    if (sub) {
      alarm["p.dest.name"] = sub;
    }
  }

  // on HTTP src/dst compiles with HTTP connection
  // sub: match description link
  async processTeamCymru(alarm, broObj) {
    if (sysManager.isLocalIP(broObj.src)) {
      alarm["p.local_is_client"] = "1";
    } else {
      // initiated from outside
      alarm["p.local_is_client"] = "0";
      alarm["p.action.block"] = true; // block automatically if initiated from outside in
    }

    if (broObj["file_mime_type"]) {
      alarm["p.file.type"] = broObj["file_mime_type"];
    }

    if (broObj["file_desc"]) {
      alarm["p.file.desc"] = broObj["file_desc"];
    }

    if (broObj.sub) {
      alarm["p.malware.reference"] = broObj.sub;
    }
  }

  //  src: victim
  //  dst: no presence
  async processSQLInjection(alarm, broObj) {
    if (alarm["p.device.ip"] == broObj.src) {
      alarm["p.local_is_client"] = "0";
      alarm["p.action.block"] = true;
    } else {
      alarm["p.local_is_client"] = "1";
    }
  }

  async processNotice(alarm, broObj) {
    const noticeType = alarm["p.noticeType"];

    if (!noticeType || !broObj) {
      log.warn('Invalid bro notice', broObj)
      return null;
    }

    // ignore notice triggered by Firewalla itself
    if (sysManager.isMyIP(broObj.src)) {
      log.info("Ignoring bro notice", broObj)
      return null;
    }

    alarm["e.bro.raw"] = JSON.stringify(broObj);

    switch (noticeType) {
      case "SSH::Password_Guessing":
        await this.processSSHScan(alarm, broObj);
        break;

      case "Heartbleed::SSL_Heartbeat_Attack":
      case "Heartbleed::SSL_Heartbeat_Attack_Success":
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

      case 'HTTP::SQL_Injection_Victim':
        await this.processSQLInjection(alarm, broObj);
        break

      default:
        // do nothing
        break;
    }
    return alarm;
  }

  getBlockTarget(alarm) {
    return {
      type: "ip",
      target: alarm["p.dest.ip"]
    }
  }
}

module.exports = new BroNotice();
