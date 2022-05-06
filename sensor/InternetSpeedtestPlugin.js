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

const log = require('../net2/logger.js')(__filename);
const Sensor = require('./Sensor.js').Sensor;
const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const extensionManager = require('./ExtensionManager.js');
const sysManager = require('../net2/SysManager.js');
const exec = require('child-process-promise').exec;
const CronJob = require('cron').CronJob;
const cronParser = require('cron-parser');
const SPEEDTEST_RESULT_KEY = "internet_speedtest_results";
const rclient = require('../util/redis_manager.js').getRedisClient();
const Metrics = require('../extension/metrics/metrics.js');
const _ = require('lodash');
const MIN_CRON_INTERVAL = 12 * 3600 - 300; // minus 300 seconds to avoid potential time overlap between schduled jobs
const MAX_DAILY_MANUAL_TESTS = 48; // manual speed test can be triggered at most 48 times in last 24 hours
const LRU = require('lru-cache');
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const Message = require('../net2/Message.js');
const SPEEDTEST_RUNTIME_KEY = "internet_speedtest_runtime";
const CACHED_VENDOR_HKEY_PREFIX = "cached_vendor";
const LAST_EVAL_TIME_HKEY_PREFIX = "last_eval_time";

const cliBinaryPath = platform.getSpeedtestCliBinPath();

const featureName = "internet_speedtest";

class InternetSpeedtestPlugin extends Sensor {
  async apiRun() {
    this.running = false;
    this.manualRunTsCache = new LRU({maxAge: 86400 * 1000, max: MAX_DAILY_MANUAL_TESTS});

    extensionManager.onGet("internetSpeedtestServers", async (msg, data) => {
      const uuid = data.wanUUID;
      let bindIP = null;
      if (uuid) {
        const wanIntf = sysManager.getInterfaceViaUUID(uuid);
        if (wanIntf) {
          if (wanIntf.ip_address)
            bindIP = wanIntf.ip_address;
          else
            throw {msg: `WAN interface ${wanIntf.name} does not have IP address, cannot get speed test servers from it`, code: 400};
        }
      }
      const results = await this.listAvailableServers(bindIP);
      return {servers: results};
    });

    extensionManager.onGet("internetSpeedtestResults", async (msg, data) => {
      const end = Number(data.end || (Date.now() / 1000));
      const begin = Number(data.begin || end - 86400);
      const results = await this.getResult(begin, end);
      return {results};
    });

    extensionManager.onCmd("runInternetSpeedtest", async (msg, data) => {
      if (this.running)
        throw {msg: "Another speed test is still running", code: 429};
      else {
        this.manualRunTsCache.prune();
        if (this.manualRunTsCache.keys().length >= MAX_DAILY_MANUAL_TESTS) {
          throw {msg: `Manual tests has exceeded ${MAX_DAILY_MANUAL_TESTS} times in the last 24 hours`, code: 429};
        }
        try {
          this.running = true;
          const uuid = data.wanUUID;
          const serverId = data.serverId || undefined;
          let bindIP = null;
          if (uuid) {
            const wanIntf = sysManager.getInterfaceViaUUID(uuid);
            if (wanIntf) {
              if (wanIntf.ip_address)
                bindIP = wanIntf.ip_address;
              else
                throw {msg: `WAN interface ${wanIntf.name} does not have IP address, cannot run speedtest on it`, code: 400};
            }
          }
          let vendor = data.vendor || undefined;
          let result;
          if (!vendor) {
            result = await this.evaluateAndRunSpeedTest(bindIP, uuid, serverId, data.noUpload, data.noDownload);
            if (uuid)
              result.uuid = uuid;
          } else {
            result = await this.runSpeedTest(bindIP, serverId, data.noUpload, data.noDownload, vendor);
            if (uuid)
              result.uuid = uuid;
          }
          this.manualRunTsCache.set(new Date().toTimeString(), 1);
          result.manual = true // add a flag to indicate this round is manually triggered
          await this.saveResult(result);
          if (result.success)
            await this.saveMetrics(this._getMetricsKey(uuid || "overall"), result);
          return {result};
        } catch (err) {
          throw {msg: err.message, code: 500};
        } finally {
          this.running = false;
        }
      }
    });
  }

