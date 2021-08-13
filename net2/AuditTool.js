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

  filterOptions(options) {
    const filter = super.filterOptions(options)
    if (options.direction) filter.fd = options.direction;
    return filter
  }

  async getAuditLogs(options) {
    options = options || {}
    this.checkCount(options)
    options.macs = await this.expendMacs(options)

    const logs = await this.logFeeder(options, [{ query: this.getAllLogs.bind(this) }])

    const enriched = await this.enrichWithIntel(logs.slice(0, options.count));

    return enriched
  }

  toSimpleFormat(entry, options) {
    const f = {
      ltype: options.block == undefined || options.block ? 'audit' : 'flow',
      type: entry.type,
      ts: entry.ets || entry.ts,
      count: entry.ct,
      protocol: entry.pr,
      intf: entry.intf,
      tags: entry.tags
    };

    if (entry.rl) {
      // real IP:port of the client in VPN network
      f.rl = entry.rl;
    }

    if (entry.dmac) {
      f.dstMac = entry.dmac
    }
    if (entry.drl) {
      f.drl = entry.drl
    }
    if (entry.pid) {
      f.pid = entry.pid
    }
    if (entry.reason) {
      f.reason = entry.reason
    }


    if (entry.type == 'dns') {
      Object.assign(f, {
        rrClass: entry.qc,
        rrType: entry.qt,
        rcode: entry.rc,
        domain: entry.dn
      })
      if (entry.ans) f.answers = entry.ans
    } else {
      if (entry.tls) f.type = 'tls'
      f.fd = entry.fd
    }

    try {
      if (entry.type == 'ip') {
        if (entry.fd !== 'out') { // 'in' && 'lo'
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

    if (entry.type == 'dns' || entry.fd !== 'out') {
      f.ip = entry.dh;
      f.deviceIP = entry.sh;
    } else { // ip.out
      f.ip = entry.sh;
      f.deviceIP = entry.dh;
    }

    return f;
  }

  getLogKey(mac, options) {
    // options.block == null is also counted here
    return options.block == undefined || options.block ? `audit:drop:${mac}` : `audit:accept:${mac}`
  }
}

module.exports = new AuditTool()
