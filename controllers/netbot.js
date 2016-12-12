#!/usr/bin/env node
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

'use strict'

const util = require('util');
var fs = require('fs');
var cloud = require('../encipher');
var program = require('commander');
var qrcode = require('qrcode-terminal');
var publicIp = require('public-ip');
var intercomm = require('../lib/intercomm.js');

var ControllerBot = require('../lib/ControllerBot.js');

var HostManager = require('../net2/HostManager.js');
var SysManager = require('../net2/SysManager.js');
var FlowManager = require('../net2/FlowManager.js');
var flowManager = new FlowManager('info');
var AlarmManager = require('../net2/AlarmManager.js');
var alarmManager = new AlarmManager('info');
var sysmanager = new SysManager();
var VpnManager = require("../vpn/VpnManager.js");
var vpnManager = new VpnManager('info');
var IntelManager = require('../net2/IntelManager.js');
var intelManager = new IntelManager('debug');

var builder = require('botbuilder');
var uuid = require('uuid');

var async = require('async');


class netBot extends ControllerBot {

    _block2(ip, dst, cron, timezone, duration, callback) {
        let value = {
            id: "0",
            cron: cron,
            dst: dst,
            timezone: timezone,
            duration: duration
        }
        this._block(ip, 'block', value, callback);
    }

    _ignore(ip,reason,callback) {
        this.hostManager.ignoreIP(ip,reason,callback);
    }

    _unignore(ip,callback) {
        this.hostManager.unignoreIP(ip,callback);
    }

    _block(ip, blocktype, value, callback) {
        console.log("_block", ip, blocktype, value);
        if (ip === "0.0.0.0") {
            this.hostManager.loadPolicy((err, data) => {
                this.hostManager.setPolicy(blocktype, value, (err, data) => {
                    if (err == null) {
                        if (callback != null)
                            callback(null, "Success");
                    } else {
                        if (callback != null)
                            callback(err, "Unable to block ip " + ip);
                    }
                });
            });
        } else {
            this.hostManager.getHost(ip, (err, host) => {
                if (host != null) {
                    host.loadPolicy((err, data) => {
                        if (err == null) {
                            host.setPolicy(blocktype, value, (err, data) => {
                                if (err == null) {
                                    if (callback != null)
                                    //   this.tx(this.primarygid, "Success:"+ip,"hosts summary");  
                                        callback(null, "Success:" + ip);
                                } else {
                                    if (callback != null)
                                    // this.tx(this.primarygid, "Unable to block ip "+ip,"hosts summary");  
                                        callback(err, "Unable to block ip " + ip)

                                }
                            });
                        } else {
                            if (callback != null)
                            //this.tx(this.primarygid, "Unable to block ip "+ip,"hosts summary");  
                                callback("error", "Unable to block ip " + ip);
                        }
                    });
                } else {
                    if (callback != null)
                    //this.tx(this.primarygid, "host not found","hosts summary");  
                        callback("error", "Host not found");
                }
            });
        }
    }

    _family(ip, value, callback) {
        if (ip === "0.0.0.0") {
            this.hostManager.loadPolicy((err, data) => {
                this.hostManager.setPolicy("family", value, (err, data) => {
                    if (err == null) {
                        if (callback != null)
                            callback(null, "Success");
                    } else {
                        if (callback != null)
                            callback(err, "Unable to block ip " + ip);
                    }
                });
            });
        } else {
            this.hostManager.getHost(ip, (err, host) => {
                if (host != null) {
                    host.loadPolicy((err, data) => {
                        if (err == null) {
                            host.setPolicy("family", value, (err, data) => {
                                if (err == null) {
                                    if (callback != null)
                                        callback(null, "Success:" + ip);
                                } else {
                                    if (callback != null)
                                        callback(err, "Unable to block ip " + ip);
                                }
                            });
                        } else {
                            if (callback != null)
                                callback("error", "Unable to block ip " + ip);
                        }
                    });
                } else {
                    if (callback != null)
                        callback("error", "host not found");
                }
            });
        }
    }

