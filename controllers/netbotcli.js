#!/usr/bin/env node

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

'use strict'

var ControllerBot = require('../lib/ControllerBot.js');

var HostManager = require('../net2/HostManager.js');
var sysmanager = require('../net2/SysManager.js');
var FlowManager = require('../net2/FlowManager.js');
var flowManager = new FlowManager('info');

var builder = require('botbuilder');

class netBot extends ControllerBot {

    extractip(text) {
        let r = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
        let ip = text.match(r);
        if (ip == null) {
            return null;
        } else {
            if (ip.length >= 1) {
                return ip[0];
            }
        }
        return null;
    }

    _block2(ip, cron, timezone, duration, callback) {
        let value = {
            id: "0",
            cron: cron,
            timezone: timezone,
            duration: duration
        }
        this._block(ip, 'block', value, callback);
    }

    _block(ip, blocktype, value, callback) {
        console.log("_block", ip, blocktype, value);
        if (ip === "0.0.0.0") {
            this.hostManager.setPolicy(blocktype, value, (err, data) => {
                if (err == null) {
                    if (callback != null)
                        callback(null, "Success");
                } else {
                    if (callback != null)
                        callback(err, "Unable to block ip " + ip);
                }
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

    block(blocktype, value, session) {
        let ip = this.extractip(session.message.text);
        if (ip == null) {
            this.tx(this.primarygid, "Invalid IP address", "hosts summary");
            return;
        }
        this._block(ip, blocktype, value, (err, msg) => {
            this.tx(this.primarygid, msg, msg);
        });
    }


    // block 192.168.2.221 10 Pacic/Los_Angelos */15/... 
    // duration in min

    block2(blocktype, value, session) {
        let ip = this.extractip(session.message.text);
        console.log("Blocking2 ", ip, session.message.text);
        if (ip == null) {
            this.tx(this.primarygid, "Invalid IP address", "hosts summary");
            return;
        }
        if (blocktype == "block" && value == false) {
            console.log("No blocking");
            this._block2(ip, null, null, (err, msg) => {
                this.tx(this.primarygid, msg, msg);
            });
        } else if (blocktype == "block" && value == true) {
            let text = session.message.text;
            let splittext = session.message.text.split(" ");
            let duration = splittext[2]; // in min
            let timezone = splittext[3];
            let cron = text.slice(text.indexOf(timezone) + timezone.length + 1);
            console.log("Blocking2 ", timezone, cron, duration);
            this._block2(ip, cron, timezone, duration, (err, msg) => {
                this.tx(this.primarygid, msg, msg);
            });
        }
    }


    _family(ip, value, callback) {
        if (ip === "0.0.0.0") {
            this.hostManager.setPolicy("family", value, (err, data) => {
                if (err == null) {
                    if (callback != null)
                        callback(null, "Success");
                } else {
                    if (callback != null)
                        callback(err, "Unable to block ip " + ip);
                }
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

    family(value, session) {
        let ip = this.extractip(session.message.text);
        console.log("Family:", ip);
        if (ip == null) {
            this.tx(this.primarygid, "Invalid IP address", "hosts summary");
            return;
        }
        this._family(ip, value, (err, msg) => {
            this.tx(this.primarygid, msg, msg);
        });
    }

    helpString() {
        let myIp = "0.0.0.0";
        if (sysmanager.monitoringInterface() != null) {
            myIp = sysmanager.monitoringInterface().ip_address;
        }
        return "Bot version " + sysmanager.version() + "\n" + myIp + "\n\ntype 'manage' to configure\n\ntype 'reboot' to reboot device ,\ntype 'host <ip address>' for host summary\ntype 'summary' for system info";
    }


    setupDialog() {
        this.dialog.matches('^help', (session) => {
            this.tx(this.primarygid, this.helpString(), "summary");
        });
        this.dialog.matches('reboot', (session) => {
            this.tx(this.primarygid, "Done, will reboot now", "system resetting");
            require('child_process').exec('sudo reboot', (err, out, code) => {});

        });
        this.dialog.matches('^policy', (session) => {
            let ip = this.extractip(session.message.text);
            if (ip == null) {
                this.tx(this.primarygid, "Invalid IP address", "hosts summary");
                return;
            }
            this.hostManager.getHost(ip, (err, host) => {
                if (host) {
                    host.loadPolicy((err, data) => {
                        this.tx(this.primarygid, host.policyToString(), "hosts");
                    });
                }
            });
        });

        this.dialog.matches('^summary', (session, args) => {
            console.log("Summary intent ping");
            let numHosts = this.hosts.length;
            let hostNames = "";
            for (let i in this.hosts) {
                hostNames += this.hosts[i].toShortString() + "\n";
            }
            this.tx(this.primarygid, "Number of hosts: " + numHosts + "\n" + hostNames, "hosts summary");
        });
        this.dialog.matches('^system full reset', (session) => {
            this.tx(this.primarygid, "performing reset of everything", "system resetting");
            let task = require('child_process').exec('/home/pi/firewalla/scripts/system-reset-all', (err, out, code) => {
                this.tx(this.primarygid, "Done, will reboot now and the system will reincarnated, this group is no longer useful, you can delete it.", "system resetting");
                require('child_process').exec('sudo reboot', (err, out, code) => {});
            });

        });
        this.dialog.matches('^blockin', (session) => {
            this.block("blockin", true, session);
        });
        this.dialog.matches('^block ', (session) => {
            this.block2("block", true, session);
        });
        this.dialog.matches('^no block ', (session) => {
            this.block2("block", false, session);
        });
        this.dialog.matches('^blockout', (session) => {
            this.block("blockout", true, session);
        });
        this.dialog.matches('^no blockin', (session) => {
            this.block("blockin", false, session);
        });
        this.dialog.matches('^no blockout', (session) => {
            this.block("blockout", false, session);
        });
        this.dialog.matches('^family', (session) => {
            this.family(true, session);
        });
        this.dialog.matches('^no family', (session) => {
            this.family(false, session);
        });
        this.dialog.matches('^monitor', (session) => {
            this.block("monitor", true, session);
        });
        this.dialog.matches('^no monitor', (session) => {
            this.block("monitor", false, session);
        });
        this.dialog.matches('^host', (session) => {
            let r = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
            let ip = session.message.text.match(r);
            if (ip[0] != null) {
                for (let i in this.hosts) {
                    if (this.hosts[i].o.ipv4Addr == ip[0]) {
                        let host = this.hosts[i];
                        this.tx(this.primarygid, "Calculating ...", "calc");
                        host.getHost(ip[0], (err, result) => {
                            if (err != null) {
                                this.tx(this.primarygid, "Can't find host", "host can't find");
                            } else {
                                let msg = "* " + host.name() + " apps \n\n";
                                let max = 5;
                                for (let i in result.softwareByCount) {
                                    let s = result.softwareByCount[i];
                                    msg += s.name + "\n";
                                    if (max-- < 0) break;
                                }
                                let listp = [];
                                listp.push(result.o.ipv4Addr);
                                if (result.ipv6Addr && result.ipv6Addr.length > 0) {
                                    for (let j in result.ipv6Addr) {
                                        listp.push(result.ipv6Addr[j]);
                                    }
                                }
                                msg += "\n* Upload\n";
                                let hours = 8;
                                let time = Date.now() / 1000;
                                let endtime = Date.now() / 1000 - 60 * 60 * hours;
                                flowManager.summarizeConnections(listp, "in", time, endtime, "time", 10, true, (err, result) => {
                                    console.log("--- Connectionby most recent ---");
                                    flowManager.sort(result, 'txdata');
                                    max = 3;
                                    for (let i in result) {
                                        let s = result[i];
                                        msg += flowManager.toStringShortShort(s, 'txdata') + "\n";
                                        if (max-- < 0) {
                                            break;
                                        }
                                    }
                                    msg += "\n* Downloadt\n";

                                    max = 3;
                                    flowManager.sort(result, 'rxdata');
                                    for (let i in result) {
                                        let s = result[i];
                                        msg += flowManager.toStringShortShort(s, 'rxdata') + "\n";
                                        if (max-- < 0) {
                                            break;
                                        }
                                    }

                                    this.tx(this.primarygid, msg, "host summary");
                                });
                            }
                        });
                        break;
                    }
                }
            } else {
                this.tx(this.primarygid, "can't find host", "host can't find");
            }
        });
        this.dialog.matches('^manage', (session, args) => {
            let arrayData = [];
            let values = {};
            this.hostManager.getHosts((err, result) => {
                this.hosts = result;
                console.log("** Manageing hosts:", result.length);

                if (this.hosts.length <= 0) {
                    this.tx(this.primarygid, "HAve not found any hosts yet, please wait 20 min and try again.", "host can't find");
                    return;
                }

                for (let i in this.hosts) {
                    let now = Date.now() / 1000;
                    let hname = this.hosts[i].name();
                    if (hname == null) {
                        hname = "";
                    } else {
                        hname = hname + ": ";
                    }
                    //"title":name+this.hosts[i].o.ipv4Addr+" ("+Math.ceil((now - this.hosts[i].o.lastActiveTimestamp)/60)+"m)",
                    let sections = {
                        "id": "group-id",
                        "title": hname + this.hosts[i].o.ipv4Addr,
                        "sections": [{
                            "id": "section." + this.hosts[i].o.ipv4Addr,
                            "fields": [{
                                "id": "host.name." + this.hosts[i].o.ipv4Addr,
                                "title": "Host Name",
                                "type": "name",
                                "size": {
                                    "width": 100,
                                    "height": 1,
                                }
                            }, {
                                "id": "used.by." + this.hosts[i].o.ipv4Addr,
                                "title": "Used by",
                                "info": "Who uses this device.",
                                "type": "select",
                                "size": {
                                    "width": 100,
                                    "height": 1
                                },
                                "values": [{
                                    "id": 0,
                                    "title": "Everyone",
                                    "info": "More than one person uses this device.",
                                    "default": true,
                                }, {
                                    "id": 1,
                                    "title": "Jerry",
                                }, {
                                    "id": 2,
                                    "title": "Sally",
                                }, {
                                    "id": 3,
                                    "title": "Alison",
                                }]
                            }, {
                                "id": "family.type." + this.hosts[i].o.ipv4Addr,
                                "title": "Family Mode",
                                "info": "Turn on/off family mode",
                                "type": "select",
                                "size": {
                                    "width": 100,
                                    "height": 1
                                },
                                "values": [{
                                    "id": 0,
                                    "title": "Off",
                                    "default": true,
                                }, {
                                    "id": 1,
                                    "title": "On",
                                }]
                            }, {
                                "id": "block.type." + this.hosts[i].o.ipv4Addr,
                                "title": "Block Host Mode",
                                "info": "Block traffic in and out",
                                "type": "select",
                                "size": {
                                    "width": 100,
                                    "height": 1
                                },
                                "values": [{
                                    "id": 0,
                                    "title": "None",
                                    "default": true,
                                }, {
                                    "id": 1,
                                    "title": "Block Internet",
                                }]
                            }, {
                                "id": "monitor.type." + this.hosts[i].o.ipv4Addr,
                                "title": "Monitoring Mode",
                                "info": "Type to monitor",
                                "type": "select",
                                "size": {
                                    "width": 100,
                                    "height": 1
                                },
                                "values": [{
                                    "id": 0,
                                    "title": "Auto",
                                    "default": true,
                                }, {
                                    "id": 1,
                                    "title": "No Monitor",
                                }, ]
                            }]
                        }]
                    }

                    let name = this.hosts[i].name();
                    if (name) {
                        values['host.name.' + this.hosts[i].o.ipv4Addr] = name;
                    }
                    if (this.hosts[i].policy) {
                        let p = this.hosts[i].policy;
                        if (p.monitor != null) {
                            if (p.monitor == true) {
                                values['monitor.type.' + this.hosts[i].o.ipv4Addr] = 0;
                            } else {
                                values['monitor.type.' + this.hosts[i].o.ipv4Addr] = 1;
                            }
                        }
                        if (p.blockin != null && p.blockin == true) {
                            values['block.type.' + this.hosts[i].o.ipv4Addr] = 2;
                        } else if (p.blockout != null && p.blockout == true) {
                            values['block.type.' + this.hosts[i].o.ipv4Addr] = 1;
                        } else {
                            values['block.type.' + this.hosts[i].o.ipv4Addr] = 0;
                        }

                        if (p.family != null) {
                            if (p.family == true) {
                                values['family.type.' + this.hosts[i].o.ipv4Addr] = 1;
                            } else {
                                values['family.type.' + this.hosts[i].o.ipv4Addr] = 0;
                            }
                        }
                    }
                    arrayData.push(sections);
                }
                let datamodel = {
                    type: 'formview',
                    expires: Math.floor(Date.now() / 1000) + 60 * 5,
                    form: arrayData,
                    initialData: values
                };

                this.txData(this.primarygid, "hosts", datamodel, "jsondata", "jsondata", null);
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
        sysmanager.update((err, data) => {});


        this.hostManager = new HostManager();

        let c = require('../net2/MessageBus.js');
        this.subscriber = new c('debug');

        this.subscriber.subscribe("DiscoveryEvent", "DiscoveryStart", null, (channel, type, ip, msg) => {
            //this.tx(this.primarygid, "Discovery started","message");  
        });

        setTimeout(() => {
            this.scanStart();
            this.tx(this.primarygid, "NetBot is Ready" + "\n\n" + this.helpString(), "message");
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

    flows(listip) {
        // TODO: not consistent with current function declaration
        flowManager.summarizeConnections(listip, "in", '+inf', '-inf', "time", true, (err, result) => {
            console.log("--- Connectionby most recent ---");
            let max = 10;
            for (let i in result) {
                let s = result[i];
                console.log(flowManager.toStringShort(s));
                if (max-- < 0) {
                    break;
                }
            }
            flowManager.sort(result, 'rxdata');
            console.log("Sort by rx");
            max = 10;
            for (let i in result) {
                let s = result[i];
                console.log(flowManager.toStringShort(s));
                if (max-- < 0) {
                    break;
                }
            }
            flowManager.sort(result, 'txdata');
            console.log("Sort by tx");
            max = 10;
            for (let i in result) {
                let s = result[i];
                console.log(flowManager.toStringShort(s));
                if (max-- < 0) {
                    break;
                }
            }

        });
    }

    scanStart() {
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
                    //{"ts":1464491628.903598,"uid":"Cfob5G2syz5ExDYY3a","id.orig_h":"37.203.214.106","id.orig_p":51546,"id.resp_h":"192.168.2.192","id.resp_p":80,"seen.i
                    //ndicator":"37.203.214.106","seen.indicator_type":"Intel::ADDR","seen.where":"Conn::IN_ORIG","seen.node":"bro","sources":["from http://www.binarydefe
                    //nse.com/banlist.txt via intel.criticalstack.com"]}
                    /*
                    {"ts":1466353908.736661,"uid":"CYnvWc3enJjQC9w5y2","id.orig_h":"192.168.2.153","id.orig_p":58515,"id.resp_h":"98.124.243.43","id.resp_p":80,"seen.indicator":"streamhd24.com","seen
                    .indicator_type":"Intel::DOMAIN","seen.where":"HTTP::IN_HOST_HEADER","seen.node":"bro","sources":["from http://spam404bl.com/spam404scamlist.txt via intel.criticalstack.com"]}
                    */
                    let msg = null;
                    let reason = "";
                    if (obj.intel != null && obj.intel['reason'] != null) {
                        reason = obj.intel.reason;
                    }
                    if (obj['seen.indicator_type'] == "Intel::DOMAIN") {
                        //                msg = reason+". Device "+result[i].name()+": "+obj['id.orig_h']+" talking to "+obj['seen.indicator']+":"+obj['id.resp_p']+" source "+JSON.stringify(obj.sources)+" " +reason;
                        msg = reason + ". Device " + result[i].name() + ": " + obj['id.orig_h'] + " talking to " + obj['seen.indicator'] + ":" + obj['id.resp_p'] + ". (Reported by " + obj.intel.count + " sources)";
                    } else {
                        //               msg = reason+" "+result[i].name()+": "+obj['id.orig_h']+" talking to "+obj['id.resp_h']+":"+obj['id.resp_p']+" source "+JSON.stringify(obj.sources)+" " +reason;
                        msg = reason + " " + result[i].name() + ": " + obj['id.orig_h'] + " talking to " + obj['id.resp_h'] + ":" + obj['id.resp_p'] + ". (Reported by " + obj.intel.count + " sources)";
                    }
                    if (obj.intel && obj.intel.summary) {
                        // msg +="\n"+obj.intel.summary+"\n"+obj.intelurl;
                        msg += "\n" + obj.intelurl;
                    }

                    console.log("Sending Msg:", msg);

                    this.txQ(this.primarygid, msg, msg);
                });
                listip.push(result[i].o.ipv4Addr);
                if (result[i].ipv6Addr && result[i].ipv6Addr.length > 0) {
                    for (let j in result[i]['ipv6Addr']) {
                        listip.push(result[i]['ipv6Addr'][j]);
                    }
                }
            }

            // flows(listip);
        });

    }

    // commands
    //

    processJsonCmds(msg) {}

    msgHandler(gid, rawmsg) {
        //console.log("received message",JSON.stringify(rawmsg));

        if (rawmsg.mtype === "msg" && rawmsg.message.type === 'jsondata') {
            if (rawmsg.message.obj.type === "cmds") {
                this.processJsonCmds(rawmsg.message.obj);
            }
            if (rawmsg.message.obj.type === "formvalues") {
                let configs = {
                    host: {},
                    monitor: {},
                    block: {},
                    family: {}
                };
                for (let i in rawmsg.message.obj.formvalues) {
                    let v = rawmsg.message.obj.formvalues[i];
                    if (i.lastIndexOf('host.name.', 0) === 0) {
                        let ip = i.slice('host.name.'.length);
                        configs.host[ip] = {
                            name: v
                        };
                        console.log("host:", ip, configs.host[ip]);
                    }
                    if (i.lastIndexOf('family.type.', 0) === 0) {
                        let ip = i.slice('family.type.'.length);
                        configs.family[ip] = {
                            name: v
                        };
                        console.log("family", ip, configs.family[ip]);
                    }
                    if (i.lastIndexOf('monitor.type.', 0) === 0) {
                        let ip = i.slice('monitor.type.'.length);
                        configs.monitor[ip] = {
                            name: v
                        };
                        console.log("monitor", ip, configs.monitor[ip]);
                    }
                    if (i.lastIndexOf('block.type.', 0) === 0) {
                        let ip = i.slice('block.type.'.length);
                        configs.block[ip] = {
                            name: v
                        };
                        console.log("block:", ip, configs.block[ip]);
                    }
                }
                for (let j in this.hosts) {
                    let config = configs.host[this.hosts[j].o.ipv4Addr];
                    let ip = this.hosts[j].o.ipv4Addr;
                    if (config) {
                        if (config.name != null && config.name != this.hosts[j].o.name) {
                            this.hosts[j].o.name = config.name;
                            console.log("Changing names", config);
                            this.hosts[j].save().catch(err => {
                                console.log("Error saving config", config, err);
                            });
                        }
                    }

                    let mconfig = configs.monitor[this.hosts[j].o.ipv4Addr];
                    let bconfig = configs.block[this.hosts[j].o.ipv4Addr];
                    let fconfig = configs.family[this.hosts[j].o.ipv4Addr];

                    console.log("Reconfiguring: ", ip, mconfig, bconfig, fconfig);
                    if (mconfig != null) {
                        if (mconfig.name == 0) {
                            this._block(ip, "monitor", true, null);
                        } else if (mconfig.name == 1) {
                            this._block(ip, "monitor", false, null);
                        }
                    }
                    if (bconfig != null) {
                        if (bconfig.name == 0) {
                            this._block(ip, "blockin", false, null);
                            this._block(ip, "blockout", false, null);
                        } else if (bconfig.name == 1) {
                            this._block(ip, "blockout", true, null);
                            this._block(ip, "blockin", false, null);
                        } else if (bconfig.name == 2) {
                            this._block(ip, "blockout", false, null);
                            this._block(ip, "blockin", true, null);
                        }
                    }
                    if (fconfig != null) {
                        if (fconfig.name == 0) {
                            this._family(ip, false, null);
                        } else if (fconfig.name == 1) {
                            this._family(ip, true, null);
                        }
                    }
                }
            } else {
                console.log("Received value for form ", rawmsg.message.obj.formvalues);
            }
            this.tx(this.primarygid, "Done configuring ... ", "Done");
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

}

process.on("unhandledRejection", function (r, e) {
    console.log("Oh No! Unhandled rejection!! \nr::", r, "\ne::", e);
});

module.exports = netBot;
