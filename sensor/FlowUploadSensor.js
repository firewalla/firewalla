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

let util = require('util')
let async = require('asyncawait/async')
let await = require('asyncawait/await')
let zlib = require('zlib')
let Promise = require('bluebird')

let log = require('../net2/logger.js')(__filename)
let Sensor = require('./Sensor.js').Sensor
let HostManager = require('../net2/HostManager.js')
let hostManager = new HostManager('cli', 'server')
let HostTool = require('../net2/HostTool')
let hostTool = new HostTool()
let flowTool = require('../net2/FlowTool')()
let flowUtil = require('../net2/FlowUtil')
let Bone = require('../lib/Bone.js')

let INTERVAL_MIN = 10 //10 seconds
let INTERVAL_MAX = 3600 //1 hour
let INTERVAL_DEFAULT = 900 //15 minutes
let MAX_UPLOAD_SIZE = 1024 * 1024 * 1024 //1G

class FlowUploadSensor extends Sensor {
    constructor() {
        super()
        
    }

    run() {
        this.validateConfig()
        log.info(JSON.stringify(this.config))
        this.startTime = new Date() / 1000
        setInterval(() => {
            this.schedule();
          }, this.config.interval * 1000)
    }

    validateConfig(){
        if (this.config == null) {
            this.config = {}
        }
        if (this.config.interval == null) {
            this.config.interval = INTERVAL_DEFAULT
        } else if (this.config.interval < INTERVAL_MIN) {
            this.config.interval = INTERVAL_MIN
        } else if (this.config.interval > INTERVAL_MAX) {
            this.config.interval = INTERVAL_MAX
        }

        if (this.config.maxLength == null || this.config.maxLength > MAX_UPLOAD_SIZE) {
            this.config.maxLength = MAX_UPLOAD_SIZE
        }
    }

    schedule() {
        let endTime = new Date() / 1000
        //upload flow to cloud
        log.info("try to upload flows from "
         + this.startTime + "(" + new Date(this.startTime * 1000).toUTCString() + ")" + 
         " to " + endTime + "(" + new Date(endTime * 1000).toUTCString() + ")")

         return async(() => {
            try {
                let flows = await(this.getAllFlows(this.startTime, endTime))
                //set next start point
                this.startTime = endTime + 0.001
                if (flows != null && flows.flows != null && Object.keys(flows.flows).length > 0) {
                    let data = JSON.stringify(flows)
                    log.info("original:" + data)
                    log.info("original length:" + data.length)
                    let compressedData = await(this.compressData(data))
                    //log.info("compressed:" + compressedData)
                    let length = compressedData.length
                    log.info("compressed length:" + length)
                    if (length > this.config.maxLength) {
                        log.warn("data length " + length + " exceeded max length " + this.config.maxLength + ", abort uploading to cloud")
                    } else {
                        await(this.uploadData(compressedData))
                        log.info("upload flows to cloud complete")
                    }
                } else {
                    log.info("empty flows, wait to next round")
                }
            } catch (err) {
                log.error("upload flows failed:" + err.toString())
                //skip this time range, set next start point
                this.startTime = endTime + 0.001
            }
          })();
    }

    uploadData(data) {
        return async(() => {
            let toUpload = {
                payload : data
            }    
            await(Bone.flowgraph('flow', toUpload, function(err, response){
                if (err) {
                    log.error("upload to cloud failed:" + err)
                } else {
                    log.info("upload to cloud success:" + JSON.stringify(response))
                }
            }))
        })();
    }

    compressData(data) {
        return async(() => {
            return new Promise(function (resolve, reject) {
                let input = new Buffer(data, 'utf8');
                zlib.deflate(input, (err, output) => {
                    if(err) {
                        reject(err)
                    } else {
                        resolve(output.toString('base64'))
                    }
                })
            })
        })();
    }

    getAllFlows(start, end) {
        return async(() => {
            let macs = this.getQualifiedDevices();
            let flows = {}
            macs.forEach((mac) => {
                let flow = await(this.getFlowByMac(mac, start, end))
                if (flow != null && flow.length > 0) {
                    flows[flowUtil.hashMac(mac)] = flow
                }
            })
            return {
                start : start,
                end : end,
                flows : flows
            }
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
            return this.processFlow(flows, true)
        })();
    }

    processFlow(flows, clean) {
        return flows.map(f => {
            //hash
            let r = flowUtil.hashFlow(f, clean)
            //remove key with empty value
            Object.keys(r).forEach(k => {
                if (r[k] == null) {
                    delete r[k]
                } else if (Array.isArray(r[k]) && r[k].length == 0) {
                    delete r[k]
                } else if (typeof r[k] === 'object' && Object.keys(r[k]).length == 0) {
                    delete r[k]
                }
            })
            return r
        })
    }

    // return a list of mac addresses that's active in last xx days
    getQualifiedDevices() {
        return hostManager.hosts.all.map(h => h.o.mac).filter(mac => mac != null);
    }
}

module.exports = FlowUploadSensor