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
'use strict';

const log = require('./logger.js')(__filename);

const cp = require('child_process');
const spawn = cp.spawn;
const execAsync = require('util').promisify(cp.exec)
const ipset = require('./Ipset.js');

const util = require('util');

function wrapIptables(rule) {
  const res = rule.match(/ -[AID] /);

  if (!res) return rule;

  const command = res[0];
  const checkRule = rule.replace(command, " -C ");

  switch (command) {
    case " -I ":
    case " -A ":
      return `bash -c '${checkRule} &>/dev/null || ${rule}'`;

    case " -D ":
      return `bash -c '${checkRule} &>/dev/null && ${rule}; true'`;
  }
}
exports.wrapIptables = wrapIptables

exports.allow = function (rule, callback) {
    rule.target = 'ACCEPT';
    if (!rule.action) rule.action = '-A';
    rule.type = 'host';
    newRule(rule, callback);
}

exports.drop = function (rule, callback) {
    rule.target = 'DROP';
    if (!rule.action) rule.action = '-A';
    rule.type = 'host';
    newRule(rule, callback);
}

function reject(rule, callback) {
    rule.target = 'REJECT';
    if (!rule.action) rule.action = '-A';
    newRule(rule, callback);
}

exports.reject = reject
exports.rejectAsync = util.promisify(reject);
exports.newRule = newRule;
exports.deleteRule = deleteRule;
exports.dnsChange = dnsChange;
exports.dnsChangeAsync = util.promisify(dnsChange);
exports.dnsFlush = dnsFlush;
exports.dnsFlushAsync = util.promisify(dnsFlush);
exports.prepare = prepare;
exports.flush = flush;
exports.run = run;
exports.dhcpSubnetChange = dhcpSubnetChange;
exports.dhcpSubnetChangeAsync = util.promisify(dhcpSubnetChange);
exports.switchACL = util.callbackify(switchACLAsync);
exports.switchACLAsync = switchACLAsync;
exports.switchInterfaceMonitoring = switchInterfaceMonitoring;
exports.switchInterfaceMonitoringAsync = util.promisify(switchInterfaceMonitoring);
exports.switchQoSAsync = switchQoSAsync;

var workqueue = [];
var running = false;