    _adblock(ip, value, callback) {
        if (ip === "0.0.0.0") {
            this.hostManager.loadPolicy((err, data) => {
                this.hostManager.setPolicy("adblock", value, (err, data) => {
                    if (err == null) {
                        if (callback != null)
                            callback(null, "Success");
                    } else {
                        if (callback != null)
                            callback(err, "Unable to block ip " + ip);
                    }
                });
            });
        } else {
            this.hostManager.getHost(ip, (err, host) => {
                if (host != null) {
                    host.loadPolicy((err, data) => {
                        if (err == null) {
                            host.setPolicy("adblock", value, (err, data) => {
                                if (err == null) {
                                    if (callback != null)
                                        callback(null, "Success:" + ip);
                                } else {
                                    if (callback != null)
                                        callback(err, "Unable to block ip " + ip);
                                }
                            });
                        } else {
                            if (callback != null)
                                callback("error", "Unable to block ip " + ip);
                        }
                    });
                } else {
                    if (callback != null)
                        callback("error", "host not found");
                }
            });
        }
    }

    _vpn(ip, value, callback) {
        this.hostManager.loadPolicy((err, data) => {
            this.hostManager.setPolicy("vpn", value, (err, data) => {
                if (err == null) {
                    if (callback != null)
                        callback(null, "Success");
                } else {
                    if (callback != null)
                        callback(err, "Unable to block ip " + ip);
                }
            });
        });
    }


    constructor(config, fullConfig, eptcloud, groups, gid, debug) {
        super(config, fullConfig, eptcloud, groups, gid, debug);
        this.bot = new builder.TextBot();
        //      this.dialog = new builder.LuisDialog(config.dialog.api);
        this.dialog = new builder.CommandDialog();
        this.bot.add('/', this.dialog);
        var self = this;
        this.compress = true;
        this.scanning = false;

        this.sensorConfig = config.controller.sensor;
        //flow.summaryhours
        // sysmanager.setConfig(this.sensorConfig);
        sysmanager.update((err, data) => {});

        setInterval(()=>{
            sysmanager.update((err, data) => {});
        },1000*60*60*10);



        this.hostManager = new HostManager("cli", 'client', 'debug');

        let c = require('../net2/MessageBus.js');
        this.subscriber = new c('debug');

        this.subscriber.subscribe("DiscoveryEvent", "DiscoveryStart", null, (channel, type, ip, msg) => {
            //this.tx(this.primarygid, "Discovery started","message");  
        });
        this.subscriber.subscribe("DiscoveryEvent", "Host:Found", null, (channel, type, ip, o) => {
            console.log("Found new host ", channel, type, ip, o);
            if (o) {
                let name = o.ipv4Addr;
                if (o.name != null) {
                    name = o.name + " (" + o.ipv4Addr + ")";
                } else if (o.macVendor != null) {
                    name = "(?)" + o.macVendor + " (" + o.ipv4Addr + ")";
                }
                this.tx2(this.primarygid, "New host found in network: " + name, "Found new host " + name, {uid:o.ipv4Addr});
            }
        });
        this.subscriber.subscribe("MonitorEvent", "Monitor:Flow:Out", null, (channel, type, ip, msg) => {
            let m = null;
            let n = null;
            console.log("Monitor:Flow:Out", channel, ip, msg, "=====");
            if (ip && msg) {
                if (msg['txRatioRanked'] && msg['txRatioRanked'].length > 0) {
                    let flow = msg['txRatioRanked'][0];
                    if (flow.rank > 0) {
                        return;
                    }
                    m = "Warning: \n\n" + flowManager.toStringShortShort2(msg['txRatioRanked'][0], msg.direction, 'txdata') + "\n";
                    n = flowManager.toStringShortShort2(msg['txRatioRanked'][0], msg.direction);
                }
            }
            if (m)
                this.tx2(this.primarygid, m, n, {id:msg.id});
        });
        this.subscriber.subscribe("MonitorEvent", "Monitor:Flow:In", null, (channel, type, ip, msg) => {
            let m = null;
            let n = null;
            console.log("Monitor:Flow:In", channel, ip, msg, "=====");
            if (ip && msg) {
                if (msg['txRatioRanked'] && msg['txRatioRanked'].length > 0) {
                    let flow = msg['txRatioRanked'][0];
                    if (flow.rank > 0) {
                        return;
                    }
                    m = "Warning: \n\n" + flowManager.toStringShortShort2(msg['txRatioRanked'][0], msg.direction, 'txdata') + "\n";
                    n = flowManager.toStringShortShort2(msg['txRatioRanked'][0], msg.direction);
                }
            }
            if (m)
                this.tx2(this.primarygid, m, n, {id:msg.id});
        });

        setTimeout(() => {
            this.scanStart();
            this.tx(this.primarygid, "200", "Firewalla Awakens!");
            this.setupDialog();
        }, 2000);

        this.hostManager.on("Scan:Done", (channel, type, ip, obj) => {
            if (type == "Scan:Done") {
                this.scanning = false;
                for (let h in this.hosts) {
                    //this.hosts[h].clean();
                }
                this.scanStart();
            }
        });
        this.hostManager.on("Scan:Start", (channel, type, ip, obj) => {
            if (type == "Scan:Start") {
                this.scanning = true;
            }
        });


    }

