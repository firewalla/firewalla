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
var ip = require('ip');
var spawn = require('child_process').spawn;

const log = require('./logger.js')(__filename);

var running = false;
var workqueue = [];

const Promise = require('bluebird')

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
  log.debug("IPTABLE6: rule:",rule);
  running = true;
  
  let cmd = 'ip6tables';
  let args = iptablesArgs(rule);

  if (rule.sudo) {
    args = ['sudo', 'ip6tables', '-w'].concat(args);
    cmd = args.join(" ")
  }

  if (rule.checkBeforeAction) {
    let checkRule = JSON.parse(JSON.stringify(rule))
    checkRule.action = '-C'
    let checkArgs = iptablesArgs(checkRule)
    let checkCmd = ['sudo', 'ip6tables', '-w'].concat(checkArgs).join(" ")
    
    switch(rule.action) {
    case "-A":
      // check if exits before insertion
      cmd = `${checkCmd} || ${cmd}`
      break
    case "-D":
      cmd = `${checkCmd} && ${cmd}`
      break
    default:
      break
    }    
  }
  
  log.debug("IPTABLE6:", cmd, workqueue.length);

  // for testing purpose only
  if(exports.test && typeof exports.test === 'function') {
    exports.test(cmd, args.join(" "))
    if (callback) {
      callback(null, null);
    }
    running = false;
    newRule(null, null);
    return
  }
  
  const proc = spawn(cmd, {shell: true});
    proc.stderr.on('data', function (buf) {
        log.error("IP6TABLE6:", buf.toString());
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
  if(rule.table) args = args.concat(["-t", rule.table])
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
  if(rule.todest) args = args.concat(["--to-destination", rule.todest])

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

function flush(callback) {
    this.process = require('child_process').exec("sudo ip6tables -F && sudo iptables -F -t nat", (err, out, code) => {
        if (err) {
            log.error("IPTABLE:DNS:Error unable to set", err, {});
        }
        if (callback) {
            callback(err, null);
        }
    });
}

function flush6(callback) {
    this.process = require('child_process').exec("sudo ip6tables -F && sudo iptables -F -t nat", (err, out, code) => {
        if (err) {
            log.error("IPTABLE:DNS:Error unable to set", err, {});
        }
        if (callback) {
            callback(err, null);
        }
    });
}

function run(listofcmds, callback) {
    async.eachLimit(listofcmds, 1, (cmd, cb) => {
        log.debug("IPTABLE:RUNCOMMAND", cmd);
        this.process = require('child_process').exec(cmd, (err, out, code) => {
            if (err) {
                log.error("IPTABLE:DNS:Error unable to set", err, {});
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

function dnsRedirectAsync(server, port) {
  return new Promise((resolve, reject) => {
    dnsRedirect(server, port, (err) => {
      if(err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

function dnsRedirect(server, port, cb) {
  let rule = {
    sudo: true,
    chain: 'PREROUTING',
    action: '-A',
    table: 'nat',
    protocol: 'udp',
    dport: '53',
    target: 'DNAT',
    todest: `[${server}]:${port}`,
    checkBeforeAction: true    
  }

  newRule(rule, (err) => {
    if(err) {
      log.error("Failed to apply rule:", rule, {})
      cb(err)
    } else {
      rule.protocol = 'tcp'
      newRule(rule, cb)
    }
  })
}

function dnsUnredirectAsync(server, port) {
  return new Promise((resolve, reject) => {
    dnsUnredirect(server, port, (err) => {
      if(err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

function dnsUnredirect(server, port, cb) {
  let rule = {
    sudo: true,
    chain: 'PREROUTING',
    action: '-D',
    table: 'nat',
    protocol: 'udp',
    dport: '53',
    target: 'DNAT',
    todest: `[${server}]:${port}`,
    checkBeforeAction: true
  }

  newRule(rule, (err) => {
    if(err) {
      log.error("Failed to apply rule:", rule, {})
      cb(err)
    } else {
      rule.protocol = 'tcp'
      newRule(rule, cb)
    }
  })
}

exports.dnsRedirectAsync = dnsRedirectAsync
exports.dnsUnredirectAsync = dnsUnredirectAsync