function iptables(rule, callback) {

    if (rule.type == "host") {
        let args = iptablesArgs(rule);
        let cmd = 'iptables';
        if (rule.sudo) {
            cmd = 'sudo';
            args = ['iptables', '-w'].concat(args);
        }

        log.debug("IPTABLE4:", cmd, JSON.stringify(args), workqueue.length);
        let proc = spawn(cmd, args);
        proc.stderr.on('data', function (buf) {
            console.error("IPTABLE4:", buf.toString());
        });
        proc.on('exit', (code) => {
            log.debug("IPTABLE4:EXIT", cmd, JSON.stringify(args), workqueue.length);
            if (callback) {
                callback(null, code);
            }
            running = false;
            newRule(null, null);
        });
        return proc;
    } else if (rule.type == "dhcp") {
        // install/uninstall dhcp MASQUERADE rule in NAT table
        let state = rule.state;
        let ip = rule.ip; // ip stands for dhcp subnet cidr, e.g., 192.168.218.1/24
        let action = "-A";
        if (state == false || state == null) {
            action = "-D";
        }

        let _src = " -s " + ip;
        let cmdline = "";
        let getCommand = function(action, src) {
          return `sudo iptables -w -t nat ${action} FW_POSTROUTING ${src} -j MASQUERADE`;
        };

        switch (action) {
          case "-A":
            cmdline = `${getCommand("-C", _src)} || ${getCommand(action, _src)}`;
            break;
          case "-D":
            cmdline = `(${getCommand("-C", _src)} && ${getCommand(action, _src)}); true`;
            break;
          default:
            cmdline = "sudo iptables -w -t nat " + action + " FW_POSTROUTING " + _src + " -j MASQUERADE";
            break;
        }
        log.debug("IPTABLE:DHCP:Running commandline: ", cmdline);
        cp.exec(cmdline, (err, stdout, stderr) => {
            if (err && action !== "-D") {
                log.error("IPTABLE:DHCP:Error unable to set", cmdline, err);
            }
            if (callback) {
                callback(err, null);
            }
            running = false;
            newRule(null, null);
        });
    } else if (rule.type === "switch_interface_monitoring") {
      const state = rule.state;
      const uuid = rule.uuid;
      const ipset = require('./NetworkProfile.js').getNetIpsetName(uuid);
      let action = "-D";
      if (state !== true) {
        action = "-A";
      }

      let cmdline = "";
      const getCommand = function(action, table, chain, srcDst, ipset) {
        return `sudo iptables -w -t ${table} ${action} ${chain} -m set --match-set ${ipset} ${srcDst} -j ACCEPT`;
      }

      switch (action) {
        case "-A":
          // nat table does not support -o option
          cmdline += `(${getCommand("-C", "nat", "FW_NAT_BYPASS", "src", ipset)} || ${getCommand(action, "nat", "FW_NAT_BYPASS", "src", ipset)})`;
          cmdline += ` ; (${getCommand("-C", "nat", "FW_NAT_BYPASS", "dst", ipset)} || ${getCommand(action, "nat", "FW_NAT_BYPASS", "dst", ipset)})`;
          cmdline += ` ; (${getCommand("-C", "filter", "FW_BYPASS", "src", ipset)} || ${getCommand(action, "filter", "FW_BYPASS", "src", ipset)})`;
          cmdline += ` ; (${getCommand("-C", "filter", "FW_BYPASS", "dst", ipset)} || ${getCommand(action, "filter", "FW_BYPASS", "dst", ipset)})`;
          break;
        case "-D":
          cmdline += `(${getCommand("-C", "nat", "FW_NAT_BYPASS", "src", ipset)} && ${getCommand(action, "nat", "FW_NAT_BYPASS", "src", ipset)})`;
          cmdline += ` ; (${getCommand("-C", "nat", "FW_NAT_BYPASS", "dst", ipset)} && ${getCommand(action, "nat", "FW_NAT_BYPASS", "dst", ipset)})`;
          cmdline += ` ; (${getCommand("-C", "filter", "FW_BYPASS", "src", ipset)} && ${getCommand(action, "filter", "FW_BYPASS", "src", ipset)})`;
          cmdline += ` ; (${getCommand("-C", "filter", "FW_BYPASS", "dst", ipset)} && ${getCommand(action, "filter", "FW_BYPASS", "dst", ipset)})`;
          cmdline += ` ; true`;
          break;
        default:
          log.error("Unsupport action for switch_interfce_monitoring: " + action);
          break;
      }
      cp.exec(cmdline, (err, stdout, stderr) => {
        if (callback)
          callback(err, null);
        running = false;
        newRule(null, null);
      });
    } else if (rule.type == "dns") {
        let state = rule.state;
        let ip = rule.ip;
        let dns = rule.dns;
        let srcType = rule.srcType || "local";
        let action = "-A";
        if (state == false || state == null) {
            action = "-D";
        }

        let _src = " -s " + ip;
        if (ip.includes("0.0.0.0")) {
            _src = "";
        }

        const chain = _getDNSRedirectChain(srcType);

        let cmdline = "";

        let getCommand = function(action, src, dns, protocol) {
          return `sudo iptables -w -t nat ${action} ${chain} -p ${protocol} ${src} -m set ! --match-set ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} src,src --dport 53 -j DNAT --to-destination ${dns}`
        }

        switch(action) {
          case "-A":
            cmdline += `(${getCommand("-C", _src, dns, 'tcp')} || ${getCommand(action, _src, dns, 'tcp')})`
            cmdline += ` ; (${getCommand("-C", _src, dns, 'udp')} || ${getCommand(action, _src, dns, 'udp')})`
          break;
          case "-D":
            cmdline += `(${getCommand("-C", _src, dns, 'tcp')} && ${getCommand(action, _src, dns, 'tcp')})`
            cmdline += ` ; (${getCommand("-C", _src, dns, 'udp')} && ${getCommand(action, _src, dns, 'udp')})`
            cmdline += ` ; true` // delete always return true FIXME
          break;
          default:
            cmdline = "sudo iptables -w -t nat " + action + "  FW_PREROUTING -p tcp " + _src + ` -m set ! --match-set ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} src,src --dport 53 -j DNAT --to-destination ` + dns + "  && sudo iptables -w -t nat " + action + " FW_PREROUTING -p udp " + _src + ` -m set ! --match-set ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} src,src --dport 53 -j DNAT --to-destination ` + dns;
          break;
        }

        log.debug("IPTABLE:DNS:Running commandline: ", cmdline);
        cp.exec(cmdline, (err, stdout, stderr) => {
            if (err && action !== "-D") {
                log.error("IPTABLE:DNS:Error unable to set", cmdline, err);
            }
            if (callback) {
                callback(err, null);
            }
            running = false;
            newRule(null, null);
        });
    } else if (rule.type == "dns_flush") {
      const srcType = rule.srcType || "local";
      const chain = _getDNSRedirectChain(srcType);
      const cmdline = `sudo iptables -w -t nat -F ${chain}`
      log.debug("IPTABLE:DNS_FLUSH:Running commandline: ", cmdline);
      cp.exec(cmdline, (err, stdout, stderr) => {
        if (err) {
          log.error("IPTABLE:DNS_FLUSH:Error", cmdline, err);
        }
        if (callback) {
          callback(err, null);
        }
        running = false;
        newRule(null, null);
      })
    } else {
      log.error("Invalid rule type:", rule.type);
      if (callback) {
          callback(new Error("invalid rule type:"+rule.type), null);
      }
      running = false;
      newRule(null, null);
    }
}