    scanStart(callback) {
        this.hostManager.getHosts((err, result) => {
            let listip = [];
            this.hosts = result;
            for (let i in result) {
                console.log(result[i].toShortString());
                result[i].on("Notice:Detected", (channel, type, ip, obj) => {
                    console.log("=================================");
                    console.log("Netbot:Notice:", type, ip);
                    console.log("=================================");
                    if ((obj.note == "Scan::Port_Scan" || obj.note == "Scan::Address_Scan") && this.scanning == false) {
                        let msg = result[i].name() + ": " + obj.msg;
                        this.tx(this.primarygid, msg, obj.msg);
                    } else if ((obj.note == "Scan::Port_Scan" || obj.note == "Scan::Address_Scan") && this.scanning == true) {
                        console.log("Netbot:Notice:Skip due to scanning", obj);
                    } else {
                        let msg = result[i].name() + ": " + obj.msg;
                        this.tx(this.primarygid, msg, obj.msg);
                    }
                });
                result[i].on("Intel:Detected", (channel, type, ip, obj) => {
                    console.log("=================================");
                    console.log("NetBot:Intel:", type, ip, obj);
                    console.log("=================================");
                    let msg = null;
                    let reason = "";
                    if (obj.intel != null && obj.intel['reason'] != null) {
                        reason = obj.intel.reason;
                    }
                    if (obj['seen.indicator_type'] == "Intel::DOMAIN") {
                        msg = reason + ". Device " + result[i].name() + ": " + obj['id.orig_h'] + " talking to " + obj['seen.indicator'] + ":" + obj['id.resp_p'] + ". (Reported by " + obj.intel.count + " sources)";
                    } else {
                        msg = reason + " " + result[i].name() + ": " + obj['id.orig_h'] + " talking to " + obj['id.resp_h'] + ":" + obj['id.resp_p'] + ". (Reported by " + obj.intel.count + " sources)";
                    }
                    if (obj.intel && obj.intel.summary) {
                        msg += "\n" + obj.intelurl;
                    }

                    console.log("Sending Msg:", msg);

                    this.txQ2(this.primarygid, msg, msg, {uid: obj.id});
                });
            }
            if (callback)
                callback(null, null);

        });

    }