  async run() {
    this.speedtestJob = null;

    extensionManager.registerExtension(featureName, this, {
      applyPolicy: this.applyPolicy
    })

    this.hookFeature(featureName);

    sclient.on("message", async (channel, message) => {
      if (channel === Message.MSG_SYS_TIMEZONE_RELOADED) {
        if (this._policy) {
          log.info("System timezone is reloaded, will re-apply internet speedtest policy ...");
          this.applyPolicy(null, "0.0.0.0", this._policy)
        }
      }
    });
    sclient.subscribe(Message.MSG_SYS_TIMEZONE_RELOADED);
  }

  async applyPolicy(host, ip, policy) {
    log.info("Applying internet speedtest policy", ip, policy);
    if (ip === "0.0.0.0") {
      this._policy = policy;
      if (this.speedtestJob)
        this.speedtestJob.stop();
      if (policy && policy.state === true) {
        const wanConfs = policy.wanConfs || {};
        const tz = sysManager.getTimezone();
        const cron = policy.cron;
        const noUpload = policy.noUpload || false;
        const noDownload = policy.noDownload || false;
        let vendor = policy.vendor || undefined;
        let serverId = policy.serverId;
        if (!cron)
          return;
        try {
          cronParser.parseExpression(cron, {tz});
        } catch (err) {
          log.error(`Invalid cron expression: ${cron}`);
          return;
        }
        this.speedtestJob = new CronJob(cron, async () => {
          const lastRunTs = this.lastRunTs || 0;
          const now = Date.now() / 1000;
          if (now - lastRunTs < MIN_CRON_INTERVAL) {
            log.error(`Last cronjob was scheduled at ${new Date(lastRunTs * 1000).toTimeString()}, ${new Date(lastRunTs * 1000).toDateString()}, less than ${MIN_CRON_INTERVAL} seconds till now`);
            return;
          }
          this.lastRunTs = now;
          log.info(`Start scheduled overall speed test`);
          let overallResult;
          // if vendor is not specified in policy, re-evaluate periodically and cache the selected vendor
          if (!vendor) {
            overallResult = await this.evaluateAndRunSpeedTest(null, "overall", serverId, noUpload, noDownload);
          } else {
            overallResult = await this.runSpeedTest(null, serverId, noUpload, noDownload, vendor);
          }
          await this.saveResult(overallResult);
          if (overallResult.success)
            await this.saveMetrics(this._getMetricsKey("overall"), overallResult);
          const wanInterfaces = sysManager.getWanInterfaces();
          for (const iface of wanInterfaces) {
            const uuid = iface.uuid;
            const bindIP = iface.ip_address;
            let wanServerId = serverId;
            let wanNoUpload = noUpload;
            let wanNoDownload = noDownload;
            let wanVendor = policy.vendor || undefined;
            if (!bindIP) {
              log.error(`WAN interface ${iface.name} does not have IP address, cannot run speed test on it`);
              continue;
            }
            if (!wanConfs.hasOwnProperty(uuid)) {
              log.info(`Speed test on ${iface.name} is not enabled`);
              continue;
            }
            if (wanConfs[uuid]) {
              wanServerId = wanConfs[uuid].serverId || serverId; // each WAN can use specific speed test server
              wanNoUpload = wanConfs[uuid].noUpload || noUpload; // each WAN can specify if upload/download test is enabled
              wanNoDownload = wanConfs[uuid].noDownload || noDownload;
              wanVendor = wanConfs[uuid].vendor || wanVendor;
              if (wanConfs[uuid].state !== true) // speed test can be enabled/disabled on each WAN
                continue;
            }
            log.info(`Start scheduled speed test on WAN ${uuid}`);
            let wanResult;
            // if vendor is not specified in policy, re-evaluate periodically and cache the selected vendor
            if (!wanVendor) {
              wanResult = await this.evaluateAndRunSpeedTest(bindIP, uuid, wanServerId, wanNoUpload, wanNoDownload);
            } else {
              wanResult = await this.runSpeedTest(bindIP, wanServerId, wanNoUpload, wanNoDownload, wanVendor);
            }
            wanResult.uuid = uuid;
            await this.saveResult(wanResult);
            if (wanResult.success && uuid)
              await this.saveMetrics(this._getMetricsKey(uuid), wanResult);
          }
        }, () => {}, true, tz);
      }
    }
  }