function iptablesArgs(rule) {
    let args = [];

    if (!rule.chain) rule.chain = 'FW_FORWARD';

    if (rule.chain) args = args.concat([rule.action, rule.chain]);
    if (rule.protocol) args = args.concat(["-p", rule.protocol]);
    if (rule.src && rule.src == "0.0.0.0") {

    } else {
        if (rule.src) args = args.concat(["--src", rule.src]);
    }
    if (rule.dst) args = args.concat(["--dst", rule.dst]);
    if (rule.sport) args = args.concat(["--sport", rule.sport]);
    if (rule.dport) args = args.concat(["--dport", rule.dport]);
    if (rule.in) args = args.concat(["-i", rule.in]);
    if (rule.out) args = args.concat(["-o", rule.out]);
    if (rule.target) args = args.concat(["-j", rule.target]);
    if (rule.list) args = args.concat(["-n", "-v"]);
    if (rule.mac) args = args.concat(["-m","mac","--mac-source",rule.mac]);

    return args;
}

function newRule(rule, callback) {
    // always make a copy
    if (rule) {
        rule = JSON.parse(JSON.stringify(rule));
        rule.callback = callback;
    }

    if (running == true) {
        if (rule) {
            workqueue.push(rule);
        }
        return;
    } else {
        if (rule) {
            workqueue.push(rule);
        }
        let nextRule = workqueue.splice(0, 1);
        if (nextRule && nextRule.length > 0) {
            running = true;
            iptables(nextRule[0], nextRule[0].callback);
        }
    }
}

function deleteRule(rule, callback) {
    rule.action = '-D';
    iptables(rule, callback);
}

function _getDNSRedirectChain(type) {
  type = type || "local";
  let chain;
  switch (type) {
    case "vpn":
      chain = "FW_PREROUTING_DNS_VPN";
      break;
    case "wireguard":
      chain = "FW_PREROUTING_DNS_WG";
      break;
    case "vpnClient":
      chain = "FW_PREROUTING_DNS_VPN_CLIENT";
      break;
    case "local":
    default:
      chain = "FW_PREROUTING_DNS_DEFAULT";
  }
  return chain;
}

