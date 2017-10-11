'use strict';

let util = require('util')
let async = require('asyncawait/async');
let await = require('asyncawait/await');

let log = require('../net2/logger.js')(__filename)
let Sensor = require('./Sensor.js').Sensor

let HostManager = require('../net2/HostManager.js');
let hostManager = new HostManager('cli', 'server');

let HostTool = require('../net2/HostTool')
let hostTool = new HostTool();

let flowTool = require('../net2/FlowTool')();

let Promise = require('bluebird');

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
            this.schedule();
          }, this.config.interval * 1000)
    }

    schedule() {
        let endTime = new Date() / 1000
        //upload flow to cloud
        log.info("start to upload flow from "
         + this.startTime + "(" + new Date(this.startTime * 1000).toTimeString() + ")" + 
         " to " + endTime + "(" + new Date(endTime * 1000).toUTCString() + ")")

         return async(() => {
            try {
                let flows = await(this.getAllFlows(this.startTime, endTime))
                if (flows != null && Object.keys(flows).length > 0) {
                    let data = {
                        start : this.startTime,
                        end : endTime,
                        flows : flows
                    }
                    let compressedData = this.compressData(data)
                    this.startTime = endTime + 0.001
                }
            } catch (err) {
                log.error("something wrong when getting flow" + err.toString())
            }
          })();
    }

    compressData(data) {
        log.info(JSON.stringify(data))
    }

    getAllFlows(start, end) {
        if (end - start < INTERVAL_MIN) {
            return Promise.reject(new Error("Get flow too soon ("  + (end - start) + " seconds)"));
        }
        return async(() => {
            let macs = this.getQualifiedDevices();
            let flows = {}
            macs.forEach((mac) => {
                let flow = await(this.getFlowByMac(mac, start, end))
                if (flow != null && flow.length > 0) {
                    flows[mac] = flow
                }
            })
            return flows
          })();
    }

    getFlowByMac(mac, start, end) {
        return async(() => {
            let ips = await (hostTool.getIPsByMac(mac));
            let flows = [];
            ips.forEach((ip) => {
                let outgoingFlows = await (flowTool.queryFlows(ip, "in", start, end)); // in => outgoing
                flows.push.apply(flows, outgoingFlows);
                let incomingFlows = await (flowTool.queryFlows(ip, "out", start, end)); // out => incoming
                flows.push.apply(flows, incomingFlows);
            });
            return flows
        })();
    }

    // return a list of mac addresses that's active in last xx days
    getQualifiedDevices() {
        return hostManager.hosts.all.map(h => h.o.mac).filter(mac => mac != null);
    }
}

module.exports = FlowUploadSensor