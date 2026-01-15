/*    Copyright 2016-2026 Firewalla Inc.
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
const execAsync = require('util').promisify(cp.exec)

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

exports.run = run;
exports.getDNSRedirectChain = getDNSRedirectChain;

function getDNSRedirectChain(type) {
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
    this.options = [];
    this.modules = [];
  }

  fam(v) { this.family = v; return this }
  tab(t) { this.tables = t; return this }
  chn(c) { this.chain = c; return this }
  pro(v, negate) { this.proto = [ '-p', v, negate ]; return this }
  sport(v, negate) { this.options.push([ '--sport', v, negate ]); return this }
  dport(v, negate) { this.options.push([ '--dport', v, negate ]); return this }
  src(v, negate) { this.options.push([ '-s', v, negate ]); return this }
  dst(v, negate) { this.options.push([ '-d', v, negate ]); return this }
  iif(v, negate) { this.options.push([ '-i', v, negate ]); return this }
  oif(v, negate) { this.options.push([ '-o', v, negate ]); return this }
  opt(name, values, negate) { this.options.push([ name, values, negate]); return this }
  set(name, spec, negate) { // simple set match, use mdl for more options
    this.modules.push({module: 'set', options: [ ['--match-set', [name, spec], negate] ]})
    return this
  }
  mark(v, negate) {
    this.modules.push({ module: 'mark', options: [ ['--mark', v, negate] ] })
    return this
  }
  mdl(module, expr) {
    this.modules.push({module, expr});
    return this;
  }

  jmp(j) { this.jump = j; return this }
  log(l) { this.jump = `LOG --log-prefix "${l}"`; return this }
  dnat(d) { this.jump = `DNAT --to-destination ${d}`; return this }

  comment(c) { return this.mdl("comment", `--comment "${c}"`)}

  opr(o) { this.operation = o; return this }

  clone() {
    const rule = Object.assign(Object.create(Rule.prototype), JSON.parse(JSON.stringify(this)));
    return rule;
  }

  _rawCmd(operation) {
    operation = operation || this.operation
    if (!operation) throw new Error("operation missing")

    let cmd = [
      'sudo',
      this.family === 4 ? 'iptables' : 'ip6tables',
      '-w',
      '-t', this.table,
      operation,
      this.essential(),
    ]

    return cmd.join(' ')
  }

  essential() {
    if (!this.chain) throw new Error("chain missing")
    const cmd = [this.chain]

    const _rawOpt = (name, values, negate) => {
      // use full format same as iptables-save
      if (name === '--dport' || name === '--sport') {
        if (!Array.isArray(this.proto)) throw new Error("dport/sport without protocol")
        cmd.push('-m', this.proto[1])
      }
      if (negate) cmd.push('!')
      cmd.push(name)
      if (Array.isArray(values))
        cmd.push(... values)
      else
        cmd.push(values)
    }

    // make sure protocol comes before sport/dport
    this.proto && _rawOpt(... this.proto)

    this.options.forEach(opt => _rawOpt(...opt))

    this.modules.forEach((m) => {
      cmd.push(`-m ${m.module}`)
      if (m.options) m.options.forEach(opt => _rawOpt(... opt))
      m.expr && cmd.push(m.expr)
    });

    this.jump && cmd.push('-j', this.jump)

    return cmd.join(' ');
  }

  toCmd(operation) {
    operation = operation || this.operation
    const checkRule = this._rawCmd('-C')
    const rule = this._rawCmd(operation)

    switch (operation) {
      case '-I':
      case '-A':
        return `bash -c '${checkRule} &>/dev/null || ${rule}'`;

      case '-D':
        return `bash -c '${checkRule} &>/dev/null && ${rule}; true'`;

      case '-F':
      case '-N':
      case '-X':
        return `bash -c '${rule}; true'`;
    }
  }

  async exec(operation) {
    const cmd = this.toCmd(operation)
    log.debug('excuting', cmd)
    await execAsync(cmd).catch(err => { log.warn('ERROR:', cmd, err, new Error().stack) })
  }
}
exports.Rule = Rule