function dnsFlush(srcType, callback) {
  newRule({
    type: 'dns_flush',
    srcType: srcType || 'local'
  }, callback);
}

function dnsChange(ip, dns, srcType, state, callback) {
  newRule({
      type: 'dns',
      ip: ip,
      dns: dns,
      srcType: srcType || 'local',
      state: state
  }, callback);
}

function dhcpSubnetChange(ip, state, callback) {
  newRule({
    type: 'dhcp',
    ip: ip,
    state: state
  }, callback);
}

function prepare() {
  return execAsync(
    "(sudo iptables -w -N FW_FORWARD || true) && (sudo iptables -w -t nat -N FW_PREROUTING || true) && (sudo iptables -w -t nat -N FW_POSTROUTING || true) && (sudo iptables -w -t mangle -N FW_PREROUTING || true) && (sudo iptables -w -t mangle -N FW_FORWARD || true)"
  ).catch(err => {
    log.error("IPTABLE:PREPARE:Unable to prepare", err);
  })
}

function flush() {
  return execAsync(
    "sudo iptables -w -F FW_FORWARD && sudo iptables -w -t nat -F FW_PREROUTING && sudo iptables -w -t nat -F FW_POSTROUTING && sudo iptables -w -t mangle -F FW_PREROUTING && sudo iptables -w -t mangle -F FW_FORWARD",
  ).catch(err => {
    log.error("IPTABLE:FLUSH:Unable to flush", err)
  });
}

async function switchQoSAsync(state, family = 4) {
  const op = state ? '-D' : '-A'

  const inRule = new Rule('mangle').chn('FW_QOS_SWITCH')
    .mdl("set", `--match-set ${ipset.CONSTANTS.IPSET_LAN} dst,dst`)
    .jmp(`CONNMARK --set-xmark 0x0/0x40000000`).fam(family);
  const outRule = new Rule('mangle').chn('FW_QOS_SWITCH')
    .mdl("set", `--match-set ${ipset.CONSTANTS.IPSET_LAN} src,src`)
    .jmp(`CONNMARK --set-xmark 0x0/0x40000000`).fam(family);

  await execAsync(inRule.toCmd(op)).catch((err) => {
    log.error(`Failed to switch QoS: ${inRule}`, err.message);
  });
  await execAsync(outRule.toCmd(op)).catch((err) => {
    log.error(`Failed to switch QoS: ${outRule}`, err.message);
  });
}

async function switchACLAsync(state, family = 4) {
  const op = state ? '-D' : '-I'

  const byPassOut = new Rule()
    .mdl("set", `--match-set ${ipset.CONSTANTS.IPSET_MONITORED_NET} src,src`)
    .mdl("set", `! --match-set ${ipset.CONSTANTS.IPSET_MONITORED_NET} dst,dst`)
    .mdl("conntrack", "--ctdir ORIGINAL").jmp('RETURN').fam(family);
  const byPassIn = new Rule()
    .mdl("set", `--match-set ${ipset.CONSTANTS.IPSET_MONITORED_NET} dst,dst`)
    .mdl("set", `! --match-set ${ipset.CONSTANTS.IPSET_MONITORED_NET} src,src`)
    .mdl("conntrack", "--ctdir REPLY").jmp('RETURN').fam(family);
  const byPassNat = new Rule('nat').chn('FW_NAT_BYPASS')
    .mdl("set", `--match-set ${ipset.CONSTANTS.IPSET_MONITORED_NET} src,src`).jmp('FW_PREROUTING_DNS_FALLBACK').fam(family)

  await execAsync(byPassOut.chn('FW_DROP').toCmd(op));
  await execAsync(byPassIn.chn('FW_DROP').toCmd(op));
  await execAsync(byPassOut.chn('FW_SEC_DROP').toCmd(op));
  await execAsync(byPassIn.chn('FW_SEC_DROP').toCmd(op));
  await execAsync(byPassNat.toCmd(op))
}

