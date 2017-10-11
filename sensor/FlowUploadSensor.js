'use strict';

let util = require('util')
let async = require('asyncawait/async');
let await = require('asyncawait/await');

let log = require('../net2/logger.js')(__filename)
let Sensor = require('./Sensor.js').Sensor

let HostManager = require('../net2/HostManager.js');
let hostManager = new HostManager('cli', 'server');

let INTERVAL_MIN = 10 //10 seconds
let INTERVAL_MAX = 3600 //1 hour
let INTERVAL_DEFAULT = 900 //15 minutes

class FlowUploadSensor extends Sensor {
    constructor() {
        super()
    }

    run() {
        this.startTime = new Date() / 1000
        //do some protection if interval configured by mistake
        if (this.config.interval < INTERVAL_MIN || this.config.interval > INTERVAL_MAX) {
            this.config.interval = INTERVAL_DEFAULT
        }
        log.info("schedule started with interval " + this.config.interval + " seconds")
        setInterval(() => {
            this.uploadFlow();
          }, this.config.interval * 1000)
    }

    uploadFlow() {
        let endTime = new Date() / 1000
        //upload flow to cloud
        log.info("start to upload flow from "
         + this.startTime + "(" + new Date(this.startTime * 1000).toTimeString() + ")" + 
         " to " + endTime + "(" + new Date(endTime * 1000).toUTCString() + ")")

         return async(() => {
            try {
                await(this.getFlow(this.startTime, endTime))
                log.info("Upload flow to cloud complete");
                this.startTime = endTime + 0.001
            } catch (err) {
                log.error("something wrong when getting flow" + err.toString())
            }
          })();
    }

    getFlow(start, end) {
        if (end - start < INTERVAL_MIN) {
            return Promise.reject(new Error("Get flow too soon ("  + (end - start) + " seconds)"));
        }
        return async(() => {
            let macs = this.getQualifiedDevices();
            macs.forEach((mac) => {
              
            })
          })();
    }

    // return a list of mac addresses that's active in last xx days
    getQualifiedDevices() {
        return hostManager.hosts.all.map(h => h.o.mac).filter(mac => mac != null);
    }
}

module.exports = FlowUploadSensor