    setHandler(gid, msg, callback) {
        // mtype: set
        // target = "ip address" 0.0.0.0 is self
        // data.item = policy
        // data.value = {'block':1},
        //
        //       console.log("Set: ",gid,msg);
        if (msg.data.item == "policy") {
          async.eachLimit(Object.keys(msg.data.value),1,(o,cb)=>{
            if (o=="monitor") {
                this._block(msg.target, "monitor", msg.data.value.monitor, (err, obj) => {
                    cb(err);
                });
            }
            else if (o=="blockin") {
                this._block(msg.target, "blockin", msg.data.value.blockin, (err, obj) => {
                    cb(err);
                });
            }
            else if (o=="acl") {
                this._block(msg.target, "acl", msg.data.value.acl, (err, obj) => {
                    cb(err);
                });
            }
            else if (o=="family") {
                this._family(msg.target, msg.data.value.family, (err, obj) => {
                    cb(err);
                });
            }
            else if (o=="adblock") {
                this._adblock(msg.target, msg.data.value.adblock, (err, obj) => {
                    cb(err);
                });
            }
            else if (o=="vpn") {
                this._vpn(msg.target, msg.data.value.vpn, (err, obj) => {
                    cb(err);
                });
            }
            else if (o=="ignore") {
                this._ignore(msg.target, msg.data.value.ignore.reason, (err, obj)=> {
                    cb(err);
                });
            }
            else if (o=="unignore") {
                this._unignore(msg.target, (err, obj) => {
                    cb(err);
                });
            } else {
                cb();
            }
          }, (err)=> {
                    let reply = {
                        type: 'jsonmsg',
                        mtype: 'policy',
                        id: uuid.v4(),
                        expires: Math.floor(Date.now() / 1000) + 60 * 5,
                        replyid: msg.id,
                    };
                    reply.code = 200;
                    reply.data = msg.data.value;
                    console.log("Repling ", reply.code, reply.data);
                    this.txData(this.primarygid, "", reply, "jsondata", "", null, callback);

          });
        } else if (msg.data.item === "host") {
            //data.item = "host"
            //data.value = "{ name: " "}"                           
            let data = msg.data;
            console.log("Setting Host", msg);
            let reply = {
                type: 'jsonmsg',
                mtype: 'init',
                id: uuid.v4(),
                expires: Math.floor(Date.now() / 1000) + 60 * 5,
                replyid: msg.id,
            };
            reply.code = 200;

            this.hostManager.getHost(msg.target, (err, host) => {
                if (host == null) {
                    console.log("Host not found");
                    reply.code = 404;
                    this.txData(this.primarygid, "", reply, "jsondata", "", null, callback);
                    return;
                }

                if (data.value.name == host.o.name) {
                    console.log("Host not changed", data.value.name, host.o.name);
                    reply.code = 200;
                    this.txData(this.primarygid, "", reply, "jsondata", "", null, callback);
                    return;
                }

                host.o.name = data.value.name;
                console.log("Changing names", host.o.name, host);
                host.save(null, (err) => {
                    if (err) {
                        reply.code = 500;
                        this.txData(this.primarygid, "", reply, "jsondata", "", null, callback);
                    } else {
                        reply.code = 200;
                        reply.data = msg.data.value;
                        this.txData(this.primarygid, "", reply, "jsondata", "", null, callback);
                    }
                });
            });
        } else if (msg.data.item === "intel") {
            // intel actions
            //   - ignore / unignore
            //   - report 
            //   - block / unblockj
            intelManager.action(msg.target, msg.data.value.action, (err)=>{
                let reply = {
                    type: 'jsonmsg',
                    mtype: 'init',
                    id: uuid.v4(),
                    expires: Math.floor(Date.now() / 1000) + 60 * 5,
                    replyid: msg.id,
                };
                reply.code = 200;
                this.txData(this.primarygid, "", reply, "jsondata", "", null, callback);
            });
        }

    }


    getAllIPForHost(ip, callback) {
        let listip = [];
        this.hostManager.getHost(ip, (err, host) => {
            if (host != null) {
                listip.push(host.o.ipv4Addr);
                if (host.ipv6Addr && host.ipv6Addr.length > 0) {
                    for (let j in host['ipv6Addr']) {
                        listip.push(host['ipv6Addr'][j]);
                    }
                }
            }
            callback(err, listip);
        });
    }

    getHandler(gid, msg, callback) {
        // mtype: get
        // target = ip address
        // data.item = [app, alarms, host]
        if (msg.data.item === "host" && msg.target) {
            this.getAllIPForHost(msg.target, (err, ips) => {
                this.deviceHandler(msg, gid, msg.target, ips, callback);
            });
        } else if (msg.data.item === "vpn" || msg.data.item === "vpnreset") {
            let regenerate = true;
            if (msg.data.item === "vpnreset") {
                regenerate = true;
            }
            this.hostManager.loadPolicy(() => {
                vpnManager.getOvpnFile("fishboneVPN1", null, regenerate, (err, ovpnfile, password) => {
                    let datamodel = {
                        type: 'jsonmsg',
                        mtype: 'reply',
                        id: uuid.v4(),
                        expires: Math.floor(Date.now() / 1000) + 60 * 5,
                        replyid: msg.id,
                        code: 404,
                    };
                    if (err == null) {
                        datamodel.code = 200;
                        datamodel.data = {
                            ovpnfile: ovpnfile,
                            password: password,
                            portmapped: this.hostManager.policy['vpnPortmapped']
                        }
                    }
                    this.txData(this.primarygid, "device", datamodel, "jsondata", "", null, callback);
                });
            });
        }

    }

