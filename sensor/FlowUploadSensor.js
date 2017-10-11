'use strict';

let util = require('util')

let log = require('../net2/logger.js')(__filename)
let Sensor = require('./Sensor.js').Sensor



class FlowUploadSensor extends Sensor {
    constructor() {
        super()
    }

    run() {
        this.startTime = new Date() / 1000
        //do some protection if interval configured by mistake
        if (this.config.interval < 10 || this.config.interval > 86400) {
            this.config.interval = 900 //15 minutes
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
        this.startTime = endTime + 0.001
    }
}

module.exports = FlowUploadSensor