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
          const serverId = data.serverId;
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
          const result = await this.runSpeedTest(bindIP, serverId, data.noUpload, data.noDownload).then((r) => {
            r = this._convertTestResult(r);
            r.success = true;
            if (uuid)
              r.intf = uuid;
            return r;
          }).catch((err) => {
            log.error(`Failed to run speed test`, err.message);
            return {success: false, intf: uuid, err: err.message};
          });
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
  }

  async applyPolicy(host, ip, policy) {
    log.info("Applying internet speedtest policy", ip, policy);
    if (ip === "0.0.0.0") {
      if (this.speedtestJob)
        this.speedtestJob.stop();
      if (policy && policy.state === true) {
        const wanConfs = policy.wanConfs || {};
        const tz = sysManager.getTimezone();
        const cron = policy.cron;
        const noUpload = policy.noUpload || false;
        const noDownload = policy.noDownload || false;
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
          const result = await this.runSpeedTest(null, serverId, noUpload, noDownload).then((r) => {
            r = this._convertTestResult(r);
            r.success = true;
            return r;
          }).catch((err) => {
            log.error(`Failed to run overall speed test`, err.message);
            return {success: false, err: err.message};
          });
          await this.saveResult(result);
          if (result.success)
            await this.saveMetrics(this._getMetricsKey("overall"), result);
          const wanInterfaces = sysManager.getWanInterfaces();
          for (const iface of wanInterfaces) {
            const uuid = iface.uuid;
            const bindIP = iface.ip_address;
            let wanServerId = serverId;
            let wanNoUpload = noUpload;
            let wanNoDownload = noDownload;
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
              if (wanConfs[uuid].state !== true) // speed test can be enabled/disabled on each WAN
                continue;
            }
            log.info(`Start scheduled speed test on ${iface.name}`);
            this.lastRunTs = now;
            const result = await this.runSpeedTest(bindIP, wanServerId, wanNoUpload, wanNoDownload).then((r) => {
              r = this._convertTestResult(r);
              r.success = true;
              if (uuid)
                r.intf = uuid;
              return r;
            }).catch((err) => {
              log.error(`Failed to run speed test on ${iface.name}`, err.message);
              return {success: false, intf: uuid, err: err.message};
            });
            await this.saveResult(result);
            if (result.success && uuid)
              await this.saveMetrics(this._getMetricsKey(uuid), result);
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

  async runSpeedTest(bindIP, serverId, noUpload = false, noDownload = false) {
    const result = await exec(`timeout 90 ${cliBinaryPath} ${bindIP ? `-b ${bindIP}` : ""} ${serverId ? `-s ${serverId}` : ""} ${noUpload ? "--no-upload" : ""} ${noDownload ? "--no-download" : ""} --json`).then(result => JSON.parse(result.stdout.trim()));
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