    deviceHandler(msg, gid, target, listip, callback) {
        console.log("Getting Devices", gid, target, listip);
        this.hostManager.getHost(target, (err, host) => {
            if (host == null) {
                let datamodel = {
                    type: 'jsonmsg',
                    mtype: 'reply',
                    id: uuid.v4(),
                    expires: Math.floor(Date.now() / 1000) + 60 * 5,
                    replyid: msg.id,
                    code: 404,
                };
                this.txData(this.primarygid, "device", datamodel, "jsondata", "", null, callback);
                return;
            }


          //  flowManager.summarizeBytes([host], msg.data.end, msg.data.start, (msg.data.end - msg.data.start) / 16, (err, sys) => {
            flowManager.summarizeBytes2([host], Date.now() / 1000 - 60*60*24, -1,'hour', (err, sys) => {
                console.log("Summarized devices: ", msg.data.end, msg.data.start, (msg.data.end - msg.data.start) / 16,sys,{});
                let jsonobj = host.toJson();
                alarmManager.read(target, msg.data.alarmduration, null, null, null, (err, alarms) => {
                    console.log("Found alarms");
                    jsonobj.alarms = alarms;
                    // hour block = summarize into blocks of hours ...
                    flowManager.summarizeConnections(listip, msg.data.direction, msg.data.end, msg.data.start, "time", msg.data.hourblock, true,false, (err, result,activities) => {
                        console.log("--- Connectionby most recent ---", result.length);
                        let response = {
                            time: [],
                            rx: [],
                            tx: [],
                            duration: []
                        };
                        let max = 50;
                        for (let i in result) {
                            let s = result[i];
                            response.time.push(s);
                            if (max-- < 0) {
                                break;
                            }
                        }
                        flowManager.sort(result, 'rxdata');
                        console.log("-----------Sort by rx------------------------");
                        max = 15;
                        for (let i in result) {
                            let s = result[i];
                            response.rx.push(s);
                            if (max-- < 0) {
                                break;
                            }
                        }
                        //console.log(JSON.stringify(response.rx));
                        flowManager.sort(result, 'txdata');
                        console.log("-----------  Sort by tx------------------");
                        max = 15;
                        for (let i in result) {
                            let s = result[i];
                            response.tx.push(s);
                            if (max-- < 0) {
                                break;
                            }
                        }
                        jsonobj.flows = response;
                        jsonobj.activities = activities;

                        /*
                        flowManager.sort(result, 'duration');
                        console.log("-----------Sort by rx------------------------");
                        max = 10;
                        for (let i in result) {
                            let s = result[i];
                            response.duration.push(s);
                            if (max-- < 0) {
                                break;
                            }
                        }
                        */
                        //flowManager.getFlowCharacteristics(result,direction,1000000,2);
                        let datamodel = {
                            type: 'jsonmsg',
                            mtype: 'reply',
                            id: uuid.v4(),
                            expires: Math.floor(Date.now() / 1000) + 60 * 5,
                            replyid: msg.id,
                            code: 200,
                            data: jsonobj
                        };
                        console.log("Device Summary", JSON.stringify(jsonobj).length, jsonobj);
                        this.txData(this.primarygid, "flow", datamodel, "jsondata", "", null, callback);
                    });
                });
            });

        });
    }

    /*
    Received jsondata { mtype: 'cmd',
      id: '6C998946-ECC6-4535-90C5-E9525D4BB5B6',
      data: { item: 'reboot' },
      type: 'jsonmsg',
      target: '0.0.0.0' }
    */

