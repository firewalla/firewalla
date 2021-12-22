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
'use strict'

const zlib = require('zlib')
const Promise = require('bluebird')

const log = require('../net2/logger.js')(__filename)
const Sensor = require('./Sensor.js').Sensor
const sysManager = require('../net2/SysManager')
const HostManager = require('../net2/HostManager.js')
const hostManager = new HostManager()
const HostTool = require('../net2/HostTool')
const hostTool = new HostTool()
const flowTool = require('../net2/FlowTool')
const flowUtil = require('../net2/FlowUtil')
const Bone = require('../lib/Bone.js')

const INTERVAL_MIN = 10 //10 seconds
const INTERVAL_MAX = 3600 //1 hour
const INTERVAL_DEFAULT = 900 //15 minutes
const MAX_FLOWS = 50000 //can upload at most 50000 flows(after aggregation) to cloud, about 20 mb after compress
const TIME_OFFSET = 90 //90 seconds for other process to store latest data into redis

class FlowUploadSensor extends Sensor {
    run() {
        this.validateConfig()
        log.info(JSON.stringify(this.config))
        this.startTime = new Date() / 1000 - this.config.offset
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

        if (this.config.maxFlows == null || this.config.maxFlows > MAX_FLOWS) {
            this.config.maxFlows = MAX_FLOWS
        }

        if (this.config.offset == null || this.config.offset < 0) {
            this.config.offset = TIME_OFFSET
        }
    }

    async schedule() {
        let start = this.startTime
        let end = new Date() / 1000 - this.config.offset
        //upload flow to cloud
        log.info("try to upload flows from "
            + start + "(" + new Date(start * 1000).toUTCString() + ")" +
            " to " + end + "(" + new Date(end * 1000).toUTCString() + ")")

        try {
            //set next start point
            this.startTime = end + 0.001

            let macs = hostManager.getActiveMACs()
            if (macs == null || macs.length == 0) {
                log.info("host manager not ready, wait to next round")
                return
            }
            let debug = sysManager.isSystemDebugOn()
            let flows = await this.getAllFlows(macs, start, end, !debug)
            if (flows != null && flows.length > 0) {
                let limitedFlows = this.limitFlows(flows)
                limitedFlows.start = start
                limitedFlows.end = end

                let data = JSON.stringify(limitedFlows)
                log.debug("original:", data)
                log.info("original length:" + data.length)

                let compressedData = await this.compressData(data)
                log.debug("compressed:", compressedData)
                log.info("compressed length:" + compressedData.length)
                log.info("compress ratio:" + data.length / compressedData.length)

                this.uploadData(compressedData)
            } else {
                log.info("empty flows, wait to next round")
            }
        } catch (err) {
            log.error("upload flows failed:" + err.toString())
        }
    }

    uploadData(data) {
        let toUpload = {
            payload : data
        }
        Bone.flowgraph('flow', toUpload, function(err, response){
            if (err) {
                log.error("upload to cloud failed:" + err)
            } else {
                log.info("upload to cloud success:" + JSON.stringify(response))
            }
        })
    }

    compressData(data) {
        return new Promise(function (resolve, reject) {
            let input = Buffer.from(data, 'utf8');
            zlib.deflate(input, (err, output) => {
                if (err) {
                    reject(err)
                } else {
                    resolve(output.toString('base64'))
                }
            })
        })
    }

    limitFlows(flows) {
        //limit flows for upload
        let total = this.getSize(flows)
        var uploaded = total
        if (total > this.config.maxFlows) {
            log.info("number of flows(" + total + ") exceeded limit(" + this.config.maxFlows + "), need cut off")
            let avgLimit = this.config.maxFlows / flows.length
            //avgLimit means the number limit of flows for each mac
            flows.map(flow => {
                if (flow.flows.length > avgLimit) {
                    flow.flows = flow.flows.slice(0, avgLimit)
                }
            })
            uploaded = this.getSize(flows)
        }
        log.info("will upload " + uploaded + " flows")
        return {
            flows : flows,
            total : total,
            uploaded : uploaded
        }
    }

    async getAllFlows(macs, start, end, needHash) {
        let flows = []
        for (const mac of macs) {
            let flow = await this.getFlows(mac, start, end)
            if (flow != null && flow.length > 0) {
                flows.push(
                    {
                        flows: this.processFlow(flow, needHash),
                        mac: needHash ? flowUtil.hashMac(mac) : mac
                    }
                )
            }
        }
        return flows
    }

