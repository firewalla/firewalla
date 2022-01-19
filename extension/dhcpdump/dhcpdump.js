/*    Copyright 2016-2019 Firewalla Inc.
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

let instance = null;
let log = null;

const util = require('util');
const sysManager = require('../../net2/SysManager.js')

module.exports = class {
  constructor(loglevel) {
    if (instance == null) {
      log = require("../../net2/logger.js")(__filename, loglevel);
      instance = this;
    }
    return instance;
  }

  install(callback) {
    callback = callback || function () { }

    let install_cmd = util.format('cd %s; bash ./install.sh', __dirname);
    log.info("DHCPExtention:Install", install_cmd);
    require('child_process').exec(install_cmd, (err, out, code) => {
      if (err) {
        log.error("DHCPDUMP:INSTALL:Error", "Failed to execute script install.sh", err);
      } else {
        log.info("DHCPDUMP:INSTALL:Success", "DHCPDump is installed successfully");
      }

      callback(err, null);
    });
  }

  uninstall(callback) {
    // TODO
  }

  checkStatus(callback) {
    callback = callback || function () { }

    let cmd = util.format("ps aux | grep %s | grep -v grep", dnsmasqBinary);
    log.info("Command to check dnsmasq: ", cmd);

    require('child_process').exec(cmd, (err, stdout, stderr) => {
      if (stdout !== "") {
        callback(true);
      } else {
        callback(false);
      }
    });
  }

  processData(data, callback) {
    callback = callback || function () { }

  }

  /*
  OPTION:  57 (  2) Maximum DHCP message size 1500
  OPTION:  61 (  7) Client-identifier         01:c8:69:cd:09:95:4c
  OPTION:  50 (  4) Request IP address        192.168.2.232
  OPTION:  51 (  4) IP address leasetime      7776000 (12w6d)
  OPTION:  12 ( 12) Host name                 Great-Room-3
  */
  parseOptions2(output, options) {
    var i = 0;
    let eol = require('os').EOL;
    while (i < output.length) {
      var j = output.indexOf('\r', i + 1);
      if (j == -1) j = output.length;
      let str = output.substr(i, j - 1);
      i = j + 1;
    }
  }

  normalizeMac(mac) {
    mac = mac.toUpperCase();
    let items = mac.split(":");
    let items2 = items.map((item) => {
      if (item.length === 1) {
        return "0" + item;
      } else {
        return item;
      }
    });
    return items2.join(":");
  }

  parseEvents(output) {
    if (output == null) return []
    return output.split(/------------------------------------------------------------------------/)
      .map(e => this.parseEvent(e))
      .filter(e => e && e.mac)
  }

  parseEvent(output) {
    let o = output.split(/\r?\n/);
    let obj = {};

    for (let i in o) {
      let line = o[i];

      // locate mac address
      // from "IP: 0.0.0.0 (2:42:ac:11:0:2) > 255.255.255.255 (ff:ff:ff:ff:ff:ff)"
      let match = line.match("IP: .* \\((.*)\\) > 255.255.255.255");
      if (match) {
        obj.mac = this.normalizeMac(match[1])
      }

      // locate hostname
      let match2 = line.match("OPTION:.{1,9}12.{1,9}Host name +([^ ]+)");
      if (match2) {
        obj.name = match2[1]
      }

      // locate message type
      let match3 = line.match("OPTION:.{1,9}53.{1,9}DHCP message type +.{1,9}\\((.*)\\)");
      if (match3) {
        obj.mtype = match3[1];
      }
    }

    if (obj.mac && obj.name) {
      return obj
    } else if (obj.mac) {
      return obj
    } else {
      return {}
    }
  }

  async rawStart(callback) {
    callback = callback || function () { }
    const interfaces = sysManager.getMonitoringInterfaces();
    const textDecoder = new util.TextDecoder('utf8',{
      fatal:true, // decoding failures are fatal
    })
    const StringDecoder = require('string_decoder').StringDecoder;
    const decoder = new StringDecoder('utf8');
    for (const intf of interfaces) {
      if (!intf.name) continue;
      if (intf.name.endsWith(":0")) continue; // do not listen on interface alias since it is not a real interface
      if (intf.name.includes("vpn")) continue; // do not listen on vpn interface
      let spawn = require('child_process').spawn;
      let dhcpdumpSpawn = spawn('sudo', ['dhcpdump', '-i', intf.name]);
      let pid = dhcpdumpSpawn.pid;

      log.info("DHCPDump started with PID: ", pid);

      dhcpdumpSpawn.stdout.on('data', (data) => {
        log.debug("Found a dhcpdiscover request");
        let message = decoder.write(data);
        let ignoreName = false;
        try {
          const test = textDecoder.decode(data);
        } catch (e) {
          ignoreName = true;
          log.warn('The encoded data was not valid for encoding utf-8');
        }
        this.parseEvents(message).map(e => {
          if (e) {
            e.intf_mac = intf.mac_address;
            e.intf_uuid = intf.uuid;
            e.ignoreName = ignoreName;
          }
          callback(e)
        })
      });

      dhcpdumpSpawn.stderr.on('data', (data) => {
        log.error("Got error when running dhcp: ", data.toString());
      });

      dhcpdumpSpawn.on('close', (code) => {
        log.info("DHCPDump exited with error code: ", code);
      });
    }
  }

  rawStop(callback) {
    callback = callback || function () { }

    //to be safe, kill all dhcpdumps
    require('child_process').exec("sudo pkill dhcpdump", (errorCode, stdout, stderr) => {
    });
  }

  start(force, callback) {
    let cmdline = 'sudo pkill -f dhcpdump';
    let p = require('child_process').exec(cmdline, (err, stdout, stderr) => {
      // if(err) {
      //   log.error("Failed to clean up spoofing army: " + err);
      // }
      this.rawStart(callback);
    });
  }

  stop(callback) {
  }

  restart(callback) {
  }

};
