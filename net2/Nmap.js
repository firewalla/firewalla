/*    Copyright 2016-2024 Firewalla Inc.
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
const log = require('./logger.js')(__filename);

const net = require('net')
const util = require('util');

const { buildDeferred } = require('../util/asyncNative.js')
const Firewalla = require('./Firewalla.js');
const networkTool = require('./NetworkTool.js')();
const Message = require('../net2/Message.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const LRU = require('lru-cache');

const hitCache = new LRU({maxAge: 600000});
const missCache = new LRU({maxAge: 60000});

sem.on(Message.MSG_MAPPING_IP_MAC_DELETED, event => {
  const { ip, mac, fam } = event
  if (mac && ip && fam == 6) {
    if (hitCache.peek(ip) == mac)
      hitCache.del(ip)
    if (missCache.peek(ip) == mac)
      missCache.del(ip)
  }
})

var debugging = false;
// var log = function () {
//     if (debugging) {
//         log.info(Array.prototype.slice.call(arguments));
//     }
// };

let xml2jsonBinary =
  Firewalla.getFirewallaHome() +
  '/extension/xml2json/xml2json.' +
  Firewalla.getPlatform();

module.exports = class {
  // ID can be port
  constructor(range, debug) {
    this.range = range;
    debugging = debug;
    this.scanQ = [];
    this.scanning = false;

    sem.on('nmap:queue:reset', async () => {
      try {
        log.info('Reseting queue', this.scanQ.length)
        this.scanQ = []
        if (this.process) {
          this.process.kill()
        }
      } catch(err) {
        log.error('Failed to reset queue', err)
      }
    })
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

  async scanQueue() {
    if (this.scanning || !this.scanQ.length) return

    const job = this.scanQ[0]
    if (job) {
      this.scanning = true
      try {
        const hosts = await util.promisify(this.nmapScan).bind(this)(job.cmd, true)
        log.verbose(`job ${job.id} done`, hosts)
        job.deferred.resolve(hosts)
      } catch(err) {
        log.error(`Job ${job.id} failed`, err);
        job.deferred.resolve([])
      } finally {
        this.scanQ.shift()
        this.scanning = false
        this.scanQueue()
      }
    }
  }

  createJob(obj) {
    const job = this.scanQ.find(j => j.id == obj.id)
    if (job)
      return job
    else {
      log.verbose(`creating job ${obj.id}`)
      this.scanQ.push(obj)
      obj.deferred = buildDeferred()
      this.scanQueue()
      return obj
    }
  }

  async neighborSolicit(ipv6Addr) {
    let _mac = hitCache.peek(ipv6Addr);
    if (_mac != null) {
      return _mac
    }
    const notFoundRecently = missCache.peek(ipv6Addr);
    if (notFoundRecently) {
      log.verbose(ipv6Addr, 'not found, skip')
      return null
    }

    if (!net.isIPv6(ipv6Addr)) return

    const cmd = util.format('sudo timeout 5s nmap -6 -PR -sn -n %s -oX - | %s', ipv6Addr, xml2jsonBinary);

    const jobID = 'solicit-' + ipv6Addr

    const job = this.createJob({ id: jobID, cmd, })
    const hosts = await job.deferred.promise

    for (let i in hosts) {
      const host = hosts[i];
      if (host.mac) {
        hitCache.set(ipv6Addr, host.mac)
        return host.mac
      }
    }
    missCache.set(ipv6Addr, true)
    return null
  }

  async scanAsync(range /*Must be v4 CIDR*/, fast) {
    if (!range || !net.isIPv4(range.split('/')[0])) {
      return []
    }

    try {
      range = networkTool.capSubnet(range)
    } catch (e) {
      log.error('Nmap:Scan:Error', range, fast, e);
      throw e
    }

    const cmd = fast
      ? util.format(
          'sudo timeout 1200s nmap -sn -n -PO --host-timeout 30s  %s -oX - | %s',
          range,
          xml2jsonBinary
        )
      : util.format(
          'sudo timeout 1200s nmap -sU -n --host-timeout 200s --script nbstat.nse -p 137 %s -oX - | %s',
          range,
          xml2jsonBinary
        );

    if (this.scanQ.length > 3) {
      log.info('======================= Warning Previous instance running====');
      throw new Error('Queue full')
    }

    const jobID = (fast ? 'fast-' : 'slow-') + range
    const job = this.createJob({ id: jobID, cmd })
    const hosts = await job.deferred.promise

    return hosts
  }

  nmapScan(cmdline, requiremac, callback = ()=>{}) {
    log.info('Running commandline:', cmdline);
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
            for (const addr of hostjson['address']) {
              if (addr['addrtype'] == 'ipv4') {
                host.ipv4Addr = addr.addr;
                ipaddr = addr.addr;
              } else if (addr['addrtype'] == 'mac') {
                host.mac = addr.addr && addr.addr.toUpperCase();
                if (addr.vendor) {
                  host.macVendor = addr.vendor;
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
    this.process.on('exit', (code, signal) => {
      log.debug('NMAP exited with', code, signal);
      this.process = null;
    });
  }
};
