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

var instance = null;
var log = null;
var SysManager = require('./SysManager.js');
var sysManager = new SysManager('info');

var redis = require("redis");
var rclient = redis.createClient();

var later = require('later');
var iptable = require('./Iptables.js');
var ip6table = require('./Ip6tables.js');

var CronJob = require('cron').CronJob;
var async = require('async');

var VpnManager = require('../vpn/VpnManager.js');
var vpnManager = new VpnManager('info');


/*
127.0.0.1:6379> hgetall policy:mac:28:6A:BA:1E:14:EE
1) "blockin"
2) "false"
3) "blockout"
4) "false"
5) "family"
6) "false"
7) "monitor"
8) "true"

'block'
{[
  'id':'uid',
  'state':true/false
  'app:'...',
  'cron':'...',
  'timezone':'',
]}

*/

module.exports = class {
    constructor(loglevel) {
        if (instance == null) {
            log = require("./logger.js")("policy manager", loglevel);
            instance = this;
        }
        return instance;
    }

    // this should flush ip6tables as well
    flush(config) {
        iptable.flush((err, data) => {
            let defaultTable = config['iptables']['defaults'];
            let myip = sysManager.myIp();
            for (let i in defaultTable) {
                defaultTable[i] = defaultTable[i].replace("LOCALIP", myip);
            }
            log.info("PolicyManager:flush", defaultTable, {});
            iptable.run(defaultTable);
        });
    }

    defaults(config) {}

    block(src, dst, psrc, pdst, state, callback) {
        let action = '-A';
        if (state == false || state == null) {
            action = "-D";
        }
        let p = {
            action: action,
            chain: "FORWARD",
            sudo: true,
        };

        if (src) {
            p.src = src;
        }
        if (dst) {
            p.dst = dst;
        }

        log.info("PolicyManager:Block:IPTABLE4", JSON.stringify(p), src, dst, psrc, pdst, state);
        if (state == true) {
            p.action = "-D";
            iptable.drop(p, null);
            let p2 = JSON.parse(JSON.stringify(p));
            p2.action = "-A";
            iptable.drop(p2, callback);
        } else {
            iptable.drop(p, callback);
        }

    }

    block6(src, dst, psrc, pdst, state, callback) {
        let action = '-A';
        if (state == false || state == null) {
            action = "-D";
        }
        let p = {
            action: action,
            chain: "FORWARD",
            sudo: true,
        };

        if (src) {
            p.src = src;
        }
        if (dst) {
            p.dst = dst;
        }

        log.info("PolicyManager:Block:IPTABLE6", JSON.stringify(p), src, dst, psrc, pdst, state);
        if (state == true) {
            p.action = "-D";
            ip6table.drop(p);
            p.action = "-A";
            ip6table.drop(p, callback);
        } else {
            p.action = "-D";
            ip6table.drop(p, callback);
        }

    }


    family(ip, state, callback) {
        log.info("PolicyManager:Family:IPTABLE", ip, state);
        if (state == true) {
            iptable.dnsChange(ip, "198.101.242.72:53", false, (err, data) => {
                iptable.dnsChange(ip, "198.101.242.72:53", true, callback);
            });
        } else {
            iptable.dnsChange(ip, "198.101.242.72:53", state, callback);
        }
    }

    adblock(ip, state, callback) {
        log.info("PolicyManager:Adblock:IPTABLE", ip, state);
        if (state == true) {
            iptable.dnsChange(ip, "198.101.242.72:53", false, (err, data) => {
                iptable.dnsChange(ip, "198.101.242.72:53", true, callback);
            });
        } else {
            iptable.dnsChange(ip, "198.101.242.72:53", state, callback);
        }
    }

    hblock(host, state) {
        log.info("PolicyManager:Block:IPTABLE", host.name(), host.o.ipv4Addr, state);
        this.block(null, host.o.ipv4Addr, null, null, state, (err, data) => {
           this.block(host.o.ipv4Addr, null, null, null, state, (err, data) => {
            for (let i in host.ipv6Addr) {
                this.block6(null, host.ipv6Addr[i], null, null, state,(err,data)=>{
                    this.block6(host.ipv6Addr[i],null, null, null, state,(err,data)=>{
                    });
                });
            }
          });
        });
    }

    hfamily(host, state, callback) {
        log.info("PolicyManager:Family:IPTABLE", host.name());
        this.family(host.o.ipv4Addr, state, callback);
        for (let i in host.ipv6Addr) {
            this.family(host.ipv6Addr[i], state, callback);
        }
    }

    vpn(host, config, policies) {
        if (policies.vpnAvaliable == null || policies.vpnAvaliable == false) {
            log.error("PolicyManager:VPN", "VPN Not avaliable");
            return;
        }
        if (config.state == true) {
            vpnManager.start((err, external, port) => {
                if (err != null) {
                    config.state = false;
                    host.setPolicy("vpn", config);
                } else {
                    if (external) {
                        config.portmapped = true;
                        host.setPolicy("vpn", config, (err) => {
                            host.setPolicy("vpnPortmapped", true);
                        });
                    } else {
                        config.portmapped = false;
                        host.setPolicy("vpn", config, (err) => {
                            host.setPolicy("vpnPortmapped", true);
                        });
                    }
                }
            });
        } else {
            vpnManager.stop();
        }
    }

    execute(host, ip, policy, callback) {
        log.info("PolicyManager:Execute:", ip, policy);

        if (host.oper == null) {
            host.oper = {};
        }

        if (policy == null || Object.keys(policy).length == 0) {
            log.info("PolicyManager:Execute:NoPolicy", ip, policy);
            host.spoof(true);
            host.oper['monitor'] = true;
            if (callback)
                callback(null, null);
            return;
        }

        for (let p in policy) {
            if (host.oper[p] != null && JSON.stringify(host.oper[p]) === JSON.stringify(policy[p])) {
                log.info("PolicyManager:AlreadyApplied", p, host.oper[p]);
                continue;
            }
            if (p == "acl") {
                continue;
            } else if (p == "blockout") {
                this.block(ip, null, null, null, policy[p]);
            } else if (p == "blockin") {
                this.hblock(host, policy[p]);
                //    this.block(null,ip,null,null,policy[p]); 
            } else if (p == "family") {
                this.family(ip, policy[p], null);
            } else if (p == "adblock") {
                this.adblock(ip, policy[p], null);
            } else if (p == "monitor") {
                host.spoof(policy[p]);
            } else if (p == "vpn") {
                this.vpn(host, policy[p], policy);
            } else if (p == "block") {
                if (host.policyJobs != null) {
                    for (let key in host.policyJobs) {
                        let job = host.policyJobs[key];
                        job.stop();
                    }
                    host.policyJobs = {};
                } else {
                    host.policyJobs = {};
                }
                let block = policy[p];
                // for now always block according to cron

                let id = block['id'];
                if (id == null) {
                    log.info("PolicyManager:Cron:Remove", block);
                    continue;
                }
                if (block['cron'] == null && block['timezone'] == null) {
                    continue;
                }
                if (block['cron'].length < 6) {
                    log.info("PolicyManager:Cron:Remove", block);
                    continue;
                }
                //host.policyJobs[id]= new CronJob('00 30 11 * * 1-5', function() {

                log.info("PolicyManager:Cron:Install", block);
                host.policyJobs[id] = new CronJob(block.cron, () => {
                        log.info("PolicyManager:Cron:On=====", block);
                        this.block(ip, null, null, null, true);
                        if (block.duration) {
                            setTimeout(() => {
                                log.info("PolicyManager:Cron:Done=====", block);
                                this.block(ip, null, null, null, false);
                            }, block.duration * 1000 * 60);
                        }
                    }, () => {
                        /* This function is executed when the job stops */
                        log.info("PolicyManager:Cron:Off=====", block);
                        this.block(ip, null, null, null, false);
                    },
                    true, /* Start the job right now */
                    block.timeZone /* Time zone of this job. */
                );
            }
            host.oper[p] = policy[p];
        }

        if (policy['monitor'] == null) {
            log.debug("PolicyManager:ApplyingMonitor", ip);
            host.spoof(true);
            log.debug("PolicyManager:ApplyingMonitorDone", ip);
            host.oper['monitor'] = true;
        }

        if (callback)
            callback(null, null);
    }


    // policy { dst, src, done (true/false), state (true/false) }

    executeAcl(host, ip, policy, callback) {
        if (policy == null) {
            return;
        }
        log.debug("PolicyManager:ApplyingAcl", policy);
        if (host.appliedAcl == null) {
            host.appliedAcl = {};
        }

        async.eachLimit(policy, 1, (block, cb) => {
            if (policy.done != null && policy.done == true) {
                cb();
            } else {
                if (block['dst'] != null && block['src'] != null) {
                    let aclkey = block['dst'] + "," + block['src'];
                    if (host.appliedAcl[aclkey] && host.appliedAcl[aclkey].state == block.state) {
                        cb();
                    } else {
                        this.block(block.src, block.dst, null, null, block['state'], (err) => {
                            if (err == null) {
                                if (block['state'] == false) {
                                    block['done'] = true;
                                }
                            }
                            cb();
                        });
                        host.appliedAcl[aclkey] = block;
                    }
                } else {
                    cb();
                }
            }
        }, (err) => {
            let changed = false;
            for (var i = policy.length - 1; i >= 0; i--) {
                if (policy[i].done && policy[i].done == true) {
                    policy.splice(i, 1);
                    changed = true;
                }
            }
            log.debug("Return policy splied");
            callback(null, changed);
        });
    }
}
