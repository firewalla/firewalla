/*    Copyright 2019-2024 Firewalla Inc.
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
const Identity = require('../net2/Identity.js')
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
          const {date, total, wanConfs, enable} = dataPlan;
          if (enable) { // "enable" on global level won't be set in normal cases, so global level alarm won't be generated
            await this.checkMonthlyDataUsage(date, total);
          }
          const wanIntfs = sysManager.getWanInterfaces();
          for (const wanIntf of wanIntfs) {
            const wanConf = _.get(wanConfs, wanIntf.uuid, {date, total, enable: true}); // if wan uuid is not defined in wanConfs, enable bandwidth usage alarm on that WAN by default
            if (wanConf.enable) {
              await this.checkMonthlyDataUsage(wanConf.date || date, wanConf.total || total, wanIntf.uuid);
            }
          }
        }
    }
    globalOn() {
    }

    globalOff() {
    }

    async checkDataUsage() {
      try {
        log.info("Start check data usage")
        // hosts are probably not created on initial run but that should be fine, we just skip it
        const hosts = hostManager.getAllMonitorables()
        const systemTotal = (await this.getDataUsage15min(this.smWindow * 4, '')).count

        for (const host of hosts) {
          const mac = host.getGUID()
          const hostTotal = (await this.getDataUsage15min(this.smWindow * 4, mac)).count
          const hostTotalPct = systemTotal ? hostTotal / systemTotal : 0;
          log.verbose('host total', mac, hostTotal, systemTotal)
          if (hostTotal < this.smWindow * 4 * this.minsize ||
            // vpn client generates double banwidth on WAN
            hostTotalPct < (host instanceof Identity ? this.percentage / 2 : this.percentage)
          ) continue;

          // 2 sliding windows with differet window size to get weighted moving average here
          // https://en.wikipedia.org/wiki/Moving_average#Weighted_moving_average
          const weightedSm = await this.getDataUsage15min(this.smWindow * 4, mac, true);
          const weightedMd = await this.getDataUsage15min(this.mdWindow * 4, mac, true);
          if (!weightedSm || !weightedMd) continue
          const { begin, end } = weightedSm
          const smUsage = weightedSm.count,
                mdUsage = weightedMd.count;

          log.verbose('weighted average', begin, end, mac, smUsage, mdUsage)

          // weighted average over last [mdWindow] hours is greater than [minsize]
          // and it's increasing at [ratio] over last [smWindow] hours
          if (smUsage > mdUsage && mdUsage > this.minsize && smUsage / mdUsage > this.ratio) {

            // getHits return begin time as ts for the bucket from begin-end. 
            // e.g. 11:00:00 - 11:30:00
            // it will return two buckets(15mins as one bucket) with ts 11:00:00 and 11:15:00
            // the begin time is 11:00:00 and the end time should be 11:15:00 + 15 mins

            this.genAbnormalBandwidthUsageAlarm(host, begin, end + 15 * 60, hostTotal, hostTotalPct);
            break;
          }
        }
      } catch(err) {
        log.error('Error checking device bandwidth', err)
      }
    }

    // return sum or weighted average of latest n slots
    // weights being linear: 1/sumSlots, 2/sumSlots, ... slots/sumSlots
    async getDataUsage15min(slots, mac, weightedAverage = false) {
        const downloadKey = `download${mac ? ':' + mac : ''}`;
        const uploadKey = `upload${mac ? ':' + mac : ''}`;
        // latest solt is under accumulation, skip that
        const downloads = await getHitsAsync(downloadKey, "15minutes", slots + 1);
        const uploads = await getHitsAsync(uploadKey, "15minutes", slots + 1);
        downloads.pop()
        uploads.pop()

        // return usage even there's less data than the observation window
        // so device don't have to be in network for 8hr+ to generate the alarm
        slots = Math.min(downloads.length, uploads.length)
        const sumSlots = (slots + 1) * (slots / 2); // total weights, sum from 1 to slots

        let result = 0
        for (let i = 0; i < slots; i++) {
          const weight = weightedAverage ? (i+1) / sumSlots : 1
          result += (downloads[i][1] + uploads[i][1]) * weight;
        }
        return { begin: downloads[0][0], end: downloads[downloads.length-1][0], count: result }
    }

    async genAbnormalBandwidthUsageAlarm(host, begin, end, totalUsage, percentage) {
        log.info("genAbnormalBandwidthUsageAlarm", host.o.mac, begin, end)
        const mac = host.getGUID();
        const dedupKey = `abnormal:bandwidth:usage:${mac}`;
        if (await this.isDedup(dedupKey, abnormalBandwidthUsageCooldown)) return;
        //get top flows from begin to end
        const name = host.o.name || host.o.bname;
        const flows = await this.getSumFlows(mac, begin, end);
        const destNames = flows.map((flow) => flow.aggregationHost).join(',')
        percentage = percentage * 100;
        const last24HoursDownloadStats = await getHitsAsync(`download:${mac}`, "15minutes", 4 * 24 + 1)
        const last24HoursUploadStats = await getHitsAsync(`upload:${mac}`, "15minutes", 4 * 24 + 1)
        const recentlyDownloadStats = await getHitsAsync(`download:${mac}`, "15minutes", 4 * this.smWindow + 1)
        const recentlyUploadStats = await getHitsAsync(`upload:${mac}`, "15minutes", 4 * this.smWindow + 1)
        last24HoursDownloadStats.pop()
        last24HoursUploadStats.pop()
        recentlyDownloadStats.pop()
        recentlyUploadStats.pop()
        const last24HoursStats = {
            download: last24HoursDownloadStats,
            upload: last24HoursUploadStats
        }
        const recentlyStats = {
            download: recentlyDownloadStats,
            upload: recentlyUploadStats
        }
        const intfId = host.getNicUUID()
        const alarm = new Alarm.AbnormalBandwidthUsageAlarm(new Date() / 1000, name, {
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
        if (host instanceof Identity) alarm['p.device.guid'] = mac
        alarmManager2.enqueueAlarm(alarm);
    }
    async getSumFlows(mac, begin, end) {
        const rawFlows = [].concat(await flowTool.queryFlows(mac, "out", begin, end), await flowTool.queryFlows(mac, "in", begin, end))
        let flows = [];
        for (const rawFlow of rawFlows) {
            flows.push({
                count: rawFlow.ob + rawFlow.rb,
                ip: flowTool.getDestIP(rawFlow),
                device: mac
            })
        }
        flows = await flowTool.enrichWithIntel(flows, true);
        let flowsCache = {};
        for (const flow of flows) {
            const destHost = (flow.host && validator.isFQDN(flow.host)) ? suffixList.getDomain(flow.host) : flow.ip;
            if (flowsCache[destHost]) {
                flowsCache[destHost].count += flow.count
            } else {
                flowsCache[destHost] = flow
            }
        }
        let flowsGroupByDestHost = [];
        for (const destHost in flowsCache) {
            flowsCache[destHost].aggregationHost = destHost;
            flowsGroupByDestHost.push(flowsCache[destHost]);
        }
        return flowsGroupByDestHost.sort((a, b) => b.count - a.count).slice(0, this.topXflows)
          .filter(flow => flow.count > 10 * 1000 * 1000) //return flows bigger than 10MB
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
            multi.del(`monthly:data:usage:${wanUUID ? `${wanUUID}:` : ""}lastTs`);
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
