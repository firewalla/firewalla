/*    Copyright 2016 Firewalla LLC 
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

const log = require("../net2/logger.js")(__filename)

const fc = require("../net2/config.js")
const f = require("../net2/Firewalla.js")

const fs = require('fs')
const exec = require('child-process-promise').exec

const Promise = require('bluebird');
Promise.promisifyAll(fs);

const Sensor = require('./Sensor.js').Sensor

const rclient = require('../util/redis_manager.js').getRedisClient()

const HostManager = require('../net2/HostManager');
const hostManager = new HostManager();

const sysManager = require('../net2/SysManager.js');

const DNSTool = require('../net2/DNSTool.js');
const dnsTool = new DNSTool();

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const Alarm = require('../alarm/Alarm.js');
const AM2 = require('../alarm/AlarmManager2.js');
const am2 = new AM2();

const sem = require('../sensor/SensorEventManager.js').getInstance();

const monkeyPrefix = "monkey";

class NaughtyMonkeySensor extends Sensor {

  async job() {
    // Disable auto monkey for production or beta
    if (f.isProductionOrBeta()) {
      return;
    }

    if (fc.isFeatureOn("naughty_monkey")) {
      await this.delay(this.getRandomTime())
      await this.release({
        monkeyType: "malware"
      })
    }
  }

  async randomFindDevice() {
    const macs = hostManager.getActiveMACs();

    const macCount = macs.length
    if (macCount > 0) {
      let randomHostIndex = Math.floor(Math.random() * macCount)
      if (randomHostIndex == macCount) {
        randomHostIndex = macCount - 1
      }

      const mac = macs[randomHostIndex];
      return rclient.hgetAsync(`host:mac:${mac}`, "ipv4Addr");
    } else {
      return null
    }
  }

  randomFindTarget() {
    const list = [
      "185.220.101.10",
      "142.44.154.169",
      "89.144.12.17",
      "141.255.162.35",
      "163.172.214.8",
      "91.219.236.171",
      "176.123.8.224",
      "185.234.217.144",
      "185.234.217.142",
      "185.234.217.146"
    ];

    return list[Math.floor(Math.random() * list.length)]

  }

  randomBoolean() {
    return Math.random() >= 0.5;
  }

  async prepareVideoEnvironment(ip) {
    await dnsTool.addDns(ip, "v.qq.com");
  }

  async prepareGameEnvironment(ip) {
    await dnsTool.addDns(ip, "battle.net");
  }

  async preparePornEnvironment(ip) {
    await dnsTool.addDns(ip, "pornhub.com");
  }

  async release(event) {
    switch (event.monkeyType) {
      case "video":
        await this.video();
        break;
      case "game":
        await this.game();
        break;
      case "porn":
        await this.porn();
        break;
      case "ssh_scan":
        await this.ssh_scan();
        break;
      case "port_scan":
        await this.port_scan();
        break;
      case "abnormal_upload":
        await this.abnormal_upload();
        break;
      case "upnp":
        await this.upnp();
        break;
      case "subnet":
        await this.subnet();
        break;
      case "heartbleed":
        await this.heartbleed();
        break;
      case "heartbleedOutbound":
        await this.heartbleedOutbound();
        break;
      case "ssh_interesting_login":
        await this.interestingLogin();
        break;
      case "malware":
      default:
        await this.malware();
        break;
    }
  }

  async recordMonkey(ip) {
    const key = `${monkeyPrefix}:${ip}`;
    await rclient.setAsync(key, 1);
    await rclient.expireAsync(key, 300); // only live for 60 seconds
  }

  async abnormal_upload() {
    // do not know how to trigger...
  }

  async ssh_scan() {
    const ip = await this.randomFindDevice();
    const remoteIP = "116.62.163.55";

    const payload = {
      "ts": new Date() / 1000,
      "note": "SSH::Password_Guessing",
      "msg": `${remoteIP} appears to be guessing SSH passwords (seen in 30 connections).`,
      "sub": `Sampled servers:  ${ip}, ${ip}, ${ip}`,
      "src": remoteIP,
      "peer_descr": "bro",
      "actions": ["Notice::ACTION_LOG"],
      "suppress_for": 1800.0,
      "dropped": false
    }

    await this.appendNotice(payload);
  }

  async appendNotice(payload) {
    const tmpfile = "/tmp/monkey";
    await fs.writeFileAsync(tmpfile, JSON.stringify(payload) + "\n");

    const file = "/blog/current/notice.log";    
    const cmd = `sudo bash -c 'cat ${tmpfile} >> ${file}'`;
    await exec(cmd);
  }

  async port_scan() {
    const ip = await this.randomFindDevice();
    const remoteIP = "116.62.163.55";

    const payload = {
      "ts": new Date() / 1000,
      "note": "Scan::Port_Scan",
      msg: `${remoteIP} scanned at least 15 unique ports of host ${ip} in 0m3s`,
      "sub": "local",
      src: remoteIP,
      peer_descr: "bro",
      dst: ip,
      "actions": ["Notice::ACTION_LOG"],
      "suppress_for": 1800.0,
      "dropped": false
    }

    await this.appendNotice(payload);
  }

  async video() {
    const remoteIP = "180.153.105.174";

    await this.prepareVideoEnvironment(remoteIP);

    const ip = await this.randomFindDevice();

    await this.monkey(ip, remoteIP, "video");
    await this.recordMonkey(remoteIP);
  }

  async game() {
    const remoteIP = "24.105.29.30";

    await this.prepareGameEnvironment(remoteIP);

    const ip = await this.randomFindDevice()

    await this.monkey(ip, remoteIP, "game");
    await this.monkey(ip, remoteIP, "game");
    await this.monkey(ip, remoteIP, "game");
    await this.monkey(ip, remoteIP, "game");
    await this.monkey(ip, remoteIP, "game");

    await this.recordMonkey(remoteIP);
  }

  async porn() {
    const remoteIP = "146.112.61.106";
    await this.preparePornEnvironment(remoteIP);
    const ip = await this.randomFindDevice();
    await this.monkey(ip, remoteIP, "porn");
    await this.recordMonkey(remoteIP);
  }

  async upnp() {
    const ip = await this.randomFindDevice();

    const payload = {
      'p.source': 'NaughtyMonkeySensor',
      'p.device.ip': ip,
      'p.upnp.public.host': '',
      'p.upnp.public.port': parseInt(Math.random() * 65535),
      'p.upnp.private.host': ip,
      'p.upnp.private.port': parseInt(Math.random() * 65535),
      'p.upnp.protocol': this.randomBoolean() ? 'tcp' : 'udp',
      'p.upnp.enabled': this.randomBoolean(),
      'p.upnp.description': 'Monkey P2P Software',
      'p.upnp.ttl': parseInt(Math.random() * 9999),
      'p.upnp.local': this.randomBoolean(),
      'p.monkey': 1
    };

    payload["p.device.port"] = payload["p.upnp.private.port"];
    payload["p.protocol"] = payload["p.upnp.protocol"];

    let alarm = new Alarm.UpnpAlarm(
      new Date() / 1000,
      ip,
      payload
    );



    try {
      let enriched = await am2.enrichDeviceInfo(alarm);
      am2.enqueueAlarm(enriched);
    } catch(e) {}
  }

  async subnet() {
    const gateway = sysManager.myDefaultGateway();

    let alarm = new Alarm.SubnetAlarm(
      new Date() / 1000,
      gateway,
      {
        'p.device.ip': gateway,
        'p.subnet.length': parseInt(Math.random() * platform.getSubnetCapacity()),
        'p.monkey': 1
      }
    );

    try {
      let enriched = await am2.enrichDeviceInfo(alarm);
      am2.enqueueAlarm(enriched);
    } catch(e) {}
  }

  async malware() {
    const ip = await this.randomFindDevice()
    const remote = this.randomFindTarget()

    await this.monkey(remote, ip, "malware");
    await this.recordMonkey(remote);
  }

  async heartbleed() {
    const ip = await this.randomFindDevice();

    const heartbleedJSON = require("../extension/monkey/heartbleed.json");
    heartbleedJSON["id.resp_h"] = ip;
    heartbleedJSON["dst"] = ip;
    heartbleedJSON["ts"] = new Date() / 1000;

    const remote = heartbleedJSON["id.orig_h"];

    await this.appendNotice(heartbleedJSON);
    await this.recordMonkey(remote);
  }

  async heartbleedOutbound() {
    const ip = await this.randomFindDevice();

    const heartbleedJSON = JSON.parse(JSON.stringify(require("../extension/monkey/heartbleed.json")));
    heartbleedJSON["id.resp_h"] = ip;
    heartbleedJSON["dst"] = ip;
    heartbleedJSON["ts"] = new Date() / 1000;

    const remote = heartbleedJSON["id.orig_h"];

    // swap from and to
    const x = heartbleedJSON["id.resp_h"];
    heartbleedJSON["id.resp_h"] = heartbleedJSON["id.orig_h"];
    heartbleedJSON["id.orig_h"] = x;   
    
    const y = heartbleedJSON["id.resp_p"];
    heartbleedJSON["id.resp_p"] = heartbleedJSON["id.orig_p"];
    heartbleedJSON["id.orig_p"] = y; 

    const z = heartbleedJSON["src"];
    heartbleedJSON["src"] = heartbleedJSON["dst"];
    heartbleedJSON["dst"] = z;

    await this.appendNotice(heartbleedJSON);
    await this.recordMonkey(remote);
  }

  async interestingLogin() {
    const ip = await this.randomFindDevice();

    const heartbleedJSON = JSON.parse(JSON.stringify(require("../extension/monkey/interestinglogin.json")));
    heartbleedJSON["id.resp_h"] = ip;
    heartbleedJSON["dst"] = ip;
    heartbleedJSON["ts"] = new Date() / 1000;

    const remote = heartbleedJSON["id.orig_h"];

    await this.appendNotice(heartbleedJSON);
    await this.recordMonkey(remote);
  }

  async monkey(src, dst, tag, options) {
    options = options || {};

    const duration = options.duration || 10000;
    const length = options.length || 10000000;

    const cmd = `${f.getFirewallaHome}/bin/node malware_simulator.js --src ${src}  --dst ${dst} --duration ${duration} --length ${length}`
    log.info(`Release a ${tag} monkey for ${src} and ${dst}: ${cmd}`);
    await exec(cmd, {
      cwd: f.getFirewallaHome() + "/testLegacy/"
    }).catch((err) => {
      log.error("Failed to release monkey", cmd, err);
    })

  }

  run() {

    // if(!f.isDevelopmentVersion()) {
    //   return // do nothing if non dev version
    // }    
    this.job()

    sem.on('ReleaseMonkey', (event) => {
      if (fc.isFeatureOn("naughty_monkey")) {
        this.release(event)
      }
    })

    setInterval(() => {
      this.job()
    }, 1000 * 3600 * 24) // release a monkey once every day
  }

  // in milli seconds
  getRandomTime() {
    return Math.floor(Math.random() * 1000 * 3600 * 24) // anytime random within a day
  }
}

module.exports = NaughtyMonkeySensor
