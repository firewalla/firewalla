#!/usr/bin/env node

/*
 * Features
 *  - get host list
 *  - get host information
 *  
 */

'use strict'
var fs = require('fs');
var program = require('commander');
var HostManager = require('../net2/HostManager.js');
var sysmanager = require('../net2/SysManager.js');
var FlowManager = require('../net2/FlowManager.js');
var flowManager = new FlowManager('error');

program.version('0.0.2')
    .option('--host [host]', 'configuration')
    .option('--flows', '(optional) name')
    .option('--spoof', '(optional) name')
    .option('--pasthours [pasthours]', '(optional) name')
    .option('--hours [hours]', '(optional) name')
    .option('--interface [interface]', '(optional) name')
    .option('--notice ', '(optional) endpoint')
    .option('--maxcount [recent]', '(optional) endpoint')
    .option('--dynaflow [dynaflow]', '(optional) endpoint') //dynamic flow listings, sorted by time

program.parse(process.argv);
let ip = null;

if (program.interface) {
    config.discovery.networkInterfaces = [program.interface];
}

let hours = 100;
let end = "+inf";
let start = "-inf";
if (program.hours) {
    hours = Number(program.hours);
}

let maxcount = 10;
if (program.maxcount) {
    maxcount = program.maxcount;
}

let pasthours = 8;

if (program.pasthours) {
    pasthours = program.pasthours;
}

let now = Date.now() / 1000;
end = now;
start = now - Number(pasthours) * 60 * 60;


let config = {
    discovery: {
        networkInterfaces: ["eth0", "wlan0"],
    },
    monitoringInterface: 'eth0',
    bro: {
        notice: {
            monitor: {},
            ignore: {
                "SSL::Invalid_Server_Cert": "ignore",
                "PacketFilter::Dropped_Packets": "ignore",
            },
            path: "/blog/current/notice.log",
            expires: 86400 * 7,
        },
        intel: {
            path: "/blog/current/intel.log",
            expires: 86400 * 7,
            ignore: {
                'none': 'ignore',
            },
        },
        dns: {
            path: "/blog/current/dns.log",
            expires: 86400 * 1,
        },
        software: {
            path: "/blog/current/software.log",
            expires: 86400 * 7,
        },
        http: {
            path: "/blog/current/http.log",
            expires: 60 * 60 * 1,
        },
        ssl: {
            path: "/blog/current/ssl.log",
            expires: 86400 * 2,
        },
        conn: {
            path: "/blog/current/conn.log",
            //         flowstashExpires: 3600,
            flowstashExpires: 1800,
            //         flowstashExpires: 60*5,
            expires: 86400 * 1,
        },
        ssh: {
            path: "/blog/current/ssh.log",
            expires: 86400 * 1,
        },
        x509: {
            path: "/blog/current/x509.log",
            expires: 60 * 60 * 12,
        },
        userAgent: {
            expires: 86400 * 7,
        }


    }
};

sysmanager.update(null);

console.log("Mutlicast Test", sysmanager.isMulticastIP("223.0.0.1"));

var watcher = new HostManager();

let c = require('../net2/MessageBus.js');
this.subscriber = new c('debug');

this.subscriber.subscribe("DiscoveryEvent", "DiscoveryStart", null, (channel, ip, msg) => {
    console.log("Discovery Started");
});

function flows(listip, direction) {
  // TODO: not consistent with current function declaration
    flowManager.summarizeConnections(listip, direction, end, start, "time", hours, true, (err, result,activities) => {
        console.log("--- Connectionby most recent ---", result.length);
        let max = 1000;
        if (program.dynaflow) {
            max = 100;
        }
        for (let i in result) {
            let s = result[i];
            if (program.dynaflow) {
                console.log(s.dhname);
            } else {
                console.log(flowManager.toStringShort(s));
            }
            if (max-- < 0) {
                break;
            }
        }
        flowManager.sort(result, 'rxdata');
        console.log("-----------Sort by rx------------------------");
        max = 10;
        for (let i in result) {
            let s = result[i];
            console.log(flowManager.toStringShort(s));
            if (max-- < 0) {
                break;
            }
        }
        flowManager.sort(result, 'txdata');
        console.log("-----------  Sort by tx------------------");
        max = 10;
        for (let i in result) {
            let s = result[i];
            console.log(flowManager.toStringShort(s));
            if (max-- < 0) {
                break;
            }
        }

        if (direction == 'in')
            flows(listip, 'out');

        console.log("Contacting FlowManager");
        flowManager.getFlowCharacteristics(result, direction, 1000000, 2);
        console.log("--------- Activities -----");
        console.log(JSON.stringify(activities));
    });
}

setTimeout(() => {
    if (program.host == null) {
        watcher.getHosts((err, result) => {
            let listip = [];
            flowManager.summarizeBytes(result, end, start, (end - start) / 16, (err, sys) => {
                console.log("System Rx", sys);
                for (let i in result) {
                    console.log(result[i].toShortString(), result[i].flowsummary);
                    result[i].on("Notice:Detected", (type, ip, obj) => {
                        console.log("=================================");
                        console.log("Notice :", type, ip, obj);
                        console.log("=================================");
                    });
                    result[i].on("Intel:Detected", (type, ip, obj) => {
                        console.log("=================================");
                        console.log("Notice :", type, ip, obj);
                        console.log("=================================");
                    });
                    if (program.spoof) {
                        result[i].spoof(true);
                    }
                    listip.push(result[i].o.ipv4Addr);
                    if (result[i].ipv6Addr && result[i].ipv6Addr.length > 0) {
                        for (let j in result[i]['ipv6Addr']) {
                            listip.push(result[i]['ipv6Addr'][j]);
                        }
                    }
                }
                flows(listip, 'in');

            });

        });
    } else {
        ip = program.host;

        console.log("Looking up host ", ip);
        watcher.getHost(ip, (err, result2) => {
            result2.getHost(ip, (err, result) => {
                console.log(result.toShortString());
                result.on("Notice:Detected", (channel, message) => {
                    console.log("============== Notice ======");
                    console.log(channel, message);
                });

                console.log("--- Software by count ---");
                for (let i in result.softwareByCount) {
                    //    console.log(result.softwareByCount[i].toShortString);
                    let s = result.softwareByCount[i];
                    console.log(s.name + "\t" + s.count + "\t" + s.lastActiveTimestamp);

                }
                console.log("--- Software by most recent ---");
                for (let i in result.softwareByCount) {
                    //    console.log(result.softwareByCount[i].toShortString);
                    let s = result.softwareByCount[i];
                    console.log(s.name + "\t" + s.count + "\t" + s.lastActiveTimestamp);

                }
                console.log("--- Connectionby most recent ---");
                let listp = [];
                listp.push(result.o.ipv4Addr);
                if (result.ipv6Addr && result.ipv6Addr.length > 0) {
                    for (let j in result.ipv6Addr) {
                        listp.push(result.ipv6Addr[j]);
                    }
                }

                flows(listp, 'in');

                if (program.spoof) {
                    result.spoof(true);
                }


            });
        });
    }
}, 2000);
