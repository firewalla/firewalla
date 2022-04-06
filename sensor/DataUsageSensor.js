/*    Copyright 2019-2021 Firewalla Inc.
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
const hostManager = new HostManager();
const util = require('util');
const getHitsAsync = util.promisify(timeSeries.getHits).bind(timeSeries);
const flowTool = require('../net2/FlowTool');
const Alarm = require('../alarm/Alarm.js');
const AlarmManager2 = require('../alarm/AlarmManager2.js');
const alarmManager2 = new AlarmManager2();
const abnormalBandwidthUsageFeatureName = 'abnormal_bandwidth_usage';
const dataPlanFeatureName = 'data_plan';
const dataPlanAlarm = 'data_plan_alarm';
const rclient = require('../util/redis_manager.js').getRedisClient();
const fc = require('../net2/config.js');
const dataPlanCooldown = fc.getTimingConfig("alarm.data_plan_alarm.cooldown") || 60 * 60 * 24 * 30;
const abnormalBandwidthUsageCooldown = fc.getTimingConfig("alarm.abnormal_bandwidth_usage.cooldown") || 60 * 60 * 4;
const suffixList = require('../vendor_lib/publicsuffixlist/suffixList');
const validator = require('validator');
const sysManager = require('../net2/SysManager.js');
const _ = require('lodash');
const CronJob = require('cron').CronJob;
const sem = require('./SensorEventManager.js').getInstance();
const extensionManager = require('../sensor/ExtensionManager.js')
const delay = require('../util/util.js').delay;
class DataUsageSensor extends Sensor {
    async run() {
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
        await this.monthlyDataUsageChecker();
    }
    async apiRun() {
        extensionManager.onGet("last12monthlyDataUsage", async (msg, data) => {
            return this.getLast12monthlyDataUsage();
        });
    }
    job() {
        fc.isFeatureOn(abnormalBandwidthUsageFeatureName) && this.checkDataUsage();
        // only check the monthly data usage when feature/alarm setting both enabled
        fc.isFeatureOn(dataPlanAlarm) && fc.isFeatureOn(dataPlanFeatureName) && this.checkMonthlyDataUsage();
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
        const mac = host.o.mac;
        const dedupKey = `abnormal:bandwidth:usage:${mac}`;
        if (await this.isDedup(dedupKey, abnormalBandwidthUsageCooldown)) return;
        //get top flows from begin to end
        const name = host.o.name || host.o.bname;
        const flows = await this.getSumFlows(mac, begin, end);
        const destNames = flows.map((flow) => flow.aggregationHost).join(',')
        percentage = percentage * 100;
        const last24HoursDownloadStats = await getHitsAsync(`download:${mac}`, "15minutes", this.slot * 24)
        const last24HoursUploadStats = await getHitsAsync(`upload:${mac}`, "15minutes", this.slot * 24)
        const recentlyDownloadStats = await getHitsAsync(`download:${mac}`, "15minutes", this.slot * this.smWindow)
        const recentlyUploadStats = await getHitsAsync(`upload:${mac}`, "15minutes", this.slot * this.smWindow)
        const last24HoursStats = {
            download: last24HoursDownloadStats,
            upload: last24HoursUploadStats
        }
        const recentlyStats = {
            download: recentlyDownloadStats,
            upload: recentlyUploadStats
        }
        let intfId = null;
        if (host.o.ipv4Addr) {
            const intf = sysManager.getInterfaceViaIP(host.o.ipv4Addr);
            intfId = intf && intf.uuid;
        }
        let alarm = new Alarm.AbnormalBandwidthUsageAlarm(new Date() / 1000, name, {
            "p.device.mac": mac,
            "p.device.id": name,
            "p.device.name": name,
            "p.device.ip": host.o.ipv4Addr,
            "p.intf.id": intfId,
            "p.totalUsage": totalUsage,
            "p.begin.ts": begin,
            "p.end.ts": end,
            "e.transfers": recentlyStats,
            "e.last24.transfers": last24HoursStats,
            "p.flows": JSON.stringify(flows),
            "p.dest.names": destNames,
            "p.duration": this.smWindow,
            "p.percentage": percentage.toFixed(2) + '%'
        });
        await alarmManager2.enqueueAlarm(alarm);
    }
    async getSumFlows(mac, begin, end) {
        const rawFlows = [].concat(await flowTool.queryFlows(mac, "out", begin, end), await flowTool.queryFlows(mac, "in", begin, end))
        let flows = [];
        for (const rawFlow of rawFlows) {
            flows.push({
                count: flowTool.getUploadTraffic(rawFlow) * 1 + flowTool.getDownloadTraffic(rawFlow) * 1,
                ip: flowTool.getDestIP(rawFlow),
                device: mac
            })
        }
        flows = await flowTool.enrichWithIntel(flows);
        let flowsCache = {};
        for (const flow of flows) {
            const destHost = (flow.host && validator.isFQDN(flow.host)) ? suffixList.getDomain(flow.host) : flow.ip;
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
        const dataPlan = await this.getDataPlan();
        if (!dataPlan) return;
        const { date, total } = dataPlan;
        const { totalDownload, totalUpload, monthlyBeginTs,
            monthlyEndTs, download, upload
        } = await hostManager.monthlyDataStats(null, date);
        let percentage = ((totalDownload + totalUpload) / total)
        if (percentage >= this.dataPlanMinPercentage) {
            //gen over data plan alarm
            let level = Math.floor(percentage * 10);
            level = level >= 10 ? 'over' : level;
            const dedupKey = `data:plan:${level}:${monthlyEndTs}`;
            if (await this.isDedup(dedupKey, dataPlanCooldown)) return;
            percentage = percentage * 100;
            let alarm = new Alarm.OverDataPlanUsageAlarm(new Date() / 1000, null, {
                "p.monthly.endts": monthlyEndTs,
                "p.monthly.startts": monthlyBeginTs,
                "p.percentage": percentage.toFixed(2) + '%',
                "p.totalUsage": totalDownload + totalUpload,
                "p.planUsage": total,
                "p.alarm.level": level,
                "e.transfers": {
                    download: download,
                    upload: upload
                }
            });
            await alarmManager2.enqueueAlarm(alarm);
        }
    }
    async isDedup(key, expiring) {
        const exists = await rclient.existsAsync(key);
        if (exists == 1) return true;
        else {
            await rclient.setAsync(key, 1);
            await rclient.expireatAsync(key, parseInt(new Date() / 1000) + expiring);
            return false;
        }
    }

    async getDataPlan() {
        let dataPlan = await rclient.getAsync('sys:data:plan');
        if (!dataPlan) return;
        dataPlan = JSON.parse(dataPlan);
        return dataPlan
    }

    async monthlyDataUsageChecker() {
        sem.on('DataPlan:Updated', async (event) => {
            const date = event && event.date;
            if (date) {
                await this.cleanMonthlyDataUsage();
                await this.generateLast12MonthDataUsage(date);
                this.cornJob && this.cornJob.stop();
                this.cornJob = new CronJob(`0 0 0 ${date} * *`, async () => {
                    await this.generateLast12MonthDataUsage(date);
                }, null, true)
            }
        });
        const dataPlan = await this.getDataPlan() || { date: 1 };
        const { date } = dataPlan;
        await this.generateLast12MonthDataUsage(date);
        this.cornJob = new CronJob(`0 0 0 ${date} * *`, async () => {
            await this.generateLast12MonthDataUsage(date);
        }, null, true)
    }

    async generateLast12MonthDataUsage(planDay) {
        await rclient.set('monthly:data:usage:ready', '0');
        const lastTs = await rclient.getAsync('monthly:data:usage:lastTs');
        log.info(`Going to generate monthly data usage, plan day ${planDay}, lastTs ${lastTs}`);
        const now = new Date();
        const days = now.getDate(), month = now.getMonth(),
            year = now.getFullYear();
        const today = new Date(year, month, days);
        const records = [];
        const oneDay = 24 * 60 * 60 * 1000;
        const downloadKey = `download`;
        const uploadKey = `upload`;
        const slots = 12;
        const offset = days >= planDay ? 0 : 1;
        for (let i = 0; i < slots; i++) {
            let recordTs;
            const m = month - i - offset;
            if (m < 0) {
                recordTs = new Date(year - 1, m + 12, planDay);
            } else {
                recordTs = new Date(year, m, planDay);
            }
            if (recordTs <= lastTs * 1000) break;
            const offsetDays = Math.floor((today - recordTs) / oneDay) + hostManager.offsetSlot();
            const download = await getHitsAsync(downloadKey, '1day', offsetDays) || [];
            const upload = await getHitsAsync(uploadKey, '1day', offsetDays) || [];
            if (i == 0) {
                const stats = this.getStats({ download, upload }, offsetDays);
                records.push({ ts: recordTs / 1000, stats: stats })
            } else {
                // minus the dedup count
                const monthlyDays = (records[i - 1].ts * 1000 - recordTs) / oneDay;
                const stats = this.getStats({ download, upload }, monthlyDays);
                records.push({ ts: recordTs / 1000, stats: stats })
            }
        }
        records.shift();
        await this.dumpToRedis(records);
    }


    async cleanMonthlyDataUsage() {
        try {
            const keys = await rclient.scanResults("monthly:data:usage:*");
            const multi = rclient.multi();
            for (const key of keys) {
                multi.del(key);
            }
            await multi.execAsync();
        } catch (e) {
            log.error("Clean monthly data usage error", e);
        }
    }

    async dumpToRedis(records) {
        // monthly:data:usage:ts
        // monthly:data:usage:lastTs
        try {
            const multi = rclient.multi();
            const expiring = 60 * 60 * 24 * 365; // one year
            for (const record of records) {
                const key = `monthly:data:usage:${record.ts}`;
                multi.set(key, JSON.stringify(record));
                multi.expireat(key, record.ts + expiring);
            }
            multi.set('monthly:data:usage:lastTs', records[0].ts);
            multi.set('monthly:data:usage:ready', 1);
            await multi.execAsync();
        } catch (e) {
            log.error("Dump monthly data usage to redis error", e, records);
            await this.cleanMonthlyDataUsage(); // clean the legacy data
        }
    }
    getStats(stats, days) {
        for (const metric in stats) {
            stats[metric] = stats[metric].slice(0, days)
        }
        return hostManager.generateStats(stats)
    }

    async monthlyDataReady() {
        const ready = (await rclient.get('monthly:data:usage:ready')) == "1";
        return ready;
    }
    async getLast12monthlyDataUsage() {
        let count = 0, timeout = 10; // 10s
        if (!await this.monthlyDataReady() && count < timeout) {
            log.info("Waiting for monthly data usage data ready");
            await delay(1 * 1000);
            count++;
        }
        if (count == timeout) {
            log.error("getLast12monthlyDataUsage timeout");
            return [];
        }
        const keys = await rclient.scanResults("monthly:data:usage:*");
        let records = [];
        for (const key of keys) {
            if (key == "monthly:data:usage:lastTs" || key == "monthly:data:usage:ready") continue;
            try {
                const record = await rclient.getAsync(key);
                records.push(JSON.parse(record));
            } catch (e) {
                log.warn(`Get ${key} error`, e)
            }
        }
        records.sort((a, b) => a.ts > b.ts ? 1 : -1);
        return records;
    }
}

module.exports = DataUsageSensor;
