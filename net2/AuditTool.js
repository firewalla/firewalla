/*    Copyright 2020-2021 Firewalla Inc.
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

const log = require('./logger.js')(__filename);

const LogQuery = require('./LogQuery.js')

const MAX_RECENT_LOG = 100;

const _ = require('lodash');

class AuditTool extends LogQuery {

  mergeLog(result, incoming) {
    result.ts = _.min([result.ts, incoming.ts])
    result.count += incoming.count
  }

  shouldMerge(previous, incoming) {
    const compareKeys = ['type', 'device', 'protocol', 'port'];
    if (!previous || !previous.type) return false
    previous.type == 'dns' ? compareKeys.push('domain', 'qc', 'qt', 'rc') : compareKeys.push('ip', 'fd')
    return _.isEqual(_.pick(previous, compareKeys), _.pick(incoming, compareKeys));
  }

  includeFirewallaInterfaces() { return true }

  async getAuditLogs(options) {
    options = options || {}
    if (!options.count || options.count > MAX_RECENT_LOG) options.count = MAX_RECENT_LOG

    const logs = await this.logFeeder(options, [{ query: this.getAllLogs.bind(this) }])

    return logs.slice(0, options.count)
  }

  toSimpleFormat(entry) {
    const f = {
      ltype: 'audit',
      type: entry.type,
      ts: entry.ets || entry.ts,
      count: entry.ct,
      protocol: entry.pr,
      intf: entry.intf,
    };

    if (entry.type == 'dns') {
      Object.assign(f, {
        rrClass: entry.qc,
        rrType: entry.qt,
        rcode: entry.rc,
        domain: entry.dn
      })
      if (entry.ans) f.answers = entry.ans
    } else {
      f.fd = entry.fd
    }

    try {
      if (entry.type == 'ip') {
        if (entry.fd === 'in') {
          f.port = Number(entry.dp);
          f.devicePort = Number(entry.sp[0]);
        } else {
          f.port = Number(entry.sp[0]);
          f.devicePort = Number(entry.dp);
        }
      } else {
        f.port = Number(entry.dp);
      }
    } catch(err) {
      log.debug('Failed to parse port', err)
    }

    if (entry.type == 'dns' || entry.fd === 'in') {
      f.ip = entry.dh;
      f.deviceIP = entry.sh;
    } else { // ip.out
      f.ip = entry.sh;
      f.deviceIP = entry.dh;
    }

    return f;
  }

  getLogKey(mac, options) {
    // options.block == null will also be counted here
    return options.block == undefined || options.block ? `audit:drop:${mac}` : `audit:accept:${mac}`
  }
}

module.exports = new AuditTool()
