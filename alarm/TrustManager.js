/*    Copyright 2022 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename, 'info');
const Constants = require('../net2/Constants.js');
const Exception = require('./Exception.js');
const rclient = require('../util/redis_manager.js').getRedisClient();

let instance = null;

class TrustManager {
  constructor() {
    if(instance == null) {
      instance = this;
    }
    return instance;
  }

  async add(key, target) {
    log.info(`Marking ${target} as trust, key: ${key}`);
    await rclient.zincrbyAsync(key, 1, target).catch(() => undefined);
  }

  async remove(key, target) {
    log.info(`Remove ${target} from trust, key: ${key}`);
    await rclient.zincrbyAsync(key, -1, target).catch(() => undefined);
    await rclient.zremrangebyscoreAsync(key, "-inf", 0).catch(() => undefined);
  }

  async get(key) {
    return await rclient.zrangeAsync(key, 0, -1).catch(() => []);
  }

  async addDomain(domain) {
    await this.add(Constants.TRUST_DOMAIN_SET, domain);
  }

  async removeDomain(domain) {
    await this.remove(Constants.TRUST_DOMAIN_SET, domain);
  }

  async getDomains() {
    return this.get(Constants.TRUST_DOMAIN_SET);
  }

  async addIP(ip) {
    await this.add(Constants.TRUST_IP_SET, ip);
  }

  async removeIP(ip) {
    await this.remove(Constants.TRUST_IP_SET, ip);
  }

  async getIPs() {
    return this.get(Constants.TRUST_IP_SET);
  }

  async reset() {
    await rclient.delAsync(Constants.TRUST_IP_SET, Constants.TRUST_DOMAIN_SET).catch(() => undefined);
    log.info("Trust is reseted");
  }

  matchAlarmWithDomain(alarm, domain) {
    const e = new Exception({
      type: "ALARM_INTEL",
      "p.dest.name": domain
    });
    return e.match(alarm);
  }

  matchAlarmWithIP(alarm, ip) {
    const e = new Exception({
      type: "ALARM_INTEL",
      "p.dest.ip": ip
    });
    return e.match(alarm);
  }

  async matchAlarm(alarm) {
    const domains = await this.getDomains();
    for(const domain of domains) {
      const matched = this.matchAlarmWithDomain(domain);
      if(matched) {
        return true;
      }
    }

    const ips = await this.getIPs();
    for(const ip of ips) {
      const matched = this.matchAlarmWithIP(ip);
      if(matched) {
        return true;
      }
    }

    return false;
  }
}

module.exports = new TrustManager();