  async listAvailableServers(bindIP) {
    const servers = await exec(`${cliBinaryPath} ${bindIP ? `-b ${bindIP}` : ""} -l --json`).then((result) => {
      const r = JSON.parse(result.stdout.trim());
      return (r && r.servers || []).map(server => this._convertServer(server));
    }).catch((err) => {
      log.error(`Failed to list available servers`, err.message);
      return []
    });
    return servers;
  }

  _convertServer(server) {
    if (!_.isObject(server))
      return null;
    return {
      location: server.name,
      country: server.country,
      sponsor: server.sponsor,
      id: server.id,
      host: server.host
    }
  }

  _convertTestResult(result) {
    if (!_.isObject(result))
      return null;
    const userInfo = result.user_info;
    const serverInfo = result.servers && result.servers[0];
    const r = {
      timestamp: result.timestamp,
      client: {
        publicIp: userInfo && userInfo.IP,
        isp: userInfo && userInfo.Isp
      },
      server: this._convertServer(serverInfo),
      result: {
        upload: serverInfo && serverInfo.ul_speed,
        download: serverInfo && serverInfo.dl_speed,
        latency: serverInfo && serverInfo.latency
      }
    };
    if (serverInfo && serverInfo.hasOwnProperty("jitter"))
      r.result["jitter"] = serverInfo.jitter;
    if (serverInfo && serverInfo.hasOwnProperty("ploss"))
      r.result["ploss"] = serverInfo.ploss;
    if (serverInfo && serverInfo.hasOwnProperty("dl_mbytes"))
      r.result["dlMbytes"] = serverInfo["dl_mbytes"];
    if (serverInfo && serverInfo.hasOwnProperty("ul_mbytes"))
      r.result["ulMbytes"] = serverInfo["ul_mbytes"];
    return r;
  }

  async setCachedVendor(key, value) {
    return rclient.hsetAsync(SPEEDTEST_RUNTIME_KEY, `${CACHED_VENDOR_HKEY_PREFIX}_${key}`, value);
  }

  async getCachedVendor(key) {
    return rclient.hgetAsync(SPEEDTEST_RUNTIME_KEY, `${CACHED_VENDOR_HKEY_PREFIX}_${key}`);
  }

  async setLastEvalTime(key, value) {
    return rclient.hsetAsync(SPEEDTEST_RUNTIME_KEY, `${LAST_EVAL_TIME_HKEY_PREFIX}_${key}`, value);
  }

  async getLastEvalTime(key) {
    return rclient.hgetAsync(SPEEDTEST_RUNTIME_KEY, `${LAST_EVAL_TIME_HKEY_PREFIX}_${key}`).then(result => result && Number(result));
  }

  getVendorCandidates() {
    return !_.isEmpty(this.config.vendorCandidates) ? this.config.vendorCandidates : ["mlab", "ookla"];
  }

