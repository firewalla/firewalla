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
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();

const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const Message = require('../net2/Message.js');
const moment = require('moment-timezone/moment-timezone.js');
moment.tz.load(require('../vendor_lib/moment-tz-data.json'));
const Constants = require('../net2/Constants.js');

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
        this.planJobs = {};
        sclient.on("message", async (channel, message) => {
          if (channel === Message.MSG_SYS_TIMEZONE_RELOADED) {
            log.info(`System timezone is reloaded, will reload data usage statistics and jobs ...`, message);
            await this.reloadDataUsageAndJobs(true);
          }
        });
        sclient.subscribe(Message.MSG_SYS_TIMEZONE_RELOADED);

        sem.on('DataPlan:Updated', async (event) => {
          log.info("Data plan is updated, will reload data usage statistics and jobs ...")
          await this.reloadDataUsageAndJobs(true);
        });

        sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, async () => {
          await this.reloadDataUsageAndJobs(false); // no need to flush generated data usage statistics in case of network change
        });

        await this.reloadDataUsageAndJobs(true); // always regenerate data usage statistics during startup to ensure consistency in case of implementation change
    }

    async apiRun() {
        extensionManager.onGet("last12monthlyDataUsage", async (msg, data) => {
            const dataPlan = await this.getDataPlan();
            const date = dataPlan && dataPlan.date || 1;
            return this.getLast12monthlyDataUsage(date);
        });

        extensionManager.onGet("last12monthlyDataUsageOnWans", async (msg, data) => {
            const dataPlan = await this.getDataPlan();
            const globalDate = dataPlan && dataPlan.date || 1;
            const wanConfs = dataPlan && dataPlan.wanConfs || {};
            const wanIntfs = sysManager.getWanInterfaces();
            const result = {};
            for (const wanIntf of wanIntfs) {
              const uuid = wanIntf.uuid;
              const date = wanConfs[uuid] && wanConfs[uuid].date || globalDate;
              const data = await this.getLast12monthlyDataUsage(date, uuid);
              result[uuid] = data;
            }
            return result;
        });

        extensionManager.onGet("monthlyUsageStats", async (msg, data) => {
          const dataPlan = await this.getDataPlan();
          const globalDate = dataPlan && dataPlan.date || 1;
          const globalTotal = dataPlan && dataPlan.total || null;
          const wanConfs = dataPlan && dataPlan.wanConfs || {};
          const wanIntfs = sysManager.getWanInterfaces();
          const { totalDownload, totalUpload } = await hostManager.monthlyDataStats(null, globalDate);
          const wanStats = {};
          for (const wanIntf of wanIntfs) {
            const uuid = wanIntf.uuid;
            const date = wanConfs[uuid] && wanConfs[uuid].date || globalDate;
            const { totalDownload, totalUpload } = await hostManager.monthlyDataStats(`wan:${uuid}`, date);
            const total = wanConfs[uuid] && wanConfs[uuid].total || globalTotal;
            wanStats[uuid] = {used: totalDownload + totalUpload, total};
          }
          const result = {used: totalDownload + totalUpload, total: globalTotal, wanStats};
          return result;
        });
    }
    async job() {
        fc.isFeatureOn(abnormalBandwidthUsageFeatureName) && this.checkDataUsage();
        // only check the monthly data usage when feature/alarm setting both enabled
        if (fc.isFeatureOn(dataPlanAlarm) && fc.isFeatureOn(dataPlanFeatureName)) {
          const dataPlan = await this.getDataPlan();
          if (!dataPlan)
            return;
          const {date, total, wanConfs} = dataPlan;
          if (date && total) {
            await this.checkMonthlyDataUsage(date, total);
          }
          const wanIntfs = sysManager.getWanInterfaces();
          for (const wanIntf of wanIntfs) {
            if (wanConfs && _.isObject(wanConfs[wanIntf.uuid])) {
              const {date, total} = wanConfs[wanIntf.uuid];
              if (date && total) {
                await this.checkMonthlyDataUsage(date, total, wanIntf.uuid);
              }
            }
          }
        }
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

                        // getHits return begin time as ts for the bucket from begin-end. 
                        // e.g. 11:00:00 - 11:30:00
                        // it will return two buckets(15mins as one bucket) with ts 11:00:00 and 11:15:00
                        // the begin time is 11:00:00 and the end time should be 11:15:00 + 15 mins

                        this.genAbnormalBandwidthUsageAlarm(host, begin, end + 15 * 60, hostRecentlyTotalUsage, hostDataUsagePercentage);
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
    async genAbnormalBandwidthUsageAlarm(host, begin, end, totalUsage, percentage) {
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
            "p.percentage": percentage.toFixed(2) + '%',
        });

        for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
          const config = Constants.TAG_TYPE_MAP[type];
          alarm[config.alarmIdKey] = await host.getTags(type) || [];
        }
        alarmManager2.enqueueAlarm(alarm);
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
    async checkMonthlyDataUsage(date, total, wanUUID) {
        log.info(`Start check monthly data usage ${wanUUID ? `on wan ${wanUUID}` : ""}`);
        const { totalDownload, totalUpload, monthlyBeginTs,
            monthlyEndTs, download, upload
        } = await hostManager.monthlyDataStats(wanUUID ? `wan:${wanUUID}` : null, date);
        log.debug(`download: ${totalDownload}, upload: ${totalUpload}, plan total: ${total}`);
        let percentage = ((totalDownload + totalUpload) / total)
        if (percentage >= this.dataPlanMinPercentage) {
            //gen over data plan alarm
            let level = Math.floor(percentage * 10);
            level = level >= 10 ? 'over' : level;
            const dedupKey = `data:plan:${wanUUID ? `${wanUUID}:` : ""}${level}:${total}:${monthlyEndTs}`;
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
            if (wanUUID)
              alarm["p.wan.uuid"] = wanUUID;
            alarmManager2.enqueueAlarm(alarm);
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

    async reloadDataUsageAndJobs(clean = false) {
      await lock.acquire("LOCK_RELOAD_DATA_USAGE", async () => {
        const dataPlan = await this.getDataPlan();
        const timezone = sysManager.getTimezone();
        const globalDate = dataPlan && dataPlan.date || 1;
        const wanConfs = dataPlan && dataPlan.wanConfs || {};
        const wanIntfs = sysManager.getWanInterfaces();

        if (clean) {
          await this.unsetMonthlyDataReady();
        }

        // this happens if the function is called for the first time, so create dummy planJobs to ensure cleanup will work
        if (_.isEmpty(this.planJobs)) {
          this.planJobs["global"] = { date: globalDate };
          for (const wanIntf of wanIntfs) {
            this.planJobs[wanIntf.uuid] = { date : wanConfs[wanIntf.uuid] && wanConfs[wanIntf.uuid].date || globalDate };
          }
        }

        for (const uuid of Object.keys(this.planJobs)) {
          const planJob = this.planJobs[uuid];
          planJob.job && planJob.job.stop();
          log.info(`Stop previous data usage generation job on ${uuid}, plan day ${planJob.date}`);
          if (clean) {
            await this.cleanMonthlyDataUsage(planJob.date || globalDate, uuid == "global" ? null : uuid);
          }
        }
        this.planJobs = {};

        // always incrementally calculate the data usage every day, this can ensure the monthly data is updated in case the plan day does not exist in some months
        this.planJobs["global"] = {
          date: globalDate,
          job: new CronJob(`0 0 * * *`, async () => {
            await this.generateLast12MonthDataUsage(globalDate);
          }, null, true, timezone)
        };
        log.info(`Schedule global data usage generation job, plan day ${globalDate}`);
        await this.generateLast12MonthDataUsage(globalDate);

        
        // calculate per-WAN data usage
        for (const wanIntf of wanIntfs) {
          const wanUUID = wanIntf.uuid;
          const date = wanConfs[wanUUID] && wanConfs[wanUUID].date || globalDate;
          this.planJobs[wanUUID] = {
            date: date,
            job: new CronJob(`0 0 * * *`, async () => {
              await this.generateLast12MonthDataUsage(date, wanUUID);
            }, null, true, timezone)
          };
          log.info(`Schedule data usage generation job on wan ${wanUUID}, plan day ${date}`);
          await this.generateLast12MonthDataUsage(date, wanUUID);
        }
        await this.setMonthlyDataReady();
      }).catch((err) => {
        log.error(`Failed to reload data usage and jobs`, err.message);
      });
    }

    async generateLast12MonthDataUsage(planDay, wanUUID) {
        const lastTs = await rclient.getAsync(`monthly:${wanUUID ? "wan:" : ""}data:usage:${wanUUID ? `${wanUUID}:` : ""}lastTs`);
        log.info(`Going to generate monthly data usage, plan day ${planDay}, lastTs ${lastTs}, ${wanUUID ? `wanUUID ${wanUUID}` : ""}`);
        const periodTsList = this.getPeriodTsList(planDay, 12); // in descending order
        const timezone = sysManager.getTimezone();
        const now = timezone ? moment().tz(timezone) : moment();
        const totalDays = Math.floor((now.unix() - periodTsList.slice(-1)) / 86400) + 1;
        const downloadKey = `download`;
        const uploadKey = `upload`;

        const download = await getHitsAsync(`${downloadKey}${wanUUID ? `:wan:${wanUUID}` : ""}`, "1day", totalDays);
        const upload = await getHitsAsync(`${uploadKey}${wanUUID ? `:wan:${wanUUID}` : ""}`, "1day", totalDays);
        let endIndex = -2;
        const records = [];
        for (const ts of periodTsList) {
          if (ts <= lastTs)
            break;
          const beginIndex = download.length - Math.floor((now.unix() - ts) / 86400) - 1;
          const stats = hostManager.generateStats({ download: download.slice(beginIndex, endIndex), upload: upload.slice(beginIndex, endIndex) });
          records.push({ts, stats});
          endIndex = beginIndex;
        }
        records.shift();
        await this.dumpToRedis(records, wanUUID);
        records.length > 0 && await rclient.setAsync(`monthly:${wanUUID ? "wan:" : ""}data:usage:${wanUUID ? `${wanUUID}:` : ""}lastTs`, records[0].ts);
    }

    getPeriodTsList(planDay, months = 12) {
      const timezone = sysManager.getTimezone();
      const now = (timezone ? moment().tz(timezone) : moment());
      let nextOccurrence = (now.get("date") >= planDay ? moment(now).add(1, "months") : moment(now)).endOf("month").startOf("day");
      while (nextOccurrence.get("date") !== planDay) {
        if (nextOccurrence.get("date") >= planDay)
          nextOccurrence.subtract(nextOccurrence.get("date") - planDay, "days");
        else
          nextOccurrence.add(1, "months").endOf("month").startOf("day");
      }
      let diffMonths = 0;
      while (moment(nextOccurrence).subtract(diffMonths, "months").unix() > now.unix())
        diffMonths++;
  
      const result = [];
      for (let i = 0; i <= months - 1; i++) {
        const ts = moment(nextOccurrence).subtract(i + diffMonths, "months").unix(); // begin moment of each cycle
        result.push(ts);
      }
      return result;
    }

    async cleanMonthlyDataUsage(planDay, wanUUID) {
        try {
            const periodTsList = this.getPeriodTsList(planDay);
            const multi = rclient.multi();
            for (const ts of periodTsList) {
              // per-wan data usage also uses monthly:data:usage prefix at the first wave of 1.978 alpha
              // need to remove keys of both prefixes to guarantee backward compatibility with 1.977
              // 1.977 uses redis scan for keys starting with monthly:data:usage in getLast12monthlyDataUsage
              multi.del(`monthly:${wanUUID ? "wan:" : ""}data:usage:${wanUUID ? `${wanUUID}:` : ""}${ts}`);
              multi.del(`monthly:data:usage:${wanUUID ? `${wanUUID}:` : ""}${ts}`);
            }
            multi.del(`monthly:${wanUUID ? "wan:" : ""}data:usage:${wanUUID ? `${wanUUID}:` : ""}lastTs`);
            multi.del(`monthly:data:usage:${wanUUID ? `${wanUUID}:` : ""}${ts}`);
            await multi.execAsync();
        } catch (e) {
            log.error("Clean monthly data usage error", e);
        }
    }

    async dumpToRedis(records, wanUUID) {
      const multi = rclient.multi();
      const expiring = 60 * 60 * 24 * 365; // one year
      for (const record of records) {
        // 1.977 uses redis scan for keys starting with monthly:data:usage in getLast12monthlyDataUsage
        // so need to use a different key prefix pattern for per-wan data usage
        const key = `monthly:${wanUUID ? "wan:" : ""}data:usage:${wanUUID ? `${wanUUID}:` : ""}${record.ts}`;
        multi.set(key, JSON.stringify(record));
        multi.expireat(key, record.ts + expiring);
      }
      await multi.execAsync();
    }

    async unsetMonthlyDataReady() {
      await rclient.unlinkAsync('monthly:data:usage:ready');
    }

    async setMonthlyDataReady() {
      await rclient.setAsync('monthly:data:usage:ready', 1);
    }

    async isMonthlyDataReady() {
        const ready = await rclient.getAsync('monthly:data:usage:ready');
        return ready == "1";
    }

    async getLast12monthlyDataUsage(planDay, wanUUID) {
        let count = 0, timeout = 10; // 10s
        while (!await this.isMonthlyDataReady() && count < timeout) {
            log.info("Waiting for monthly data usage data ready");
            await delay(1 * 1000);
            count++;
        }
        if (count == timeout) {
            log.error("getLast12monthlyDataUsage timeout, wanUUID: ", wanUUID);
            return [];
        }
        let periodTsList = this.getPeriodTsList(planDay); // in descending order
        periodTsList.shift(); // remove current cycle
        const records = [];
        for (const ts of periodTsList) {
          const record = await rclient.getAsync(`monthly:${wanUUID ? "wan:" : ""}data:usage:${wanUUID ? `${wanUUID}:` : ""}${ts}`);
          record && records.push(JSON.parse(record));
        }
        return records.reverse();
    }
}

module.exports = DataUsageSensor;