    cmdHandler(gid, msg, callback) {
        if (msg.data.item === "reboot") {
            console.log("Rebooting");
            let datamodel = {
                type: 'jsonmsg',
                mtype: 'init',
                id: uuid.v4(),
                expires: Math.floor(Date.now() / 1000) + 60 * 5,
                replyid: msg.id,
                code: 200
            }
            this.txData(this.primarygid, "reboot", datamodel, "jsondata", "", null, callback);
            require('child_process').exec('sync & sudo reboot', (err, out, code) => {});
        } else if (msg.data.item === "reset") {
            console.log("Reseting");
            let task = require('child_process').exec('/home/pi/firewalla/scripts/reset-data', (err, out, code) => {
                let datamodel = {
                    type: 'jsonmsg',
                    mtype: 'init',
                    id: uuid.v4(),
                    expires: Math.floor(Date.now() / 1000) + 60 * 5,
                    replyid: msg.id,
                    code: 200
                }
                this.txData(this.primarygid, "reset", datamodel, "jsondata", "", null, callback);
            });
        } else if (msg.data.item === "resetpolicy") {
            console.log("Reseting");
            let task = require('child_process').exec('/home/pi/firewalla/scripts/reset-policy', (err, out, code) => {
                let datamodel = {
                    type: 'jsonmsg',
                    mtype: 'init',
                    id: uuid.v4(),
                    expires: Math.floor(Date.now() / 1000) + 60 * 5,
                    replyid: msg.id,
                    code: 200
                }
                this.txData(this.primarygid, "reset", datamodel, "jsondata", "", null, callback);
            });
        } else if (msg.data.item === "upgrade") {
            console.log("upgrading");
            let task = require('child_process').exec('/home/pi/firewalla/scripts/upgrade', (err, out, code) => {
                let datamodel = {
                    type: 'jsonmsg',
                    mtype: 'init',
                    id: uuid.v4(),
                    expires: Math.floor(Date.now() / 1000) + 60 * 5,
                    replyid: msg.id,
                    code: 200
                }
                this.txData(this.primarygid, "reset", datamodel, "jsondata", "", null, callback);
            });

        }
    }


    msgHandler(gid, rawmsg, callback) {
        if (rawmsg.mtype === "msg" && rawmsg.message.type === 'jsondata') {
            let msg = rawmsg.message.obj;
            console.log("Received jsondata", msg);
            if (rawmsg.message.obj.type === "jsonmsg") {
                if (rawmsg.message.obj.mtype === "init") {
                    console.log("Process Init load event");
                    this.hostManager.toJson(true, (err, json) => {
                        let datamodel = {
                            type: 'jsonmsg',
                            mtype: 'init',
                            id: uuid.v4(),
                            expires: Math.floor(Date.now() / 1000) + 60 * 5,
                            replyid: msg.id,
                        }
                        if (json != null) {
                            datamodel.code = 200;
                            datamodel.data = json;
                        } else {
                            datamodel.code = 500;
                        }
                        console.log("Sending data", datamodel.replyid, datamodel.id);
                        this.txData(this.primarygid, "hosts", datamodel, "jsondata", "", null, callback);

                    });
                } else if (rawmsg.message.obj.mtype === "set") {
                    // mtype: set
                    // target = "ip address" 0.0.0.0 is self
                    // data.item = policy
                    // data.value = {'block':1},
                    //
                    this.setHandler(gid, msg, callback);
                } else if (rawmsg.message.obj.mtype === "get") {
                    this.getHandler(gid, msg, callback);
                } else if (rawmsg.message.obj.mtype === "cmd") {
                    this.cmdHandler(gid, msg, callback);
                }
            }
        } else {
            this.bot.processMessage({
                text: rawmsg.message.msg,
                from: {
                    address: rawmsg.message.from,
                    channelId: gid
                }
            }, (err, msg) => {
                if (msg && msg.text) {
                    this.tx(gid, msg.text, "message");
                } else {}
            });
        }

    }

    helpString() {
        return "Bot version " + sysmanager.version() + "\n\nCli interface is no longer useful, please type 'system reset' after update to new encipher app on iOS\n";
    }

    setupDialog() {
        this.dialog.matches('^system reset', (session) => {
            this.tx(this.primarygid, "performing reset of everything", "system resetting");
            let task = require('child_process').exec('/home/pi/firewalla/scripts/system-reset-all', (err, out, code) => {
                this.tx(this.primarygid, "Done, will reboot now and the system will reincarnated, this group is no longer useful, you can delete it.", "system resetting");
                require('child_process').exec('sudo reboot', (err, out, code) => {});
            });

        });
    }

}

process.on("unhandledRejection", function (r, e) {
    console.log("Oh No! Unhandled rejection!! \nr::", r, "\ne::", e);
});

var bone = require('../lib/Bone.js');
process.on('uncaughtException', (err) => {
    console.log("+-+-+-", err.message, err.stack);
    bone.log("error", {
        program: 'ui',
        version: sysmanager.version(),
        type: 'exception',
        msg: err.message,
        stack: err.stack
    }, null);
    setTimeout(() => {
        process.exit(1);
    }, 1000 * 2);
});

module.exports = netBot;
