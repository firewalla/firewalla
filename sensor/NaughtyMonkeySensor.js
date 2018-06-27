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

const firewalla = require('../net2/Firewalla.js')
const log = require("../net2/logger.js")(__filename)

const fc = require("../net2/config.js")
const f = require("../net2/Firewalla.js")

const fs = require('fs')
const exec = require('child-process-promise').exec

const Promise = require('bluebird');
Promise.promisifyAll(fs);

const Sensor = require('./Sensor.js').Sensor

const rclient = require('../util/redis_manager.js').getRedisClient()

const HostManager = require('../net2/HostManager')
const hostManager = new HostManager('cli', 'server');

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
    let hosts = await rclient.keysAsync("host:ip4:*");
    hosts = hosts.map((h) => h.replace("host:ip4:", ""));

    const hostCount = hosts.length
    if (hostCount > 0) {
      let randomHostIndex = Math.floor(Math.random() * hostCount)
      if (randomHostIndex == hostCount) {
        randomHostIndex = hostCount - 1
      }
      return hosts[randomHostIndex];
    } else {
      return null
    }
  }

  randomFindTarget() {
    const list = ["204.85.191.30",
      "46.235.227.70",
      "193.107.85.56",
      "5.79.68.161",
      "204.8.156.142",
      "37.48.120.196",
      "37.187.7.74",
      "162.247.72.199"
    ]

    return list[Math.floor(Math.random() * list.length)]

  }

  async prepareVideoEnvironment(ip) {
    const dnsInfo = {
      host: "v.qq.com",
      lastActive: "1528268891",
      count: 44,
      ssl: 1,
      established: true
    }

    await rclient.hmset(`dns:ip:${ip}`, dnsInfo);
  }

  async prepareGameEnvironment(ip) {
    const dnsInfo = {
      host: "battle.net",
      lastActive: "1528268891",
      count: 44,
      ssl: 1,
      established: true
    }

    await rclient.hmset(`dns:ip:${ip}`, dnsInfo);
  }

  async preparePornEnvironment(ip) {
    const dnsInfo = {
      host: "pornhub.com",
      lastActive: "1528268891",
      count: 44,
      ssl: 1,
      established: true
    }

    await rclient.hmset(`dns:ip:${ip}`, dnsInfo);
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
      case "heartbleed":
        await this.heartbleed();
        break;
      case "heartbleedOutbound":
        await this.heartbleedOutbound();
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
    const remoteIP = "116.62.163.43";

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

  async monkey(src, dst, tag, options) {
    options = options || {};

    const duration = options.duration || 10000;
    const length = options.length || 10000000;

    const cmd = `node malware_simulator.js --src ${src}  --dst ${dst} --duration ${duration} --length ${length}`
    log.info(`Release a ${tag} monkey for ${src} and ${dst}: ${cmd}`);
    await exec(cmd, {
      cwd: f.getFirewallaHome() + "/testLegacy/"
    }).catch((err) => {
      log.error("Failed to release monkey", cmd, err, {})
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