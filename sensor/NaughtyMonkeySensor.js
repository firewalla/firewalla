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

const Sensor = require('./Sensor.js').Sensor

const async = require('asyncawait/async');
const await = require('asyncawait/await');

const HostManager = require('../net2/HostManager')
const hostManager = new HostManager('cli', 'server');

const sem = require('../sensor/SensorEventManager.js').getInstance();

class NaughtyMonkeySensor extends Sensor {

  job() {
    return async(() => {
      
      // Disable auto monkey for production or beta
      if(f.isProductionOrBeta()) {
        return;
      }
      
      if(fc.isFeatureOn("naughty_monkey")) {
        await (this.delay(this.getRandomTime()))

        this.release()
      }
    })()
  }
  
  randomFindDevice() {
    const hosts = hostManager.hosts.all
    const hostCount = hosts.length
    if(hostCount > 0) {
      let randomHostIndex = Math.floor(Math.random() * hostCount)
      if(randomHostIndex == hostCount) {
        randomHostIndex = hostCount - 1
      }
      return hosts[randomHostIndex] && hosts[randomHostIndex].o
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
      "162.247.72.199"]

    return list[Math.floor(Math.random() * list.length)]

  }

  release() {
    // do stuff   
    this.malware()
  }

  malware() {
    const host = this.randomFindDevice()
    const remote = this.randomFindTarget()

    // node malware_simulator.js --src 176.10.107.180  --dst 192.168.2.166 --duration 1000 --length 100000

    if(host && host.ipv4Addr) {
      const ip = host.ipv4Addr

      const cmd = `node malware_simulator.js --src ${remote}  --dst ${ip} --duration 1000 --length 100000`
      log.info("Release a monkey:", cmd)
      return exec(cmd, {
        cwd: f.getFirewallaHome() + "/testLegacy/"
      }).catch((err) => {
        log.error("Failed to release monkey", cmd, err, {})
      })
    } else {
      log.warn("can't find a host to release a monkey")
    }
  }

  run() {

    // if(!f.isDevelopmentVersion()) {
    //   return // do nothing if non dev version
    // }    
    this.job()

    sem.on('ReleaseMonkey', (event) => {
      if(fc.isFeatureOn("naughty_monkey")) {
        this.release()
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

