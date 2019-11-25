/*    Copyright 2019 Firewalla LLC 
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
const timeSeries = require('../util/TimeSeries.js').getTimeSeries()
const HostManager = require("../net2/HostManager.js");
const hostManager = new HostManager("cli", 'client', 'info');
const util = require('util');
const getHitsAsync = util.promisify(timeSeries.getHits).bind(timeSeries);
const stats = require('stats-lite');
const FlowAggrTool = require('../net2/FlowAggrTool');
const flowAggrTool = new FlowAggrTool();
const FlowTool = require('../net2/FlowTool');
const flowTool = new FlowTool();
const Alarm = require('../alarm/Alarm.js');
const AlarmManager2 = require('../alarm/AlarmManager2.js');
const alarmManager2 = new AlarmManager2();
class DataUsageSensor extends Sensor {
    constructor() {
        super();
    }
    run() {
        //todo add policy for per device data usage monitor or system
        //todo use hook after Melvin merged
        //also check feature on/off
        this.interval = this.config.interval || 60 * 15; // interval default to 15 mintues
        this.stddev_limit = this.config.stddev_limit || 200;
        this.analytics_hours = this.config.analytics_hours || 8;
        this.topXflows = this.config.topXflows || 2;
        this.minsize_download = this.config.minsize_download || 10 * 1000 * 1000;
        this.job();
        setInterval(() => {
            this.job();
        }, this.interval * 1000);
    }
    job() {
        this.checkDataUsage()
    }
    globalOn() {
    }

    globalOff() {
    }
    async checkDataUsage() {
        log.info("Start check data usage")
        let hosts = await hostManager.getHostsAsync();
        hosts = hosts.filter(x => x)
        for (const host of hosts) {
            const mac = host.o.mac;
            const key = `download${mac ? ':' + mac : ''}`;
            //[[ts,Bytes]]  [[1574325720, 9396810],[ 1574325780, 3141018 ]]
            const downloadStats = await getHitsAsync(key, "15minutes", 4 * this.analytics_hours);//get passed 8 hours dowload stats
            let downloadData = [], totalUsage = 0;
            downloadStats.forEach((item) => {
                totalUsage = totalUsage * 1 + item[1] * 1;
                downloadData.push(item[1]);
            })
            if (downloadData.length > 0) {
                const dataStddev = Math.round(stats.stdev(downloadData) / 1000 / 1000);
                if (dataStddev > this.stddev_limit) {
                    this.genAbnormalDownloadAlarm(host, downloadStats[0][0], downloadStats[downloadStats.length - 1][0], totalUsage, downloadStats);
                }
            }
        }
    }
    async genAbnormalDownloadAlarm(host, begin, end, totalUsage, downloadStats) {
        log.info("genAbnormalDownloadAlarm", host.o, begin, end)
        //get top flows from begin to end
        const mac = host.o.mac;
        const name = host.o.name || host.o.bname;
        const flows = await this.getSumFlows(mac, begin, end);
        const destNames = flows.map((flow) => flow.aggregationHost).join(',')
        let alarm = new Alarm.AbnormalDownloadAlarm(new Date() / 1000, name, {
            "p.device.mac": mac,
            "p.device.id": name,
            "p.device.name": name,
            "p.device.ip": host.o.ipv4Addr,
            "p.download": totalUsage,
            "p.begin.ts": begin,
            "p.end.ts": end,
            "p.transfers": downloadStats,
            "p.flows": JSON.stringify(flows),
            "p.dest.names": destNames
        });
        await alarmManager2.enqueueAlarm(alarm);
    }
    async getSumFlows(mac, begin, end) {
        // hourly sum
        const period = 60 * 60;
        begin = begin - begin % period;
        end = end - end % period + period;
        let flows = [];
        while (begin < end) {
            const sumFlowKey = flowAggrTool.getSumFlowKey(mac, 'download', begin, begin + period);
            const traffics = await flowAggrTool.getTopSumFlowByKey(sumFlowKey, 10);//get top 10 flows
            flows = flows.concat(traffics);
            begin = begin + period;
        }
        let enrichedFlows = await flowTool.enrichWithIntel(flows);
        let flowsCache = {};
        for (const flow of flows) {
            const destHost = flow.host ? flow.host.split('.').slice(-2).join('.') : flow.ip;
            if (flowsCache[destHost]) {
                flowsCache[destHost].count = flowsCache[destHost].count * 1 + flow.count * 1;
            } else {
                flowsCache[destHost] = flow
            }
        }
        let flowsGroupByDestHost = [];
        for (const destHost in flowsCache) {
            flowsCache[destHost].aggregationHost = destHost;
            flowsGroupByDestHost.push(flowsCache[destHost]);
        }
        return flowsGroupByDestHost.sort((a, b) => b.count * 1 - a.count * 1).splice(0, this.topXflows).filter((flow) => {
            return flow.count * 1 > this.minsize_download * 1;
        })
    }
}

module.exports = DataUsageSensor;
