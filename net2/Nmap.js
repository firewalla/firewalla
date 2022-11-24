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

const util = require('util');

const Firewalla = require('./Firewalla.js');
const networkTool = require('./NetworkTool.js')();
const Promise = require('bluebird');

var debugging = false;
// var log = function () {
//     if (debugging) {
//         log.info(Array.prototype.slice.call(arguments));
//     }
// };

let log = require('./logger.js')(__filename, 'info');

let xml2jsonBinary =
  Firewalla.getFirewallaHome() +
  '/extension/xml2json/xml2json.' +
  Firewalla.getPlatform();

module.exports = class {
  // ID can be port
  constructor(range, debug) {
    this.range = range;
    this.scanQ = [];
    debugging = debug;
  }

  parsePort(hostuid, portjson) {
    let port = {};
    log('PARSING: ', portjson);
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

  scanQueue(obj) {
    if (obj) {
      this.nmapScan(obj.cmdline, true, (err, hosts, ports) => {
        obj.callback(err, hosts, ports);
        if (this.scanQ.length) log.info('NMAP:ScanQUEUE', this.scanQ);
        this.scanQueue(this.scanQ.pop());
      });
    }
  }

  async neighborSolicit(ipv6Addr) {
    return new Promise((resolve, reject) => {
      if (ip.isV4Format(ipv6Addr) || !ip.isV6Format(ipv6Addr)) {
        resolve(null);
      }
  
      const cmd = util.format('sudo timeout 1200s nmap -6 -PR -sn %s -oX - | %s', ipv6Addr, xml2jsonBinary);
      log.info('Running neighbor solicitation: ', cmd);
  
      this.scanQ.push({cmdline: cmd, fast: true, callback: (err, hosts, ports) => {
        if (err) {
          reject(err);
        } else {
          for (let i in hosts) {
            const host = hosts[i];
            if (host.mac) {
              resolve(host.mac);
              return;
            }
          }
          resolve(null);
        }
      }});
  
      let obj = this.scanQ.pop();
      this.scanQueue(obj);
    })
  }

  scan(range /*Must be v4 CIDR*/, fast, callback) {
    if (!range || !ip.isV4Format(range.split('/')[0])) {
      callback(null, [], []);
      return;
    }

    try {
      range = networkTool.capSubnet(range)
    } catch (e) {
      log.error('Nmap:Scan:Error', range, fast, e);
      callback(e);
      return;
    }

    let cmdline = fast
      ? util.format(
          'sudo timeout 1200s nmap -sn -PO --host-timeout 30s  %s -oX - | %s',
          range,
          xml2jsonBinary
        )
      : util.format(
          'sudo timeout 1200s nmap -sU --host-timeout 200s --script nbstat.nse -p 137 %s -oX - | %s',
          range,
          xml2jsonBinary
        );

    log.info('Running commandline: ', cmdline);

    if (this.scanQ.length > 3) {
      callback('Queuefull', null, null);
      log.info('======================= Warning Previous instance running====');
      return;
    }

    this.scanQ.push({cmdline: cmdline, fast: fast, callback: callback});

    let obj = this.scanQ.pop();
    this.scanQueue(obj);
  }

  // ports are not returned
  scanAsync(range, fast) {
    return util.promisify(this.scan).bind(this)(range, fast)
  }

  nmapScan(cmdline, requiremac, callback) {
    this.process = require('child_process').exec(
      cmdline,
      (err, stdout, stderr) => {
        if (err) {
          log.error('Failed to nmap scan:', err, 'stderr:', stderr);
          callback(err);
          return;
        }

        let findings = null;
        try {
          findings = JSON.parse(stdout);
        } catch (err) {
          callback(err);
          return;
        }

        if (!findings) {
          callback(null, [], []);
          return;
        }

        let hostsJSON = findings.nmaprun && findings.nmaprun.host;

        if (!hostsJSON) {
          // skip if finding is invalid
          callback(null, [], []);
          return;
        }

        if (hostsJSON.constructor !== Array) {
          hostsJSON = [hostsJSON];
        }

        let hosts = [];
        let ports = [];
        for (let a in hostsJSON) {
          try {
            let hostjson = hostsJSON[a];
            let host = {};
            if (
              hostjson.hostnames &&
              hostjson.hostnames.constructor == Object
            ) {
              host.hostname = hostjson.hostnames.hostname.name;
              host.hostnameType = hostjson.hostnames.hostname.type;
            }
            /*
                    log.info(hostjson.hostnames);
                    if (hostjson.hostnames && Array.isArray(hostjson.hostname) && hostjson.hostname.length>0) {
                        host.hostname = hostjson.hostnames[0].hostname.name;
                        host.hostnameType = hostjson.hostnames[0].hostname.type;
                    }
                    */

            let ipaddr = '';
            for (let h in hostjson['address']) {
              let addr = hostjson['address'][h];
              if (addr['addrtype'] == 'ipv4') {
                host.ipv4Addr = addr.addr;
                ipaddr = addr.addr;
              } else if (addr['addrtype'] == 'mac') {
                host.mac = addr.addr;
                if (addr.vendor != null) {
                  host.macVendor = addr.vendor;
                } else {
                  host.macVendor = 'Unknown';
                }
              }
            }

            if (host.mac == null && requiremac == true) {
              log.info('skipping host, no mac address', host);
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
              host['os_class'] = JSON.stringify(
                hostjson['os']['osmatch']['osclass']
              );
            }

            if (hostjson['uptime']) {
              host['uptime'] = hostjson['uptime']['seconds'];
            }

            try {
              if (hostjson.hostscript) {
              }
              if (
                hostjson.hostscript &&
                hostjson.hostscript.script &&
                hostjson.hostscript.script.id == 'nbstat'
              ) {
                let scriptout = hostjson.hostscript.script;
                if (scriptout.elem) {
                  for (let i in scriptout.elem) {
                    if (scriptout.elem[i].key == 'server_name') {
                      host.nname = scriptout.elem[i]['_'];
                      break;
                    }
                  }
                }
              }
            } catch (e) {
              log.info('Discovery:Nmap:Netbios:Error', e, host);
            }

            hosts.push(host);
          } catch (e) {}
        }
        callback(null, hosts, ports);
      }
    );
    this.process.on('close', (code, signal) => {
      log.debug('NMAP Closed');
      this.process = null;
    });
  }
};
