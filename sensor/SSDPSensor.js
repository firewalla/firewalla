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
'use strict';

const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;

const async = require('asyncawait/async');
const await = require('asyncawait/await');

const sem = require('../sensor/SensorEventManager.js').getInstance();

const SSDPClient = require('node-ssdp').Client

const request = require('request')

const parseString = require('xml2js').parseString;

const CACHE_INTERVAL = 3600 // one hour
const ERROR_CACHE_INTERVAL = 300 // five minutes

const l2 = require('../util/Layer2.js');

class SSDPSensor extends Sensor {

  onResponse(headers, statusCode, rinfo) {
    // only support ipv4 yet
    if(rinfo.family === 'IPv4' && statusCode === 200) {
      let ip = rinfo.address
      let location = headers.LOCATION

      let lastFoundTimestamp = this.locationCache[ip]
      if(!lastFoundTimestamp || lastFoundTimestamp < new Date() / 1000 - CACHE_INTERVAL) {
        this.locationCache[ip] = new Date() / 1000
        this.parseURL(ip, location, (err) => {
          if(err) {
            this.locationCache[ip] = new Date() / 1000 - (CACHE_INTERVAL - ERROR_CACHE_INTERVAL)
          }
        })
      }
    } else if (statusCode !== 200) {
      log.debug("Got an error ssdp response: ", headers, statusCode, rinfo, {})
    } else {
      log.warn("Unsupported ssdp response: ", headers, statusCode, rinfo, {})
    }
  }

  notify(ip, ssdpResult) {
    l2.getMAC(ip, (err, mac) => {
      
      if(err) {
        // not found, ignore this host
        log.error("Not able to found mac address for host:", ip, mac, {});
        return;
      }

      let host = {
        ipv4: ip,
        ipv4Addr: ip,
        mac: mac,
        bname: ssdpResult.deviceName,
        modelName: ssdpResult.modelName,
        manufacturer: ssdpResult.manufacturer,
        from: "ssdp"
      }

      log.info(`Found a device via ssdp: ${host.bname} (${ip} - ${host.mac})`)
      
      sem.emitEvent({
        type: "DeviceUpdate",
        message: "Found a device via ssdp",
        host: host
      })
      
    });
  }
  
  parseURL(ip, location, callback) {
    let options = {
      uri: location,
      method: 'GET'
    }
    request(options, (err, response, body) => {
      if(err) {
        log.error("Failed to GET", location, "err:", err, {})
        callback(err)
        return
      }

      parseString(body, (err, result) => {
        if(err) {
          log.error(`Invalid SSDP XML for location ${location}, err: ${err}`)
          callback(err)
          return
        }

        const rr = this.parseContent(result)

        if(rr.deviceName) {
          this.notify(ip, rr)
        }

        callback(null)
      })
    });
  }

  getElement(object, element) {
    let array = object[element]

    return array && (array.constructor.name === 'Array') && array.length > 0 && array[0]
  }
  
  parseContent(content) {
    let root = content && content.root

    if(!root) {
      return
    }

    let firstDevice = this.getElement(root, "device")

    if(!firstDevice)
      return

    let deviceName = this.getElement(firstDevice, "friendlyName")

    let manufacturer = this.getElement(firstDevice, "manufacturer")

    let modelName = this.getElement(firstDevice, "modelName")

    return {
      deviceName: deviceName,
      manufacturer: manufacturer,
      modelName: modelName
    }
  }
  
  run() {
    this.ssdpClient = new SSDPClient()
    this.locationCache = {}
    this.ssdpClient.on('response', (header, statusCode, rinfo) => {
      this.onResponse(header, statusCode, rinfo)
    })
    process.nextTick(() => {
      this.ssdpClient.search('ssdp:all')
    })

    setInterval(() => {
      this.ssdpClient.search('ssdp:all')
    }, 10 * 60 * 1000)          // every 10 minutes
  }
}


module.exports = SSDPSensor
