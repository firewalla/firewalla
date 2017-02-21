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

var spawn = require('child_process').spawn;
var StringDecoder = require('string_decoder').StringDecoder;
var ip = require('ip');

var instance = null;

var debugging = false;
var log = function () {
    if (debugging) {
        console.log(Array.prototype.slice.call(arguments));
    }
};

module.exports = class {

    getMAC(ipaddress, cb) {
        var arp = spawn("/usr/sbin/arp", ["-n", ipaddress]);
        var buffer = '';
        var errstream = '';
        arp.stdout.on('data', (data) => {
            buffer += data;
        });
        arp.stderr.on('data', (data) => {
            errstream += data;
        });

        arp.on('close', (code) => {
            if (code !== 0) {
                log("Error running arp " + code + " " + errstream);
                spawn('/bin/ping', [ipaddress, '-c', 2]);
                cb(true, code);
                return;
            }
            var table = buffer.split('\n');
            if (table.length >= 2 && table[1].length > 10) {
                var parts = table[1].split(' ').filter(String);
                log("GETMAC:PARTS:",table,parts);
                cb(false, parts[2]);
                if (parts[2] == null) {}
                return;
            }
            //log("Could not find ip in arp table"+ipaddress);
            cb(true, "Could not find ip in arp table: " + ipaddress);
            spawn('/bin/ping', [ipaddress, '-c', 2]);
        });

    }

    spoof(ipAddr, tellIpAddr, mac, ip6Addrs, gateway6, callback) {
      log("Spoof:Spoof:Ing",ipAddr,tellIpAddr,mac,ip6Addrs,gateway6);
      if (ipAddr && tellIpAddr) {
        if (ipAddr == tellIpAddr) {
            log("Can't spoof self to self", ipAddr, tellIpAddr);
            if (callback) callback("error", null);
            return;
        }

        if (this._spoofersFind(mac,ipAddr,'v4',tellIpAddr)) {
            if (callback) callback("error", null);
            return;
        }

        this.getMAC(ipAddr, (err, _mac) => {
            if (_mac) {
                _mac = _mac.toUpperCase();
            }
            if (err == false && _mac != null && _mac.match("^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$") != null && _mac == mac) {
                //log("Got mac ipAddr",ipAddr," with mac ", mac);
                log("Spoof:Spoof", ipAddr + " " + tellIpAddr + " " + mac + " " + _mac);
                this._spoof(ipAddr, tellIpAddr, mac, callback);
            } else {
                // this will be better to tie up with nmap,
                // scans.  then msg through a channel 
                // 
                //log("Host not there exist, waiting", ipAddr,err,mac);
                if (_mac != mac) {
                    log("Spoof:Spoof:Error:Mac", _mac + ":" + mac);
                }
                setTimeout(() => {
                    this.spoof(ipAddr, tellIpAddr, mac, null,null,callback);
                }, 60000);
            }
        });
      }
      
      this.spoofMac6(mac,ip6Addrs,gateway6,callback);
    }

    _spoofersFind(mac,ip,version,gateway) {
        if (this.spoofers[mac]) {
            return this.spoofers[mac][version][ip];
        }
        return null;
    }

    _spoofersAdd(mac,ip,version,gateway,obj) {
        if (this.spoofers[mac] == null) {
            this.spoofers[mac] = {};
            this.spoofers[mac]['v6'] = {};
            this.spoofers[mac]['v4'] = {};
        }
        this.spoofers[mac][version][ip] = obj;
    }

    spoofMac6(mac,ipv6Addrs,gateway,callback) {
        let newips = [];
        let removals = [];
        let ipv6db = {};
        if (mac == null || ipv6Addrs==null || ipv6Addrs.length==0) {
            return;
        }

        for (let i in ipv6Addrs) {
            ipv6db[ipv6Addrs[i]]=1; 
            if (null == this._spoofersFind(mac,ipv6Addrs[i],'v6',gateway)) {
                newips.push(ipv6Addrs[i]);
                console.log("Spoof:AddNew",ipv6Addrs[i]);
            }
        }

        if (this.spoofers[mac]) {
            for (let j in this.spoofers[mac]['v6']) {
                if (ipv6db[j]==null) {
                   removals.push(j);
                   console.log("Spoof:Remove",j);
                }
            }
        }

        console.log("Spoof:Spoof:new",newips,"removals", removals);

        if (removals.length>0) {
            this.unspoof(null,null,mac,removals,gateway);
        }
        if (newips.length>0 && gateway) {
            let maxv6spoof = 5;
            for (let i in newips) {
                this._spoof6(newips[i],gateway,mac);
                maxv6spoof-- ;
                if (maxv6spoof==0) {
                    if (callback) {
                        callback(err);
                    }
                    return;
                }
            }
        }
        if (callback) {
            callback(err);
        }
    }

    _spoof6(ip6Addr, tellIpAddr, mac,callback) {
        console.log("Spoof:Spoof6",ip6Addr,tellIpAddr);
      //  if (ip6Addr == tellIpAddr || ip6Addr.startsWith("fe80") ) {
        if (ip6Addr == tellIpAddr ) {
            log("Can't spoof self to self", ip6Addr, tellIpAddr);
            if (callback) callback("error", null);
            return;
        }         
        if (this._spoofersFind(mac,ip6Addr,'v6',tellIpAddr) != null) {
            if (callback) callback("error", null);
            return;
        }
        let task = null;
        let cmdline = "sudo ../bin/bitbridge6a -r -w 1 eth0 " + tellIpAddr +" "+  ip6Addr;
        if (ip6Addr.startsWith("fe80")) {
            task = require('child_process').exec(cmdline, (err, out, code) => {
            });
        }
        let taskr = null;
        let cmdline2 = "sudo ../bin/bitbridge6a  -w 1  eth0 " + ip6Addr +" "+ tellIpAddr;
        if (!ip6Addr.startsWith("fe80")) { 
            let taskr = require('child_process').exec(cmdline2, (err, out, code) => {
            });
        }
        log(cmdline,cmdline2);
        this._spoofersAdd(mac,ip6Addr,'v6',tellIpAddr, {
            ip6: ip6Addr,
            tellIpAddr: tellIpAddr,
            task: task,
            taskr: taskr,
            adminState: 'up',
        });
    }

    _spoof(ipAddr, tellIpAddr, mac, callback) {
        if (ipAddr == tellIpAddr) {
            log("Can't spoof self to self", ipAddr, tellIpAddr);
            if (callback) callback("error", null);
            return;
        }

        if (this._spoofersFind(mac,ipAddr,'v4',tellIpAddr)) {
            if (callback) callback("error", null);
            return;
        }

        let cmdline = "sudo ../bin/bitbridge4 " + ipAddr + " -t " + tellIpAddr + " -r";

        log("Executing cmdline ", cmdline);

        let task = require('child_process').exec(cmdline, (err, out, code) => {
            if (callback)
                callback(err, null);
        });


        this._spoofersAdd(mac,ipAddr,'v4',tellIpAddr,{
            ip: ipAddr,
            tellIpAddr: tellIpAddr,
            task: task,
            adminState: 'up',
        });

        task.stderr.on('data', function (data) {});

        task.on('data', (data) => {});

        task.stdout.on('data', (data) => {});

        task.on('close', (code) => {
            this._spoofersAdd(mac,ipAddr,'v4',tellIpAddr,null);
        });

        task.on('exit', (code) => {
            this._spoofersAdd(mac,ipAddr,'v4',tellIpAddr,null);
        });

        //log("Spoof:Spoof:",ipAddr,tellIpAddr);
    }

    _unspoof6(ipAddr, tellIpAddr,mac) {
        let task = this._spoofersFind(mac,ipAddr,'v6',tellIpAddr);
        log("Spoof:Unspoof6", ipAddr, tellIpAddr,task);
        if (task && task.task) {
           task.task.kill('SIGHUP');
        }
        if (task && task.taskr) {
           task.taskr.kill('SIGHUP');
        }
        this.clean6byIp(ipAddr,tellIpAddr);
        this._spoofersAdd(mac,ipAddr,'v6',tellIpAddr,null);
    }

    _unspoof(ipAddr, tellIpAddr,mac) {
        let task = this._spoofersFind(mac,ipAddr,'v4',tellIpAddr);
        log("Spoof:Unspoof", ipAddr, tellIpAddr);
        if (task != null && task.task != null) {
            task.task.kill('SIGHUP');
            this.clean(task.ip);
            this._spoofersAdd(mac,ipAddr,'v4',tellIpAddr,null);
        } else {
            this.clean(ipAddr);
            this._spoofersAdd(mac,ipAddr,'v4',tellIpAddr,null);
        }
    }
    unspoof(ipAddr, tellIpAddr, mac, ip6Addrs, gateway6) {
        log("Spoof:Unspoof", ipAddr, tellIpAddr,mac,ip6Addrs,gateway6);
        if (ipAddr && tellIpAddr) {
           this._unspoof(ipAddr,tellIpAddr,mac);
        }
        let maxSpoofer = 5;
        if (ip6Addrs && ip6Addrs.length>0 && gateway6) {
            for (let i in ip6Addrs) {
                this._unspoof6(ip6Addrs[i],gateway6,mac);
            }
        }
    }

    clean(ip) {
        //let cmdline = 'sudo nmap -sS -O '+range+' --host-timeout 400s -oX - | xml-json host';
        let cmdline = 'sudo pkill -f bitbridge4';
        if (ip != null) {
            cmdline = "sudo pkill -f 'bitbridge4 " + ip + "'";
        }
        console.log("Spoof:Clean:Running commandline: ", cmdline);

        let p = require('child_process').exec(cmdline, (err, out, code) => {
            console.log("Spoof:Clean up spoofing army", cmdline, err, out);
        });
    }

    clean6byIp(ip6Addr,tellIpAddr) {
        let cmdline = "sudo pkill -f 'bitbridge6a -r -w 1 eth0 " + tellIpAddr +" "+  ip6Addr+"'";
        let cmdline2 = "sudo pkill -f 'bitbridge6a  -w 1  eth0 " + ip6Addr +" "+ tellIpAddr+"'";
        let p = require('child_process').exec(cmdline, (err, out, code) => {
            console.log("Spoof:Clean up spoofing army", cmdline, err, out);
        });
        let p2 = require('child_process').exec(cmdline2, (err, out, code) => {
            console.log("Spoof:Clean up spoofing army", cmdline, err, out);
        });
    }

    clean6(ip) {
        //let cmdline = 'sudo nmap -sS -O '+range+' --host-timeout 400s -oX - | xml-json host';
        let cmdline = 'sudo pkill -f bitbridge6a';
        if (ip != null) {
            cmdline = "sudo pkill -f 'bitbridge6a " + ip + "'";
        }
        console.log("Spoof:Clean:Running commandline: ", cmdline);

        let p = require('child_process').exec(cmdline, (err, out, code) => {
            console.log("Spoof:Clean up spoofing army", cmdline, err, out);
        });
    }

    constructor(intf, config, clean, debug) {
        debugging = debug;

        // Warning, should not clean default ACL's applied to ip tables
        // there is one applied for ip6 spoof, can't be deleted
        if (clean == true) {
            this.clean();
            this.clean6();
        }
        if (instance == null) {
            this.config = config;
            this.spoofers = {};
            this.intf = intf;

            if (config == null || config.gateway == null) {
                this.gateway = "192.168.1.1"
            } else {
                this.gateway = config.gateway;
            }
            instance = this;
        } else {
            return instance;
        }
    }

}
