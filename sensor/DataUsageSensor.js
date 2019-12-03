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
const FlowAggrTool = require('../net2/FlowAggrTool');
const flowAggrTool = new FlowAggrTool();
const FlowTool = require('../net2/FlowTool');
const flowTool = new FlowTool();
const Alarm = require('../alarm/Alarm.js');
const AlarmManager2 = require('../alarm/AlarmManager2.js');
const alarmManager2 = new AlarmManager2();
const abnormalBandwidthUsageFeatureName = 'abnormal_bandwidth_usage';
const dataPlanFeatureName = 'data_plan';
const rclient = require('../util/redis_manager.js').getRedisClient();
const fc = require('../net2/config.js');
class DataUsageSensor extends Sensor {
    constructor() {
        super();
    }
    run() {
        this.refreshInterval = (this.config.refreshInterval || 15) * 60 * 1000;
        this.ratio = this.config.ratio || 1.2;
        this.analytics_hours = this.config.analytics_hours || 8;
        this.percentage = this.config.percentage || 0.8;
        this.topXflows = this.config.topXflows || 10;
        this.minsize = this.config.minsize || 150 * 1000 * 1000;
        this.smWindow = this.config.smWindow || 2;
        this.mdWindow = this.config.mdWindow || 8;
        this.dataPlanMinPercentage = this.config.dataPlanMinPercentage || 0.8;
        this.slot = 4// 1hour 4 slots
        this.hookFeature();
    }
    job() {
        fc.isFeatureOn(abnormalBandwidthUsageFeatureName) && this.checkDataUsage()
        fc.isFeatureOn(dataPlanFeatureName) && this.checkMonthlyDataUsage()
    }
    globalOn() {
    }

    globalOff() {
    }
    async checkDataUsage() {
        log.info("Start check data usage")
        let hosts = await hostManager.getHostsAsync();
        const systemDataUsage = await this.getTimewindowDataUsage(0, '');
        const systemRecentlyTotalUsage = this.getRecentlyDataUsage(systemDataUsage, this.smWindow * this.slot)
        hosts = hosts.filter(x => x)
        for (const host of hosts) {
            const mac = host.o.mac;
            const dataUsage = await this.getTimewindowDataUsage(0, mac);
            const dataUsageSmHourWindow = await this.getTimewindowDataUsage(this.smWindow, mac);
            const dataUsageMdHourWindow = await this.getTimewindowDataUsage(this.mdWindow, mac);
            const hostRecentlyTotalUsage = this.getRecentlyDataUsage(dataUsage, this.smWindow * this.slot)
            const hostDataUsagePercentage = hostRecentlyTotalUsage / systemRecentlyTotalUsage || 0;
            const end = dataUsage[dataUsage.length - 1].ts;
            const begin = end - this.smWindow * 60 * 60;
            const steps = this.smWindow * this.slot;
            const length = dataUsageSmHourWindow.length;
            if (hostRecentlyTotalUsage < steps * this.minsize || hostDataUsagePercentage < this.percentage) continue;
            for (let i = 1; i <= steps; i++) {
                const smUsage = dataUsageSmHourWindow[length - i].count,
                    mdUsage = dataUsageMdHourWindow[length - i].count;
                if (smUsage > this.minsize && mdUsage > this.minsize && smUsage > mdUsage) {
                    const ratio = smUsage / mdUsage;
                    if (ratio > this.ratio) {
                        this.genAbnormalBandwidthUsageAlarm(host, begin, end, hostRecentlyTotalUsage, dataUsage, hostDataUsagePercentage);
                        break;
                    }
                }
            }
        }
    }
    async getTimewindowDataUsage(timeWindow, mac) {
        const downloadKey = `download${mac ? ':' + mac : ''}`;
        const uploadKey = `upload${mac ? ':' + mac : ''}`;
        //[[ts,Bytes]]  [[1574325720, 9396810],[ 1574325780, 3141018 ]]
        const slot = this.slot;
        const slots = slot * timeWindow || 1;
        const sumSlots = (slots + 1) * (slots / 2);
        const analytics_slots = slot * this.analytics_hours + slots
        const downloadStats = await getHitsAsync(downloadKey, "15minutes", analytics_slots);
        const uploadStats = await getHitsAsync(uploadKey, "15minutes", analytics_slots);
        let dataUsageTimeWindow = [];
        if (downloadStats.length < slots) return;
        for (let i = slots; i < downloadStats.length; i++) {
            let temp = {
                count: 0,
                ts: downloadStats[i][0]
            };
            for (let j = i - slots + 1; j <= i; j++) {
                const weight = (slots - (i - j)) / sumSlots;
                temp.count = temp.count * 1 + (downloadStats[j][1] * 1 + uploadStats[j][1] * 1) * weight;
            }
            dataUsageTimeWindow.push(temp);
        }
        return dataUsageTimeWindow
    }
    getRecentlyDataUsage(data, steps) {
        const length = data.length;
        let total = 0;
        for (let i = 1; i <= steps; i++) {
            if (data[length - i] && data[length - i].count) {
                total = total * 1 + data[length - i].count * 1;
            }
        }
        return total;
    }
    async genAbnormalBandwidthUsageAlarm(host, begin, end, totalUsage, dataUsage, percentage) {
        log.info("genAbnormalBandwidthUsageAlarm", host.o.mac, begin, end)
        //get top flows from begin to end
        const mac = host.o.mac;
        const name = host.o.name || host.o.bname;
        const flows = await this.getSumFlows(mac, begin, end);
        const destNames = flows.map((flow) => flow.aggregationHost).join(',')
        percentage = percentage * 100;
        let alarm = new Alarm.AbnormalBandwidthUsageAlarm(new Date() / 1000, name, {
            "p.device.mac": mac,
            "p.device.id": name,
            "p.device.name": name,
            "p.device.ip": host.o.ipv4Addr,
            "p.totalUsage": totalUsage,
            "p.begin.ts": begin,
            "p.end.ts": end,
            "e.transfers": dataUsage,
            "p.flows": JSON.stringify(flows),
            "p.dest.names": destNames,
            "p.duration": this.smWindow,
            "p.percentage": percentage.toFixed(2) + '%'
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
        log.info("Start check monthly data usage")
        let dataPlan = await rclient.getAsync('sys:data:plan');
        if (!dataPlan) return;
        dataPlan = JSON.parse(dataPlan);
        const { date, total } = dataPlan;
        const { totalDownload, totalUpload, monthlyBeginTs, monthlyEndTs } = await hostManager.monthlyDataStats(null, date);
        let percentage = ((totalDownload + totalUpload) / total)
        if (percentage >= this.dataPlanMinPercentage) {
            //gen over data plan alarm
            const level = Math.floor(percentage * 10);
            percentage = percentage * 100;
            let alarm = new Alarm.OverDataPlanUsageAlarm(new Date() / 1000, null, {
                "p.monthly.endts": monthlyEndTs,
                "p.percentage": percentage.toFixed(2) + '%',
                "p.totalUsage": totalDownload + totalUpload,
                "p.planUsage": total,
                "p.alarm.level": level >= 10 ? 'over' : level
            });
            await alarmManager2.enqueueAlarm(alarm);
        }
    }
}

module.exports = DataUsageSensor;