function switchInterfaceMonitoring(state, uuid, callback) {
  newRule({
    type: "switch_interface_monitoring",
    uuid: uuid,
    state: state
  }, callback);
}

async function run(listofcmds) {
  for (const cmd of listofcmds || []) {
    await execAsync(cmd, {timeout: 10000}).catch((err) => {
      log.error("IPTABLE:RUN:Unable to run command", cmd, err);
    });
  }
}

// Rule = {
//   family: 4,      // default 4
//   table: "nat",   // default "filter"
//   proto: "tcp",   // default "all"
//   chain: "FW_BLOCK",
//   match: [
//     { name: "c_bm_39_set", spec: "src", type: "set" },
//     { name: "c_bd_av_set", spec: "dst", type: "set" }
//   ],
//   jump: "FW_DROP"
// }

class Rule {
  constructor(table = 'filter') {
    this.family = 4;
    this.table = table;
    this.match = [];
    this.modules = [];
    this.params = null;
    this.cmt = null;
  }

  fam(v) { this.family = v; return this }
  tab(t) { this.tables = t; return this }
  pro(p) { this.proto = p; return this }
  chn(c) { this.chain = c; return this }
  mth(name, spec, type = "set", positive = true) {
    this.match.push({ name, spec, type, positive })
    return this
  }
  mdl(module, expr) {
    this.modules.push({module, expr});
    return this;
  }
  jmp(j) { this.jump = j; return this }

  pam(p) { this.params = p; return this }
  comment(c) { return this.mdl("comment", `--comment ${c}`)}

  clone() {
    const rule = Object.assign(Object.create(Rule.prototype), this);
    // use a new reference for the array member variables
    rule.match = [...this.match];
    rule.modules = [...this.modules];
    return rule;
  }

  _rawCmd(operation) {
    if (!this.chain) throw new Error("chain missing")
    if (!operation) throw new Error("operation missing")

    let cmd = [
      'sudo',
      this.family === 4 ? 'iptables' : 'ip6tables',
      '-w',
      '-t', this.table,
      operation,
      this.chain,
    ]

    this.proto && cmd.push('-p', this.proto)

    this.modules.forEach((m) => {
      cmd.push(`-m ${m.module} ${m.expr}`);
    });

    this.match.forEach((match) => {
      switch(match.type) {
        case 'set':
          cmd.push('-m set');
          if (!match.positive)
            cmd.push('!');
          cmd.push('--match-set', match.name)
          if (match.spec === 'both')
            cmd.push('src,dst')
          else
            cmd.push(match.spec)
          break;

        case 'iif':
          if (!match.positive)
            cmd.push('!');
          cmd.push('-i', match.name);
          break;

        case 'oif':
          if (!match.positive)
            cmd.push('!');
          cmd.push('-o', match.name);
          break;

        case 'src':
          if (!match.positive)
            cmd.push('!');
          cmd.push('-s', match.name);
          break;

        case 'dst':
          if (!match.positive)
            cmd.push('!');
          cmd.push('-d', match.name);
          break;

        case 'sport':
          if (!match.positive)
            cmd.push('!');
          cmd.push('--sport', match.name);
          break;

        case 'dport':
          if (!match.positive)
            cmd.push('!');
          cmd.push('--dport', match.name);
          break;

        default:
      }
    })

    this.params && cmd.push(this.params)

    this.jump && cmd.push('-j', this.jump)
    this.cmt && cmd.push('-m comment --comment', this.cmt)

    return cmd.join(' ');
  }

  toCmd(operation) {
    const checkRule = this._rawCmd('-C')
    const rule = this._rawCmd(operation)

    switch (operation) {
      case '-I':
      case '-A':
        return `bash -c '${checkRule} &>/dev/null || ${rule}'`;

      case '-D':
        return `bash -c '${checkRule} &>/dev/null && ${rule}; true'`;

      case '-F':
        return `bash -c '${rule}; true'`;
    }
  }
}
exports.Rule = Rule
