/*    Copyright 2016 Rottiesoft LLC 
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

exports.reject = function (rule, callback) {
    rule.target = 'REJECT';
    if (!rule.action) rule.action = '-A';
    newRule(rule, callback);
}

exports.newRule = newRule;
exports.deleteRule = deleteRule;
exports.dnsChange = dnsChange;
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

        log.info("IPTABLE4:", cmd, JSON.stringify(args), workqueue.length);
        let proc = spawn(cmd, args);
        proc.stderr.on('data', function (buf) {
            console.error("IPTABLE4:", buf.toString());
        });
        proc.on('exit', (code) => {
            log.info("IPTABLE4:EXIT", cmd, JSON.stringify(args), workqueue.length);
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
        let cmdline = "sudo iptables -w -t nat " + action + "  PREROUTING -p tcp " + _src + " --dport 53 -j DNAT --to-destination " + dns + "  && sudo iptables -w -t nat " + action + " PREROUTING -p udp " + _src + " --dport 53 -j DNAT --to-destination " + dns;

        log.info("IPTABLE:DNS:Running commandline: ", cmdline);
        require('child_process').exec(cmdline, (err, out, code) => {
            if (err) {
                log.info("IPTABLE:DNS:Error unable to set", cmdline, err);
            }
            if (callback) {
                callback(err, null);
            }
            running = false;
            newRule(null, null);
        });
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

    log.info("IPTABLE:DNS:Running commandline: ", cmdline);
    this.process = require('child_process').exec(cmdline, (err, out, code) => {
        if (err) {
            log.info("IPTABLE:DNS:Error unable to set", cmdline, err);
        }
        if (callback) {
            callback(err, null);
        }
    });
}

function flush(callback) {
    this.process = require('child_process').exec("sudo iptables -w -F && sudo iptables -w -F -t nat && sudo ip6tables -F ", (err, out, code) => {
        if (err) {
            log.info("IPTABLE:DNS:Error unable to set", err);
        }
        if (callback) {
            callback(err, null);
        }
    });
}

function flush6(callback) {
    this.process = require('child_process').exec("sudo ip6tables -w -F && sudo ip6tables -w -F -t nat", (err, out, code) => {
        if (err) {
            log.info("IPTABLE:DNS:Error unable to set", err);
        }
        if (callback) {
            callback(err, null);
        }
    });
}

function run(listofcmds, callback) {
    async.eachLimit(listofcmds, 1, (cmd, cb) => {
        log.info("IPTABLE:DNS:RUNCOMMAND", cmd);
        this.process = require('child_process').exec(cmd, (err, out, code) => {
            if (err) {
                log.info("IPTABLE:DNS:Error unable to set", err);
            }
            if (callback) {
                callback(err, null);
            }
            cb();
        });
    }, (err) => {
        if (callback)
            callback(err, null);
    });
}
