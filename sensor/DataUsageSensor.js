/*    Copyright 2019 Firewalla INC 
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
const featureName = 'large_download';
class DataUsageSensor extends Sensor {
    constructor() {
        super();
    }
    run() {
        //todo add policy for per device data usage monitor or system
        this.refreshInterval = (this.config.refreshInterval || 15) * 60 * 1000;
        this.timewindow = this.config.timewindow || 2;
        this.stddev_limit = this.config.stddev_limit || 0.2;
        this.analytics_hours = this.config.analytics_hours || 24;
        this.topXflows = this.config.topXflows || 2;
        this.minsize_download = this.config.minsize_download || 500 * 1000 * 1000;
        this.hookFeature(featureName);
    }
    job() {
        this.checkDataUsage()
        this.checkMonthlyDataUsage()
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
            const downloadKey = `download${mac ? ':' + mac : ''}`;
            const uploadKey = `upload${mac ? ':' + mac : ''}`;
            //[[ts,Bytes]]  [[1574325720, 9396810],[ 1574325780, 3141018 ]]
            const slot = 4;// 1hour 4 slots
            const slots = slot * this.timewindow;
            const downloadStats = await getHitsAsync(downloadKey, "15minutes", slot * this.analytics_hours);//get passed 24 hours dowload stats
            const uploadStats = await getHitsAsync(uploadKey, "15minutes", slot * this.analytics_hours);
            let dataUsageRatio = [], totalUsage = 0;
            if (downloadStats.length < slots) return;
            downloadStats.forEach((item, index) => {
                totalUsage = totalUsage * 1 + item[1] * 1 + uploadStats[index][1] * 1;
            })
            if (totalUsage < this.minsize_download) continue;
            for (let i = slots; i < downloadStats.length; i++) {
                let temp = 0;
                for (let j = i - slots; j < i; j++) {
                    temp = temp * 1 + downloadStats[j][1] * 1 + uploadStats[j][1] * 1;
                }
                temp = temp / totalUsage;
                dataUsageRatio.push(temp);
            }
            if (dataUsageRatio.length > 0) {
                const dataStddev = stats.stdev(dataUsageRatio);
                log.info("dataStddev", dataStddev, host.o.mac);
                if (dataStddev > this.stddev_limit &&
                    dataUsageRatio[dataUsageRatio.length - 1] > dataUsageRatio[dataUsageRatio.length - 2]) {
                    this.genAbnormalDownloadAlarm(host, downloadStats[0][0], downloadStats[downloadStats.length - 1][0], totalUsage, downloadStats, uploadStats);
                }
            }
        }
    }
    async genAbnormalDownloadAlarm(host, begin, end, totalUsage, downloadStats, uploadStats) {
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
            "e.download.transfers": downloadStats,
            "e.upload.transfers": uploadStats,
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
            const sumDownloadFlowKey = flowAggrTool.getSumFlowKey(mac, 'download', begin, begin + period);
            const downloadTraffics = await flowAggrTool.getTopSumFlowByKey(sumDownloadFlowKey, 10);//get top 10 flows
            const sumUploadFlowKey = flowAggrTool.getSumFlowKey(mac, 'upload', begin, begin + period);
            const uploadTraffics = await flowAggrTool.getTopSumFlowByKey(sumUploadFlowKey, 10);
            flows = flows.concat(downloadTraffics).concat(uploadTraffics);
            begin = begin + period;
        }
        flows = await flowTool.enrichWithIntel(flows);
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
            return flow.count * 1 > 10 * 1000 * 1000;//return flows bigger than 10MB
        })
    }
    async checkMonthlyDataUsage() {
        //data plan 1TB,10TB, etc..
        //monthly? 11.01-11.30 or 11.05 - 12.05
        const dataPlan = '';
        const { totalDownload, totalUpload } = await hostManager.monthlyDataStats();
        if (totalDownload + totalUpload > dataPlan) {
            //gen over data plan alarm
        }
    }
}

module.exports = DataUsageSensor;
