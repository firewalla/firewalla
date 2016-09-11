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

    spoof(ipAddr, tellIpAddr, mac, callback) {
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
                    this.spoof(ipAddr, tellIpAddr, mac, callback);
                }, 60000);
            }
        });
    }

    _spoof(ipAddr, tellIpAddr, mac, callback) {
        if (ipAddr == tellIpAddr) {
            log("Can't spoof self to self", ipAddr, tellIpAddr);
            if (callback) callback("error", null);
            return;
        }

        if (this.spoofers[ipAddr + tellIpAddr] != null) {
            if (callback) callback("error", null);
            return;
        }

        let cmdline = "sudo ../bin/bitbridge4 " + ipAddr + " -t " + tellIpAddr + " -r";

        log("Executing cmdline ", cmdline);

        let task = require('child_process').exec(cmdline, (err, out, code) => {
            if (callback)
                callback(err, null);
        });


        this.spoofers[ipAddr + tellIpAddr] = {
            ip: ipAddr,
            tellIpAddr: tellIpAddr,
            task: task,
            adminState: 'up',
        };

        task.stderr.on('data', function (data) {});

        task.on('data', (data) => {});

        task.stdout.on('data', (data) => {});

        task.on('close', (code) => {
            if (this.spoofers[ipAddr + tellIpAddr]) {
                this.spoofers[ipAddr + tellIpAddr].task = null;
            }
        });

        task.on('exit', (code) => {
            if (this.spoofers[ipAddr + tellIpAddr]) {
                this.spoofers[ipAddr + tellIpAddr].task = null;
            }
        });

        //log("Spoof:Spoof:",ipAddr,tellIpAddr);
    }

    unspoof(ipAddr, tellIpAddr) {
        let task = this.spoofers[ipAddr + tellIpAddr];
        log("Spoof:Unspoof", ipAddr, tellIpAddr);
        if (task != null && task.task != null) {
            task.task.kill('SIGHUP');
            this.clean(task.ip);
            this.spoofers[ipAddr + tellIpAddr] = null
        } else {
            this.clean(ipAddr);
            this.spoofers[ipAddr + tellIpAddr] = null
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

    constructor(intf, config, clean, debug) {
        debugging = debug;

        // Warning, should not clean default ACL's applied to ip tables
        // there is one applied for ip6 spoof, can't be deleted
        if (clean == true) {
            this.clean();
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
