/*    Copyright 2016 - 2020 Firewalla Inc
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
const Config = require('../net2/config.js');
const exec = require('child-process-promise').exec;
const { Rule } = require('../net2/Iptables.js');
const rclient = require('../util/redis_manager.js').getRedisClient();
const f = require('../net2/Firewalla.js');
const Tail = require('../vendor_lib/always-tail.js');
const LOG_PREFIX = "[FW_ACL_AUDIT]";
const {Address4, Address6} = require('ip-address');
const sysManager = require('../net2/SysManager.js');
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();
const DNSTool = require('../net2/DNSTool.js');
const dnsTool = new DNSTool();
const Message = require('../net2/Message.js');
const sem = require('./SensorEventManager.js').getInstance();

const auditLogFile = "/var/log/acl_audit.log";

const featureName = "acl_audit";

class ACLAuditLogPlugin extends Sensor {
  async run() {
    this.hookFeature(featureName);
    this.timeoutTask = null;
    this.auditLogReader = null;
  }

  async job() {
    // ensure log file is readable
    await exec(`sudo touch ${auditLogFile}`).catch((err) => {});
    await exec(`sudo chgrp adm ${auditLogFile}`).catch((err) => {});
    await exec(`sudo chown syslog ${auditLogFile}`).catch((err) => {});
    await exec(`sudo chmod 644 ${auditLogFile}`).catch((err) => {});

    this.auditLogReader = new Tail(auditLogFile, '\n');
    if (this.auditLogReader != null) {
      this.auditLogReader.on('line', (line) => {
        this._processIptablesLog(line);
      });
      this.auditLogReader.on('error', (err) => {
        log.error("Error while reading acl audit log", err.message);
      })
    }

    sem.on(Message.MSG_ACL_DNS_NXDOMAIN, (message) => {
      if (message && message.record)
        this._processDnsNxdomainRecord(message.record);
    });
  }

  // Jul  2 16:35:57 firewalla kernel: [ 6780.606787] [FW_ACL_AUDIT]IN=br0 OUT=eth0 MAC=20:6d:31:fe:00:07:88:e9:fe:86:ff:94:08:00 SRC=192.168.210.191 DST=23.129.64.214 LEN=64 TOS=0x00 PREC=0x00 TTL=63 ID=0 DF PROTO=TCP SPT=63349 DPT=443 WINDOW=65535 RES=0x00 SYN URGP=0 MARK=0x87
  async _processIptablesLog(line) {
    const content = line.substring(line.indexOf(LOG_PREFIX) + LOG_PREFIX.length); // extract content after log prefix
    if (!content || content.length == 0)
      return;
    const params = content.split(' ');
    const record = {aclType: "ip"};
    for (const param of params) {
      const kvPair = param.split('=');
      if (kvPair.length !== 2)
        continue;
      const k = kvPair[0];
      const v = kvPair[1];
      switch (k) {
        case "SRC": {
          record.src = v;
          break;
        }
        case "DST": {
          record.dst = v;
          break;
        }
        case "PROTO": {
          record.protocol = v;
          break;
        }
        case "SPT": {
          record.sport = v;
          break;
        }
        case "DPT": {
          record.dport = v;
          break;
        }
        default:
      }
    }
    if (sysManager.isLocalIP(record.src)) {
      const intf = new Address4(record.src).isValid() ? sysManager.getInterfaceViaIP4(record.src) : sysManager.getInterfaceViaIP6(record.src);
      // not able to map ip to unique identity from VPN yet
      if (!intf || intf.name === "tun_fwvpn")
        return;
      const mac = await hostTool.getMacByIPWithCache(record.src);
      if (mac) {
        if (!sysManager.isLocalIP(record.dst)) {
          const domain = await dnsTool.getDns(record.dst);
          if (domain)
            record.domain = domain;
        }
        const key = this._getAuditDropKey(mac);
        await rclient.zaddAsync(key, Date.now() / 1000, JSON.stringify(record));
      }
    } else {
      if (sysManager.isLocalIP(record.dst)) {
        const intf = new Address4(record.dst).isValid() ? sysManager.getInterfaceViaIP4(record.dst) : sysManager.getInterfaceViaIP6(record.dst);
        // not able to map ip to unique identity from VPN yet
        if (!intf || intf.name === "tun_fwvpn")
          return;
        const mac = await hostTool.getMacByIPWithCache(record.dst);
        if (mac) {
          if (!sysManager.isLocalIP(record.src)) {
            const domain = await dnsTool.getDns(record.src);
            if (domain)
              record.domain = domain;
          }
          const key = this._getAuditDropKey(mac);
          await rclient.zaddAsync(key, Date.now() / 1000, JSON.stringify(record));
        }
      }
    }
  }

  async _processDnsNxdomainRecord(record) {
    if (sysManager.isLocalIP(record.src)) {
      const intf = new Address4(record.src).isValid() ? sysManager.getInterfaceViaIP4(record.src) : sysManager.getInterfaceViaIP6(record.src);
      // not able to map ip to unique identity from VPN yet
      if (!intf || intf.name === "tun_fwvpn")
        return;
      const mac = await hostTool.getMacByIPWithCache(record.src);
      if (mac) {
        record.aclType = "dns";
        const key = this._getAuditDropKey(mac);
        await rclient.zaddAsync(key, Date.now() / 1000, JSON.stringify(record));
      }
    }
  }

  _getAuditDropKey(mac) {
    return `audit:drop:${mac}`;
  }

  async globalOn() {
    // create rsyslog config that filters iptables log to specific syslog file
    await exec(`sudo cp ${f.getFirewallaHome()}/etc/rsyslog.d/30-acl-audit.conf /etc/rsyslog.d/`).then(() => exec(`sudo systemctl restart rsyslog`)).catch((err) => {});
    const rule = new Rule("filter").chn("FW_DROP").jmp(`LOG --log-prefix "${LOG_PREFIX}"`);
    const rule6 = rule.clone().fam(6);
    await exec(rule.toCmd('-I')).catch((err) => {
      log.error("Failed to enable IPv4 iptables drop log", err.message);
    });
    await exec(rule6.toCmd('-I')).catch((err) => {
      log.error("Failed to enable IPv6 iptables drop log", err.message);
    });
    // in consideration of performance, the audit log will be automatically disabled in 30 minutes
    if (this.timeoutTask)
      clearTimeout(this.timeoutTask);
    this.timeoutTask = setTimeout(() => {
      Config.disableDynamicFeature(featureName);
    }, 30 * 60 * 1000);
  }

  async globalOff() {
    const rule = new Rule("filter").chn("FW_DROP").jmp(`LOG --log-prefix "${LOG_PREFIX}"`);
    const rule6 = rule.clone().fam(6);
    await exec(rule.toCmd('-D')).catch((err) => {
      log.error("Failed to disable IPv4 iptables drop log", err.message);
    });
    await exec(rule6.toCmd('-D')).catch((err) => {
      log.error("Failed to disable IPv6 iptables drop log", err.message);
    });
    // remove rsyslog config that filters iptables log to specific syslog file
    await exec(`sudo rm /etc/rsyslog.d/30-acl-audit.conf`).then(() => exec(`sudo systemctl restart rsyslog`)).catch((err) => {});
    if (this.timeoutTask)
      clearTimeout(this.timeoutTask);
  }

}

module.exports = ACLAuditLogPlugin;