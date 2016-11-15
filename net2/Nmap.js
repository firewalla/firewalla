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

var debugging = false;
var log = function () {
    if (debugging) {
        console.log(Array.prototype.slice.call(arguments));
    }
};

module.exports = class {

    // ID can be port
    constructor(range, debug) {
        this.range = range;
        debugging = debug;
    }

    //sudo nmap -sS -O 192.168.2.100-200 -oX - | xml-json host
    /* 
                   uid: Sequelize.STRING,
                name: Sequelize.STRING,
                lastActiveTimestamp: Sequelize.DOUBLE,
                firstFoundTimestamp: Sequelize.DOUBLE,
                ipv4Addr: Sequelize.STRING,
                ipv6Addr: Sequelize.STRING,
                mac: Sequelize.STRING,
                macVendor: Sequelize.STRING,
                hostname: Sequelize.STRING,
                hostnameType: Sequelize.STRING,
                description: Sequelize.STRING,
                ustate: Sequelize.STRING,

                stats: Sequelize.TEXT,
                json: Sequelize.TEXT,
                rawScanJson: Sequelize.TEXT,
   */
    /*
                    hostId: Sequelize.STRING,
                uid: Sequelize.STRING,
                protocol: Sequelize.STRING,
                port: Sequelize.INT,
                state: Sequelize.STRING,
                ustate: Sequelize.STRING,
                serviceName: Sequelize.STRING,
                lastActiveTimestamp: Sequelize.DOUBLE;
                firstFoundTimestamp: Sequelize.DOUBLE;

                stats: Sequelize.TEXT,
                json: Sequelize.TEXT,
                rawScanJson: Sequelize.TEXT,
 */

    parsePort(hostuid, portjson) {
        let port = {};
        log("PARSING: ", portjson);
        port.protocol = portjson.protocol;
        port.hostId = hostuid;
        port.uid = hostuid + '.' + portjson.portid;
        port.portid = portjson.portid;
        if (portjson['service']) {
            port.serviceName = portjson['service']['name'];
            port.lastActiveTimestamp = Date.now() / 1000;
        }
        if (portjson['state']) {
            port.state = portjson['state']['state'];
        }
        return port;
    }

    scan(range, fast, callback) {
        //let cmdline = 'sudo nmap -sS -O '+range+' --host-timeout 400s -oX - | xml-json host';
        let cmdline = 'sudo nmap -sU --host-timeout 200s --script nbstat.nse -p 137 --disable-arp-ping ' + range + ' -oX - | xml-json host';
        // let cmdline = 'sudo nmap -T5 -PO --host-timeout 200s  --disable-arp-ping ' + range + ' -oX - | xml-json host'; 
        // let    cmdline = 'sudo nmap -sn -PO  --host-timeout 20s --disable-arp-ping '+range+' -oX - | xml-json host';
        if (fast == true) {
            cmdline = 'sudo nmap -sn -PO --host-timeout 20s  --disable-arp-ping ' + range + ' -oX - | xml-json host';
        }
        console.log("Running commandline: ", cmdline);

        if (this.process) {
            //this.process.kill('SIGHUP'); 
            //this.process = null; 
            console.log("======================= Warning Previous instance running====");
            return;
        }

        this.nmapScan(cmdline,callback);
     }

     nmapScan(cmdline,callback) {

        this.process = require('child_process').exec(cmdline, (err, out, code) => {
            let outarray = out.split("\n");
            let hosts = [];
            let ports = [];
            for (let a in outarray) {
                try {
                    let hostjson = JSON.parse(outarray[a]);
                    let host = {};
                    if (hostjson.hostnames && hostjson.hostnames.constructor == Object) {
                        host.hostname = hostjson.hostnames.hostname.name;
                        host.hostnameType = hostjson.hostnames.hostname.type;
                    }
                    /*
                    console.log(hostjson.hostnames);
                    if (hostjson.hostnames && Array.isArray(hostjson.hostname) && hostjson.hostname.length>0) {
                        host.hostname = hostjson.hostnames[0].hostname.name;
                        host.hostnameType = hostjson.hostnames[0].hostname.type;
                    }
                    */

                    let ipaddr = "";
                    for (let h in hostjson['address']) {
                        let addr = hostjson['address'][h];
                        if (addr['addrtype'] == 'ipv4') {
                            host.ipv4Addr = addr.addr;
                            ipaddr = addr.addr;
                        } else if (addr['addrtype'] == 'mac') {
                            host.mac = addr.addr;
                            if (addr.vendor != null) {
                                host.macVendor = addr.vendor;
                            }
                        }
                    }

                    if (host.mac == null) {
                        console.log("skipping host, no mac address", host);
                        continue;
                    }

                    host.uid = ipaddr;
                    let now = Date.now() / 1000;
                    host.lastActiveTimestamp = now;
                    host.firstFoundTimestamp = now;

                    if (hostjson['ports']) {
                        if (Array.isArray(hostjson['ports']['port'])) {
                            for (let i in hostjson['ports']['port']) {
                                let portjson = hostjson['ports']['port'][i];
                                let port = this.parsePort(host.uid, portjson);
                                if (port) {
                                    log(port);
                                    ports.push(port);
                                }
                            }
                        } else {
                            let port = this.parsePort(host.uid, hostjson['ports']['port']);
                            if (port) {
                                log(port);
                                ports.push(port);
                            }
                        }
                    }

                    if (hostjson['os'] && hostjson['os']['osmatch']) {
                        host['os_match'] = hostjson['os']['osmatch']['name'];
                        host['os_accuracy'] = hostjson['os']['osmatch']['accuracy'];
                        host['os_class'] = JSON.stringify(hostjson['os']['osmatch']['osclass']);
                    }

                    if (hostjson['uptime']) {
                        host['uptime'] = hostjson['uptime']['seconds'];
                    }

                    try {
                        if (hostjson.hostscript) {
                        }
                        if (hostjson.hostscript && hostjson.hostscript.script && hostjson.hostscript.script.id == "nbstat") {
                            let scriptout = hostjson.hostscript.script;
                            if (scriptout.elem) {
                                for (let i in scriptout.elem) {
                                    if (scriptout.elem[i].key == "server_name") {
                                        host.nname = scriptout.elem[i]["_"];
                                        break;
                                    }
                                }
                            }
                        }
                    } catch(e) {
                        console.log("Discovery:Nmap:Netbios:Error",e,host);
                    }

                    hosts.push(host);
                } catch (e) {}
            }
            callback(null, hosts, ports);
        });
        this.process.on('close', (code, signal) => {
            console.log("NMAP Closed");
            this.process = null;
        });
    }
}
