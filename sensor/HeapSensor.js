/*    Copyright 2016-2021 Firewalla Inc.
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

const sclient = require('../util/redis_manager.js').getSubscriptionClient()
const pclient = require('../util/redis_manager.js').getPublishClient()

const heapdump = require('heapdump');


class HeapSensor extends Sensor {
  constructor(config) {
    super(config);
    
    this.wip = false;
    log.info("heapsensor is running");
  }

  run() {
    sclient.on("message", (channel, message) => {
      if(channel === "heapdump" && message) {
        try {
          let m = JSON.parse(message);

          if ( m.title === process.title) {
            heapdump.writeSnapshot(m.file, this.onComplete);
          }
        } catch (err) {
          log.error("Failed to parse JSON message: ", message);
        }
      } else if(channel === "gc" && message === process.title)  {
        global.gc()
        log.info("GC complete!")
      }
    });
    
    sclient.subscribe("heapdump");
    sclient.subscribe("gc");
  }
  
  onComplete(err, file) {
    if(err) {
      log.error("Failed to dump heap data:", err);
      return;
    }
    
    if(!file.startsWith("/"))
      file = process.cwd() + "/" + file;
    
    log.info("Heap data is dumped to file:", file)
    
    let payload = JSON.stringify({
      file: file,
      title: process.title
    });
    
    pclient.publish("heapdump_done", payload);
  }
  
}

module.exports = HeapSensor;
