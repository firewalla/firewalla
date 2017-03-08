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
var ip = require('ip');
var spawn = require('child_process').spawn;

var running = false;
var workqueue = [];

exports.allow = function (rule, callback) {
    rule.target = 'ACCEPT';
    if (!rule.action) rule.action = '-A';
    newRule(rule, callback);
}

exports.drop = function (rule, callback) {
    rule.target = 'DROP';
    if (!rule.action) rule.action = '-A';
    newRule(rule, callback);
}

exports.reject = function (rule, callback) {
    rule.target = 'REJECT';
    if (!rule.action) rule.action = '-A';
    newRule(rule, callback);
}

exports.newRule = newRule;
exports.deleteRule = deleteRule;

function iptables(rule, callback) {
    console.log("IPTABLE6: rule:",rule);
    running = true;
    var args = iptablesArgs(rule);

    var cmd = 'ip6tables';
    if (rule.sudo) {
        cmd = 'sudo';
        args = ['ip6tables', '-w'].concat(args);
    }

    console.log("IPTABLE6:", cmd, JSON.stringify(args), workqueue.length);
    var proc = spawn(cmd, args);
    proc.stderr.on('data', function (buf) {
        console.error("IP6TABLE6:", buf.toString());
    });
    proc.on('exit', (code) => {
        if (callback) {
            callback(null, code);
        }
        running = false;
        newRule(null, null);
    });
    return proc;
}

function iptablesArgs(rule) {
    var args = [];

    if (!rule.chain) rule.chain = 'INPUT';

    if (rule.chain) args = args.concat([rule.action, rule.chain]);
    if (rule.protocol) args = args.concat(["-p", rule.protocol]);
    if (rule.src) args = args.concat(["--source", rule.src]);
    if (rule.dst) args = args.concat(["--destination", rule.dst]);
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
            iptables(nextRule[0], nextRule[0].callback);
        }
    }
}


function deleteRule(rule, callback) {
    rule.action = '-D';
    iptables(rule, callback);
}

/*
function dnsChange(ip,dns,state,callback) {
    // TODO need to take care of 5353 as well
    var action = "-A";
    if (state == false) {
        action = "-D";
    }

    var cmd = "iptables";
    var cmdline = "sudo iptables -t nat "+action+"  PREROUTING -p tcp -s "+ip+" --dport 53 -j DNAT --to-destination "+dns+"  && sudo iptables -t nat "+action+" PREROUTING -p udp -s "+ip+" --dport 53 -j DNAT --to-destination "+dns;
    
    console.log("IPTABLE:DNS:Running commandline: ",cmdline);
    this.process = require('child_process').exec(cmdline, (err,out,code)=> {
        if (err) {
            console.log("IPTABLE:DNS:Error unable to set",cmdline, err); 
        } 
        if (callback) {
            callback(err,null);
        }
    });
}
*/

function flush(callback) {
    this.process = require('child_process').exec("sudo ip6tables -F && sudo iptables -F -t nat", (err, out, code) => {
        if (err) {
            console.log("IPTABLE:DNS:Error unable to set", err);
        }
        if (callback) {
            callback(err, null);
        }
    });
}

function flush6(callback) {
    this.process = require('child_process').exec("sudo ip6tables -F && sudo iptables -F -t nat", (err, out, code) => {
        if (err) {
            console.log("IPTABLE:DNS:Error unable to set", err);
        }
        if (callback) {
            callback(err, null);
        }
    });
}

function run(listofcmds, callback) {
    async.eachLimit(listofcmds, 1, (cmd, cb) => {
        console.log("IPTABLE:RUNCOMMAND", cmd);
        this.process = require('child_process').exec(cmd, (err, out, code) => {
            if (err) {
                console.log("IPTABLE:DNS:Error unable to set", err);
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
