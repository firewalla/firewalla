/*    Copyright 2016-2024 Firewalla Inc.
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

const CronJob = require('cron').CronJob;
const cronParser = require('cron-parser');
const { exec } = require('child-process-promise');
const _ = require('lodash');

const dhcp = require('../extension/dhcp/dhcp.js');
const nseConfig = require('../extension/nmap/nseConfig.json')
const Constants = require('../net2/Constants.js');
const HostManager = require('../net2/HostManager.js');
const log = require('../net2/logger.js')(__filename);
const networkProfileManager = require('../net2/NetworkProfileManager.js');
const sysManager = require('../net2/SysManager.js');
const rclient = require('../util/redis_manager.js').getRedisClient();
const AsyncLock = require('../vendor_lib/async-lock');

const extensionManager = require('./ExtensionManager.js');
const Sensor = require('./Sensor.js').Sensor;

const hostManager = new HostManager();

const featureName = 'nse_scan';
const policyKeyName = 'nse_scan';
const MIN_CRON_INTERVAL = 3600; // at most one job every 24 hours, to avoid job queue congestion
const MAX_RECODE_NUM = 3; // only keeps last N records

const lock = new AsyncLock();
const LOCK_APPLY_NSE_SCAN_POLICY = "LOCK_APPLY_NSE_SCAN_POLICY";

class NseScanPlugin extends Sensor {
    constructor(config) {
      super(config);
      this.scanJob;
      this.policy;
      this.running = false;
    }

    async run() {
      this.policy = await this.loadPolicyAsync();
      extensionManager.registerExtension(featureName, this, {
        applyPolicy: this.applyPolicy
      })
    }

    async apiRun() {
      extensionManager.onCmd("runNseScan", async (msg, data) => {
        if ( !data.policy ) {
          return {'err': 'no nse_scan policy specified'};
        }
        const result = await this._runScanJob(data.policy, '', true)
        if (result && result.err) {
          return result;
        }
        return {'ok': true, ts: Date.now()/1000};
      });
    }

    async loadPolicyAsync() {
      const data = await rclient.hgetAsync(hostManager._getPolicyKey(), policyKeyName);
      if (!data) {
        return;
      }
      try{
        return JSON.parse(data);
      } catch(err){
        log.warn(`fail to load policy, invalid json ${data}`);
      };
    }

    async applyPolicy(host, ip, policy) {
      await lock.acquire(LOCK_APPLY_NSE_SCAN_POLICY, async () => {
        this.applyNsePolicy(host, ip, policy);
      }).catch((err) => {
        log.error(`failed to get lock to apply ${featureName} policy`, err.message);
      });
    }

    // policy = { state: true, cron: '0 0 * * *', policy:{'dhcp': true}}, ts: 1494931469}
    async applyNsePolicy(host, ip, policy) {
      if (host.constructor.name != hostManager.constructor.name) { // only need to handle system-level
        return;
      }
      log.info(`Applying NseScanPlugin policy, host ${host.constructor.name}, ip ${ip}, policy (${JSON.stringify(policy)})`);
      const result = await this._applyPolicy(host, ip, policy);
      if (result && result.err) {
        // if apply error, reset to previous saved policy
        log.error('fail to apply policy,', result.err);
        if (this.policy) {
          await rclient.hsetAsync('policy:system', policyKeyName, JSON.stringify(this.policy));
        }
        return;
      }
      this.policy = policy;
    }

    async _applyPolicy(host, ip, policy) {
      if (!policy) {
        return {err: 'policy must be specified'};
      }
      if (policy.state !== true) {
        log.info(`disable cron ${featureName} job, ${JSON.stringify(policy)}`);
        if (this.scanJob) {
          this.scanJob.stop();
        }
        return;
      }
      const tz = sysManager.getTimezone();
      const cron = policy.cron;
      if (!cron) {
        return {err: 'cron expression must be specified'};
      }
      try {
        var interval = cronParser.parseExpression(cron, {tz});
        const itvSec = interval.next()._date.unix() - interval.prev()._date.unix();
        if (itvSec < MIN_CRON_INTERVAL) {
          return {err: `cron expression not allowed (frequency out of range): ${cron}`};
        }
      } catch (err) {
        return {err: `cron expression invalid format: ${cron}, ${err.message}`};
      }

      if (this.scanJob) {
        this.scanJob.stop();
      }

      this.scanJob = new CronJob(cron, async() => {
        await this._runScanJob(policy.policy);
      }, () => {}, true, tz);
      return;
  }

  async _runScanJob(policy, cron='', async = false) {
    if (this.running) {
      log.info('cron nse scan job already running, skip')
      return;
    }
    try {
      log.info(`start nse scan job ${cron}: ${JSON.stringify(policy)}`);
      this.running = true
      const start = Date.now()/1000;
      if (!policy) {
        return;
      }
      if (async) {
        for (const key in policy) {
          this.runCronJob(key, policy[key]);
        }
        log.info(`Nse scan cron job finish to submit`);
        return;
      }
      // wait for results
      for (const key in policy) {
        await this.runCronJob(key, policy[key]);
      }
      const delta = parseFloat((Date.now()/1000 - start).toFixed(2));
      log.info(`Nse scan cron job finished in ${delta} seconds`);
    } catch (err) {
      log.warn('fail to running nse scan job', err.message);
      return {'err': err.message}
    } finally {
      this.running = false;
    }
  }

  async runCronJob(key, state) {
    if (!state) {
      return;
    }
    switch (key) {
      case Constants.REDIS_HKEY_NSE_DHCP: {
        const onceResult = await this.runOnceDhcp();
        // check dhcp
        const suspects = this.checkDhcpResult(onceResult);
        await this.saveNseSuspects(key, suspects);
      }
    }
  }

  async _getIntfIP(intf) {
    return exec(`ifconfig ${intf} | awk '/inet /' | awk '{print $2}' | head -n 1`).then(result => result.stdout.trim()).catch((err) => null);
  }

  checkDhcpResult(result) {
    let suspects = [];
    for (const intf in result) {
      if (Object.keys(result[intf]).length >= 1) {
        // send a warning, suspicious of local dhcp server in network
        const item = Object.entries(result[intf]).map((i)=>{return i[1].filter(i => i.local==false)}).flat();
        log.debug('suspicious of local dhcp server in network', item.map( i => i.target));
        suspects = suspects.concat(item);
      }
    }
    if (suspects.length > 0) {
      return {'alarm': true, 'reason': 'local dhcp server detected', 'suspects': suspects};
    }
    return {'alarm': false};
  }

  async runOnceDhcp() {
    let scripts = ['broadcast-dhcp-discover', 'dhcp-discover'];
    let dhcpResults = {};
    const startTs = Date.now()/1000;
    for (const scriptName of scripts){
      const nseResults = await this.execNse(scriptName);
      for (const result of nseResults) {
        if (result && result.err) {
          log.error();
          continue
        }
        if (result.interface) {
          if (!dhcpResults.hasOwnProperty(result.interface)) {
            dhcpResults[result.interface] = {};
          }
          if (!dhcpResults[result.interface].hasOwnProperty(result.serverIdentifier)) {
            dhcpResults[result.interface][result.serverIdentifier] = [];
          }
          dhcpResults[result.interface][result.serverIdentifier].push(result);
        }
      }
    }
    await this.saveNseResults(Constants.REDIS_HKEY_NSE_DHCP, dhcpResults, startTs);
    await this.saveHostNseResults(Constants.REDIS_HKEY_NSE_DHCP, dhcpResults);
    return dhcpResults;
  }

  async execNse(scriptName) {
    if (!nseConfig[scriptName]) {
      return {err: `unknown script ${scriptName}`};
    }
    let results = [];
    const startTs = Date.now()/1000;
    switch (scriptName) {
      case 'broadcast-dhcp-discover': {
        const interfaces = sysManager.getInterfaces(false).filter(i => i.ip_address && i.mac_address);
        log.debug("exec nse on interfaces", interfaces.map(i => i.name));
        for (const intf of interfaces) {
          if (!this._checkNetworkNsePolicy(intf.uuid, Constants.REDIS_HKEY_NSE_DHCP)) {
            log.debug('skip network', scriptName, intf.name);
            continue;
          }
          const result = await dhcp.broadcastDhcpDiscover(intf.name, intf.mac_address, nseConfig[scriptName]);
          log.debug("nse result", scriptName, result);
          if (result && result.ok) {
            results.push({
              serverIdentifier: result.ServerIdentifier,
              interface: result.Interface,
              domainNameServer: result.DomainNameServer || '',
              router: result.Router  || '',
              target: 'broadcast:'+intf.mac_address,
              ts: startTs,
            });
          }
        }
        break;
      }
      case 'dhcp-discover': {
        // scan devices
        const hosts = hostManager.getActiveHosts();
        log.debug("exec nse on devices", hosts.map((i) => { return {ipv4: i.o.ipv4, mac: i.o.mac} }));
        for (const h of hosts) {
          if (h.o.ipv4 && h.o.intf && this._checkNsePolicy(h.policy, Constants.REDIS_HKEY_NSE_DHCP)) {
            const result = await dhcp.dhcpDiscover(h.o.ipv4, h.o.mac, nseConfig[scriptName]);
            log.debug("nse result", scriptName, result);
            if (result && result.ok) {
              const devIntf = sysManager.getInterfaceViaUUID(h.o.intf);
              results.push({
                serverIdentifier: result.ServerIdentifier,
                domainNameServer: result.DomainNameServer,
                router: result.Router,
                interface: devIntf && devIntf.name,
                target: 'mac:'+h.o.mac,
                local: sysManager.isMyMac(h.o.mac),
                ts: startTs,
              });
            }
          }
        }
        break;
      }
      // TODO: ipv6 NOT IMPLEMENTED
      case 'broadcast-dhcp6-discover': {
        const interfaces = sysManager.getInterfaces(false).filter(i => i.ip6_addresses && i.ip6_addresses.length > 0);
        log.debug("exec nse on interfaces", interfaces);
        for (const intf of interfaces) {
          const result = await dhcp.broadcastDhcp6Discover(intf.name, nseConfig[scriptName]);
          log.debug("nse result:", result);
          if (result && result.ok) {
            results.push({
              serverIdentifier: result.ServerIdentifier,
              ts: startTs,
            });
          }
        }
        break;
      }
      default: {
        log.warn('unknown nse script', scriptName);
        break;
      }
    }
    return results;
  }

  async saveHostNseResults(fieldKey, newResult) {
    if (!newResult) {
      return;
    }
    for (const intf in newResult) {
      for (const serverIp in newResult[intf]) {
        for (const result of newResult[intf][serverIp]) {
          if (result.target.startsWith('mac:')) {
            await rclient.hsetAsync(`${policyKeyName}:${result.target}`, fieldKey, JSON.stringify(result));
          }
        }
      }
    }

    // clean
    const keys = await rclient.keysAsync(`${policyKeyName}:mac:*`);
    const deadline = Date.now() / 1000 - 2592000; // 30 days
    for (const key of keys) {
      const data = await rclient.hgetAsync(key, fieldKey);
      try {
        const result = JSON.parse(data);
        if (result.ts && result.ts < deadline ) {
          await rclient.hdelAsync(key, fieldKey);
        }
      } catch (err) {
        log.warn("delete invalid nse scan result", key, fieldKey);
        await rclient.hdelAsync(key, fieldKey);
      }
    }
  }

  async saveNseResults(fieldKey, newResult, startTs=0) {
    log.debug('save nse results', fieldKey, JSON.stringify(newResult));
    let results = await this.getNseResults(fieldKey) || {};
    results[fieldKey + '_' + startTs] = {'ts':startTs, 'results': newResult, 'spendtime': startTs ? parseFloat((Date.now()/1000-startTs).toFixed(2)):0};
    await rclient.hsetAsync(Constants.REDIS_KEY_NSE_RESULT, fieldKey, JSON.stringify(results));
  }

  async saveNseSuspects(fieldKey, suspects) {
    const prevKeys = {};
    const keys = await rclient.keysAsync(`${policyKeyName}:suspect:*`);
    keys.forEach( (i) => { prevKeys[i] = 0 });

    if (suspects && suspects.alarm ) {
      log.warn('detect suspicious of more than one dhcp server in network', JSON.stringify(suspects));
      await this._saveNseSuspects(fieldKey, suspects.suspects, prevKeys);
    }

    // clean outdated
    for (const k in prevKeys) {
      if (prevKeys[k] === 0) {
        await rclient.hdelAsync(k, fieldKey);
      }
    }
  }

  async _saveNseSuspects(fieldKey, suspects, prevKeys) {
    log.debug('save nse suspects', fieldKey, JSON.stringify(suspects));

    for (const result of suspects) {
      const macAddr = result.target.split(':').slice(1).join(':');
      const rkey = `${policyKeyName}:suspect:${macAddr}`;
      await rclient.hsetAsync(rkey, fieldKey, JSON.stringify(result));
      if (prevKeys[rkey] == 0) {
        prevKeys[rkey] = 1
      }
    }
  }

  async getNseResults(fieldKey='default') {
    const content = await rclient.hgetAsync(Constants.REDIS_KEY_NSE_RESULT, fieldKey);
    let results = {};
    if (content) {
      try {
        results = JSON.parse(content);
      } catch (err) {
        log.warn(`parse nse ${fieldKey} result error`, err.message);
        results = {};
      }
    }
    this.cleanNseResults(results);
    log.debug('get nse results', fieldKey, JSON.stringify(results));
    return results;
  }

  async getLastNseResult(fieldKey='default') {
    const results = await this.getNseResults(fieldKey);
    if (!results) {
      return {};
    }
    const sortedKeys = Object.entries(results).sort((a,b) => {return (a[1].ts || 0) - (b[1].ts || 0)}).map(i => i[0]);
    if (!_.isArray(sortedKeys) || sortedKeys.length == 0) {
      return {};
    }
    const lastResult = results[sortedKeys[sortedKeys.length-1]].results;
    const checkResult = this.checkDhcpResult(lastResult);
    return Object.assign({}, {'lastResult': lastResult}, checkResult);
  }

  cleanNseResults(results) {
    for (const key in results) {
      // delete outdated task result
      if (results[key].ts && results[key].ts < Date.now() / 1000 - 86400) {
        log.debug('delete outdated nse result', key, results[key].ts)
        delete results[key];
      }
    }
    // only keep last N items
    const len = Object.keys(results).length;
    if (len > MAX_RECODE_NUM) {
      const keys = Object.entries(results).sort((a,b) => {return (a[1].ts || 0) - (b[1].ts || 0)}).splice(0,len-MAX_RECODE_NUM).map(i=>i[0]);
      for (const key of keys) {
        delete results[key];
      }
    }
  }

  _checkNetworkNsePolicy(uuid, fieldName) {
    const networkProfile = networkProfileManager.getNetworkProfile(uuid);
    const policy = networkProfile && networkProfile.policy;
    return this._checkNsePolicy(policy, fieldName);
  }

  // true if policy not specified
  _checkNsePolicy(policy, fieldName='default'){
    if (!policy) {
      return true
    }
    if (!policy.hasOwnProperty(policyKeyName)) {
      return true;
    }
    if (policy[policyKeyName].state != true) {
      return false;
    }
    if (!policy[policyKeyName].hasOwnProperty(fieldName)) {
      return true;
    }
    return policy[policyKeyName][fieldName] === true;
  }
}

module.exports = NseScanPlugin;