  async evaluateAndRunSpeedTest(bindIP, uuid, serverId, noUpload = false, noDownload = false) {
    uuid = uuid || "overall";
    const reevalPeriod = this.config.reevalPeriod || 86400 * 30;
    const lastEvalTime = await this.getLastEvalTime(uuid);
    const vendorCandidates = this.getVendorCandidates();
    let cachedVendor = await this.getCachedVendor(uuid);
    if (!lastEvalTime || Date.now() / 1000 - lastEvalTime > reevalPeriod || !cachedVendor || !vendorCandidates.includes(cachedVendor)) {
      log.info(`Re-evaluating speedtest vendors on WAN ${uuid} ...`, vendorCandidates);
      // serverId is just a preference, it does not take effect on an irrelevant vendor
      const {vendor, result} = await this.evaluateVendors(bindIP, serverId, noUpload, vendorCandidates, this.config.switchRatioThreshold).catch((err) => {
        log.error(`Failed to re-evaluate speedtest vendor on WAN ${uuid}`, err.message);
        return null;
      });
      if (vendor && result) {
        log.info(`New speedtest vendor is selected on WAN ${uuid}: ${vendor}`);
        await this.setCachedVendor(uuid, vendor);
        await this.setLastEvalTime(uuid, Date.now() / 1000);
        if (noDownload) {
          if (result.hasOwnProperty("result") && result["result"].hasOwnProperty("dlMbytes"))
            delete result["result"]["dlMbytes"];
          if (result.hasOwnProperty("result") && result["result"].hasOwnProperty("download"))
            delete result["result"]["download"];
        }
        result.vendor = vendor;
        // directly return evaluate result, no need to run an extra speedtest using the evaluated vendor
        return result; 
      }
    }
    if (!cachedVendor || !vendorCandidates.includes(cachedVendor))
      cachedVendor = vendorCandidates[0]; // use the first vendor candidate if vendor evaluation failed
      
    log.info(`Using speedtest vendor ${cachedVendor} on WAN ${uuid}`);
    return this.runSpeedTest(bindIP, serverId, noUpload, noDownload, cachedVendor);
  }

  async evaluateVendors(bindIP, serverId = null, noUpload = false, vendorCandidates = [], switchRatioThreshold = 0.9) {
    const vendorDownloadRateMap = {};
    const vendorResultMap = {};
    let highestRate = 0;
    for (const vendor of vendorCandidates) {
      const result = await this.runSpeedTest(bindIP, serverId, noUpload, false, vendor).catch((err) => null);
      if (result && result["result"] && result["result"]["download"]) {
        log.info(`Download rate on vendor ${vendor} is ${result["result"]["download"]}`);
        vendorDownloadRateMap[vendor] = result["result"]["download"];
        vendorResultMap[vendor] = result;
        if (vendorDownloadRateMap[vendor] > highestRate)
          highestRate = vendorDownloadRateMap[vendor];
      }
    }
    for (const vendor of vendorCandidates) {
      const rate = vendorDownloadRateMap[vendor];
      if (rate && rate / highestRate >= switchRatioThreshold)
        return {vendor: vendor, result: vendorResultMap[vendor]};
    }
    return {};
  }

  async runSpeedTest(bindIP, serverId, noUpload = false, noDownload = false, vendor = "mlab") {
    const result = await exec(`timeout 90 ${cliBinaryPath} ${bindIP ? `-b ${bindIP}` : ""} ${serverId ? `-s ${serverId}` : ""} ${noUpload ? "--no-upload" : ""} ${noDownload ? "--no-download" : ""} ${vendor ? `--vendor ${vendor}` : ""} --json`)
      .then(result => JSON.parse(result.stdout.trim()))
      .then((result) => {
        const r = this._convertTestResult(result);
        r.success = true;
        return r;
      }).catch((err) => {
        log.error(`Failed to run speed test from ${bindIP}`, err.message);
        return {success: false, err: err.message};
      });
    if (vendor)
      result.vendor = vendor;
    return result;
  }

  async saveResult(result) {
    result.timestamp = Date.now() / 1000;
    await rclient.zaddAsync(SPEEDTEST_RESULT_KEY, Date.now() / 1000, JSON.stringify(result));
  }

  async getResult(begin, end) {
    const results = (await rclient.zrevrangebyscoreAsync(SPEEDTEST_RESULT_KEY, end, begin) || []).map(e => {
      try {
        return JSON.parse(e);
      } catch (err) {
        return null;
      }
    }).filter(e => e !== null);
    return results;
  }

  _getMetricsKey(uuid) {
    return `internet_speed_test:${uuid}`;
  }

  async saveMetrics(mkey, result) {
    await Metrics.set(mkey, result);
  }
}

module.exports = InternetSpeedtestPlugin;
