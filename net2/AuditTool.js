/*    Copyright 2020-2025 Firewalla Inc.
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
const networkProfileManager = require('../net2/NetworkProfileManager.js');
const Constants = require('./Constants.js');
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

  // options here no longer serve as filter, just to query and format results
  optionsToFeeds(options, macs) {
    log.debug('optionsToFeeds', options)
    const feedsArray = []
    if (options.dns)
      feedsArray.push(this.expendFeeds({macs, block: false, dns: true}))

    if (options.auditDNSSuccess)
      feedsArray.push(this.expendFeeds({macs, block: false, auditDNSSuccess: true}))
    if (options.ntp)
      feedsArray.push(this.expendFeeds({macs, block: false, ntp: true}))

    if (options.audit)
      feedsArray.push(this.expendFeeds({macs, block: true}))
    if (options.localAudit) {
      if (macs[0] === 'system')
        feedsArray.push(this.expendFeeds({macs, block: true, local: true }))
      else
        feedsArray.push(this.expendFeeds({macs, block: true, local: true, exclude: [{dstMac: macs, fd: "out"}] }))
    }

    return [].concat(... feedsArray)
  }

  async getAuditLogs(options) {
    log.verbose('getAuditLogs', JSON.stringify(options))
    options = this.checkArguments(options || {})
    const macs = await this.expendMacs(options)

    const feeds = this.optionsToFeeds(options, macs)
    const logs = await this.logFeeder(options, feeds)

    return logs.slice(0, options.count)
  }

  toSimpleFormat(entry, options = {}) {
    const f = {
      ltype: options.dns || !options.block ? 'flow' : 'audit',
      type: options.dns ? 'dnsFlow' : entry.type,
      ts: entry._ts || entry.ts + (entry.du || 0),
      count: entry.ct,
    };
    if (entry.pr) f.protocol = entry.pr
    if (entry.intf) f.intf = networkProfileManager.prefixMap[entry.intf] || entry.intf

    if (_.isObject(entry.af) && !_.isEmpty(entry.af))
      f.appHosts = Object.keys(entry.af);

    for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
      const config = Constants.TAG_TYPE_MAP[type];
      if (entry[config.flowKey] && entry[config.flowKey].length)
        f[config.flowKey] = entry[config.flowKey];
    }

    if (entry.rl) {
      // real IP:port of the client in VPN network
      f.rl = entry.rl;
    }

    if (entry.ac === "isolation") {
      if (entry.isoGID)
        f.isoGID = entry.isoGID;
      if (entry.isoNID)
        f.isoNID = networkProfileManager.prefixMap[entry.isoNID] || entry.isoNID;
      if (entry.isoLVL)
        f.isoLVL = entry.isoLVL;
      if (entry.orig)
        f.orig = entry.orig;
      if (entry.hasOwnProperty("isoExt"))
        f.isoExt = entry.isoExt;
      if (entry.hasOwnProperty("isoInt"))
        f.isoInt = entry.isoInt;
      if (entry.hasOwnProperty("isoHost"))
        f.isoHost = entry.isoHost;
    }

    if (entry.dmac)
      f.dstMac = entry.dmac
    if (entry.drl)
      f.drl = entry.drl
    if (entry.dIntf)
      f.dIntf = networkProfileManager.prefixMap[entry.dIntf] || entry.dIntf
    if (entry.dstTags)
      f.dstTags = entry.dstTags;

    if (entry.pid) {
      f.pid = entry.pid
    }
    if (entry.reason) {
      f.reason = entry.reason
    }
    if (entry.wanIntf) {
      f.wanIntf = networkProfileManager.prefixMap[entry.wanIntf] || entry.wanIntf
    }


    if (options.dns || entry.type == 'dns') {
      f.domain = entry.dn
      if (entry.as) f.answers = entry.as
    } else {
      if (entry.tls) f.type = 'tls'
      f.fd = entry.fd
    }
    if (options.local)
      f.local = true

    try {
      if (entry.type == 'ip') {
        if (entry.fd !== 'out') { // 'in' && 'lo'
          f.port = Number(entry.dp);
          f.devicePort = Number(entry.sp[0]);
        } else {
          f.port = Number(entry.sp[0]);
          f.devicePort = Number(entry.dp);
        }
      } else if (entry.type == 'dns') {
        f.port = 53
      } else if (entry.type == 'ntp') {
        f.port = 123
      }
    } catch(err) {
      log.debug('Failed to parse port', err)
    }

    if (entry.type == 'dns' || entry.fd !== 'out') {
      if (entry.dh) f.ip = entry.dh;
      f.deviceIP = entry.sh;
    } else { // ip.out
      f.ip = entry.sh;
      f.deviceIP = entry.dh;
    }

    return f;
  }

  getLogKey(mac, options) {
    if (options.block)
      return `audit:${options.local?'local:':''}drop:${mac}`
    else
      return options.dns ? `flow:dns:${mac}`
        : options.auditDNSSuccess ? `audit:dns:${mac}`
        : `audit:accept:${mac}`
  }
}

module.exports = new AuditTool()