    getSize(flows) {
        if (flows == null || flows.length == 0) {
            return 0
        } else {
            return flows.map(flow => flow.flows.length).reduce((a,b) => a + b)
        }
    }

    async getFlows(mac, start, end) {
        let ips = await hostTool.getIPsByMac(mac);
        let flows = [];
        for (const ip of ips) {
            let outgoingFlows = await flowTool.queryFlows(ip, "in", start, end); // in => outgoing
            flows = flows.concat(outgoingFlows); // do not use Array.prototype.push.apply since it may cause maximum call stack size exceeded
            let incomingFlows = await flowTool.queryFlows(ip, "out", start, end); // out => incoming
            flows = flows.concat(incomingFlows); // do not use Array.prototype.push.apply since it may cause maximum call stack size exceeded
        }
        return flows
    }

    aggregateFlows(flows) {
        /**
         * input flows sample:  18 fields in each object
         * [
         *  {
         *     "ts":"", start time
         *     "_ts":"", end time
         *     "sh":"", source host
         *     "dh":"", destination host
         *     "lh":"", local host
         *     "sp":"", source port
         *     "dp":"", destination port, deprecated by pf?
         *     "af":{}, application flow
         *     "flows":[]  flow details
         *     "pf":{}, destination port flows
         *     "ob":"" total orig bytes
         *     "rb":"" total response bytes
         *     "ct":"" count
         *     "lo":"" location
         *     "pr":"" protocol, deprecated by pf?
         *     "du":"" duration,
         *     "fd":"" direction, in/out
         *  }
         *  {...}
         *  {...}
         * ]
         *
         *  aggregate by sh,dh,lh,fd, then copy "lo" at first level, and put the others to second nested array
         *
         *  output flows sample: 5 fields in first level, 13 fields in second level
         * [
         *  {
         *     "sh":"",
         *     "dh":"",
         *     "lh":"",
         *     "fd":"",
         *     "lo":"",
         *     "agg":[
         *       {
         *         "ts":"",
         *         "_ts":"",
         *         "sp":"",
         *         "dp":"",
         *         "af":{},
         *         "pf":{},
         *         "flows":[],
         *         "ob":"",
         *         "rb":"",
         *         "ct":"",
         *         "pr":"",
         *         "du":"",
         *       }
         *     ]
         *  },
         *  {...},
         *  {...}
         * ]
         * */

        let aggs = {}
        for(var i = 0; i < flows.length; i++) {
            let flow = flows[i]
            let key = flow.sh + "," + flow.dh + "," + flow.lh + "," + flow.fd
            if (aggs[key] == null) {
                aggs[key] = {
                    sh : flow.sh,
                    dh : flow.dh,
                    fd : flow.fd,
                    lh : flow.lh,
                    lo : flow.lo,
                    agg : []
                }
            }
            //merge other fields to agg
            let agg = {}
            let allFields = Object.keys(flow)
            allFields.forEach(function(f){
                if (f != 'sh' && f != 'dh' && f != 'lh' && f != 'lo' && f != 'fd') {
                    agg[f] = flow[f]
                }
            })
            aggs[key].agg.push(agg)
        }
        let result = Object.keys(aggs).map(k => aggs[k])
        log.debug("size before agg:" + flows.length + ", after agg:" + result.length)
        return result
    }

    cleanFlow(flow) {
        //remove key with empty value
        Object.keys(flow).forEach(k => {
            if (flow[k] == null) {
                delete flow[k]
            } else if (Array.isArray(flow[k]) && flow[k].length == 0) {
                delete flow[k]
            } else if (typeof flow[k] === 'object' && Object.keys(flow[k]).length == 0) {
                delete flow[k]
            }
        })
        return flow
    }

    enrichFlow(flow) {
        //add location
        flowTool._enrichCountryInfo(flow)
        flow.lo = flow.country
        delete flow.country
        return flow
    }

    processFlow(flows, needHash) {
        return this.aggregateFlows(flows.map(flow => {

            //enrich
            this.enrichFlow(flow)

            //clean
            this.cleanFlow(flow)

            //hash
            if (needHash) {
                return flowUtil.hashFlow(flow, true)
            } else {
                return flow
            }
        }))
    }
}

module.exports = FlowUploadSensor
