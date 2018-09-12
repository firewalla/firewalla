/*    Copyright 2016 Firewalla LLC
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

let log = require('./logger.js')(__filename);

var ip = require('ip');
var spawn = require('child_process').spawn;
var async = require('async');

let Promise = require('bluebird');

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

exports.portforwardAsync = function(rule) {
    return new Promise((resolve, reject) => {
        rule.type = "portforward";
        newRule(rule,(err)=>{
            if(err) {
                reject(err)
            } else {
                resolve();
            }
        });
    });
}

function reject(rule, callback) {
    rule.target = 'REJECT';
    if (!rule.action) rule.action = '-A';
    newRule(rule, callback);
}

exports.reject = reject

exports.rejectAsync = function (rule) {
  return new Promise((resolve, r) => {
    reject(rule, (err) => {
      if(err) {
        r(err);
      } else {
        resolve();
      }
    });
  });
}

exports.newRule = newRule;
exports.deleteRule = deleteRule;
exports.dnsChange = dnsChange;
exports.dnsChangeAsync = dnsChangeAsync;
exports.flush = flush;
exports.flush6 = flush6;
exports.run = run;


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
    } else if (rule.type == "dns") {
        let state = rule.state;
        let ip = rule.ip;
        let dns = rule.dns;
        let action = "-A";
        if (state == false || state == null) {
            action = "-D";
        }

        let _src = " -s " + ip;
        if (ip.includes("0.0.0.0")) {
            _src = "-i eth0";
        }

        let cmd = "iptables";
        let cmdline = "";

        let getCommand = function(action, src, dns, protocol) {
          return `sudo iptables -w -t nat ${action} PREROUTING -p ${protocol} ${src} --dport 53 -j DNAT --to-destination ${dns}`
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
            cmdline = "sudo iptables -w -t nat " + action + "  PREROUTING -p tcp " + _src + " --dport 53 -j DNAT --to-destination " + dns + "  && sudo iptables -w -t nat " + action + " PREROUTING -p udp " + _src + " --dport 53 -j DNAT --to-destination " + dns;
          break;
        }

        log.debug("IPTABLE:DNS:Running commandline: ", cmdline);
        require('child_process').exec(cmdline, (err, out, code) => {
            if (err && action !== "-D") {
                log.error("IPTABLE:DNS:Error unable to set", cmdline, err);
            }
            if (callback) {
                callback(err, null);
            }
            running = false;
            newRule(null, null);
        });
    } else if (rule.type == "portforward") {
        let state = rule.state;
        let protocol = rule.protocol;
        let dport = rule.dport;
        let toIP = rule.toIP;
        let toPort = rule.toPort;
        const destIP = rule.destIP
        let action = "-A";
        if (state == false || state == null) {
            action = "-D";
        }

        let cmd = "iptables";
        let cmdline = "";

        let getCommand = function(action, protocol, destIP, dport, toIP, toPort) {
          return `sudo iptables -w -t nat ${action} PREROUTING -p ${protocol} --destination ${destIP} --dport ${dport} -j DNAT --to ${toIP}:${toPort}`
        }

        switch(action) {
          case "-A":
            cmdline += `(${getCommand("-C", protocol, destIP, dport,toIP,toPort)} || ${getCommand(action, protocol, destIP, dport, toIP, toPort)})`
          break;
          case "-D":
            cmdline += `(${getCommand("-C", protocol, destIP, dport, toIP, toPort)} && ${getCommand(action, protocol, destIP, dport, toIP, toPort)})`
            cmdline += ` ; true` // delete always return true FIXME
          break;
        }

        log.info("IPTABLE:PORTFORWARD:Running commandline: ", cmdline);
        require('child_process').exec(cmdline, (err, out, code) => {
            if (err && action !== "-D") {
                log.error("IPTABLE:PORTFORWARD:Error unable to set", cmdline, err);
            }
            if (callback) {
                callback(err, null);
            }
            running = false;
            newRule(null, null);
        });

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

    if (!rule.chain) rule.chain = 'FORWARD';

    if (rule.chain) args = args.concat([rule.action, rule.chain]);
    if (rule.protocol) args = args.concat(["-p", rule.protocol]);
    if (rule.src && rule.src == "0.0.0.0") {
        args = args.concat(["-i", "eth0"]);
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

function dnsChangeAsync(ip, dns, state, ignoreError) {
  return new Promise((resolve, reject) => {
    dnsChange(ip, dns, state, (err) => {
      if(err && !ignoreError)
        reject(err)
      else
        resolve();
    })
  });
}

function dnsChange(ip, dns, state, callback) {
    newRule({
        type: 'dns',
        ip: ip,
        dns: dns,
        state: state
    }, callback);
}

function _dnsChange(ip, dns, state, callback) {
    // TODO need to take care of 5353 as well
    let action = "-A";
    if (state == false || state == null) {
        action = "-D";
    }

    let _src = " -s " + ip;
    if (ip.includes("0.0.0.0")) {
        _src = "-i eth0";
    }

    let cmd = "iptables";
    let cmdline = "sudo iptables -w -t nat " + action + "  PREROUTING -p tcp " + _src + " --dport 53 -j DNAT --to-destination " + dns + "  && sudo iptables -w -t nat " + action + " PREROUTING -p udp " + _src + " --dport 53 -j DNAT --to-destination " + dns;

    log.debug("IPTABLE:DNS:Running commandline: ", cmdline);
    this.process = require('child_process').exec(cmdline, (err, out, code) => {
        if (err && action !== "-D") {
            log.error("IPTABLE:DNS:Error unable to set", cmdline, err);
        }
        if (callback) {
            callback(err, null);
        }
    });
}

function flush(callback) {
    this.process = require('child_process').exec("sudo iptables -w -F && sudo iptables -w -F -t nat && sudo ip6tables -F ", (err, out, code) => {
        if (err) {
            log.error("IPTABLE:DNS:Error unable to set", err, {});
        }
        if (callback) {
            callback(err, null);
        }
    });
}

function flush6(callback) {
    this.process = require('child_process').exec("sudo ip6tables -w -F && sudo ip6tables -w -F -t nat", (err, out, code) => {
        if (err) {
            log.error("IPTABLE:DNS:Error unable to set", err, {});
        }
        if (callback) {
            callback(err, null);
        }
    });
}

function run(listofcmds, eachCallback, finalCallback) {
    async.eachLimit(listofcmds, 1, (cmd, cb) => {
        log.debug("IPTABLE:DNS:RUNCOMMAND", cmd);
        this.process = require('child_process').exec(cmd, (err, out, code) => {
            if (err) {
                log.error("IPTABLE:DNS:Error unable to set", err, {});
            }
            if (eachCallback) {
                eachCallback(err, null);
            }
            cb();
        });
    }, (err) => {
        if (finalCallback)
            finalCallback(err, null);
    });
}
