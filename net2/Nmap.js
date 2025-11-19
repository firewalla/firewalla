/*    Copyright 2016-2025 Firewalla Inc.
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

class Nmap {
  constructor() {
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

  parsePort(hostuid, portData) {
    let port = {};
    log.debug('PARSING: ', portData);
    port.protocol = portData.protocol;
    port.hostId = hostuid;
    port.uid = hostuid + '.' + portData.portid;
    port.portid = portData.portid;
    if (portData.serviceName) {
      port.serviceName = portData.serviceName;
      port.lastActiveTimestamp = Date.now() / 1000;
    }
    if (portData.state) {
      port.state = portData.state;
    }
    return port;
  }

  parseNmapTextOutput(output, scriptName = null) {
    const hosts = [];
    const lines = output.split('\n');
    
    // Extract script ID from path if provided
    let scriptId = null;
    if (scriptName) {
      const match = scriptName.match(/([^/]+)\.nse$/);
      if (match) scriptId = match[1];
    }
    
    let currentHost = null;
    let inScriptSection = false;
    let namesSectionFound = false;
    let expectingTitle = false;
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      // Handle new host report
      const hostReportMatch = trimmed.match(/^Nmap scan report for (.+)$/);
      if (hostReportMatch) {
        this._saveHost(currentHost, hosts);
        
        // Create new host
        const hostnameInfo = hostReportMatch[1];
        currentHost = {
          ipv4Addr: null,
          ipv6Addr: null,
          mac: null,
          macVendor: null,
          script: scriptId ? {} : null
        };
        
        // Extract IP from "hostname (ip)" or just "ip"
        const hostnameMatch = hostnameInfo.match(/^(.+?)\s*\(([^)]+)\)$/);
        const ipAddr = hostnameMatch ? hostnameMatch[2] : (net.isIP(hostnameInfo) ? hostnameInfo : null);
        if (ipAddr) {
          if (net.isIPv4(ipAddr)) {
            currentHost.ipv4Addr = ipAddr;
          } else if (net.isIPv6(ipAddr)) {
            currentHost.ipv6Addr = ipAddr;
          }
        }
        
        inScriptSection = false;
        namesSectionFound = false;
        expectingTitle = false;
        continue;
      }
      
      // Parse MAC address
      // Match MAC address and optional vendor name in parentheses
      // Vendor name may contain nested parentheses, so match from first ( to last ) on line
      const macMatch = trimmed.match(/^MAC Address:\s*([0-9A-Fa-f:]+)(?:\s*\((.+)\))?$/);
      if (macMatch) {
        currentHost.mac = macMatch[1].toUpperCase();
        if (macMatch[2]) currentHost.macVendor = macMatch[2];
        continue;
      }
      
      // Handle script section
      if (scriptId) {
        // Enter script section
        if (!inScriptSection && trimmed.match(/Host script results:/i)) {
          inScriptSection = true;
          // Initialize script object
          if (currentHost.script && !currentHost.script[scriptId]) {
            currentHost.script[scriptId] = {};
          }
        }

        // Parse script output
        if (inScriptSection) {
          const scriptObj = currentHost.script[scriptId];

          if (scriptId === 'nbstat') {
            // Extract NetBIOS name
            if (!namesSectionFound) {
              const netbiosMatch = trimmed.match(/nbstat: NetBIOS name:\s*([^ ,]+)/i);
              if (netbiosMatch) {
                const name = netbiosMatch[1].trim();
                if (name && name.toLowerCase() !== '<unknown>') {
                  scriptObj.nbtName = name;
                }
                continue;
              }

              // Detect Names section
              if (trimmed.match(/^\|\s+Names:/i)) {
                namesSectionFound = true;
                continue;
              }
            }

            // Parse Names section
            const nameMatch = !scriptObj.nbtName && namesSectionFound &&
              trimmed.match(/^\|[\s_]+([^ <\r\n]+)(<[0-9a-f]+>)?.*?Flags:/i);
            if (nameMatch) {
              scriptObj.nbtName = nameMatch[1].trim();
            }
          } else {
            // Parse vulnerability scripts
            // VULNERABLE indicator
            if (trimmed.match(/^\|\s+VULNERABLE:/i)) {
              scriptObj.vulnerable = true;
              expectingTitle = true;
              continue;
            }

            // Extract title (line after VULNERABLE:)
            if (expectingTitle) {
              const match = trimmed.match(/^\|[\s_]+(.+)$/);
              if (match) {
                scriptObj.title = match[1].trim();
                expectingTitle = false;
                continue;
              }
            } else {
              // Extract state
              const stateMatch = trimmed.match(/^\|\s+State:\s*(\w+)/i);
              if (stateMatch) {
                scriptObj.state = stateMatch[1];
                continue;
              }

              // Extract disclosure date
              const disclosureMatch = trimmed.match(/^\|\s+Disclosure date:\s*([^\s]+)/i);
              if (disclosureMatch) {
                scriptObj.disclosure = disclosureMatch[1].trim();
                continue;
              }
            }
          }
        }
      }
    }
    
    // Save last host
    this._saveHost(currentHost, hosts);
    return { hosts };
  }

  _saveHost(host, hosts) {
    if (!host) return;
    
    // Clean up empty script objects
    if (host.script && Object.keys(host.script).length === 0) {
      delete host.script;
    }
    
    // Clean up script objects with no useful data
    if (host.script) {
      for (const key in host.script) {
        const scriptData = host.script[key];
        
        if (!Object.keys(scriptData).length) {
          delete host.script[key];
        }
      }
      
      if (Object.keys(host.script).length === 0) {
        delete host.script;
      }
    }
    
    hosts.push(host);
  }

  async scanQueue() {
    // Prevent concurrent execution
    if (this.scanning) return
    
    // Process queue until empty
    while (this.scanQ.length && !this.scanning) {
      this.scanning = true
      const job = this.scanQ[0] // Peek at first job
      
      try {
        const hosts = await this.nmapScan(job.cmd, true, job.scriptName)
        log.verbose(`job ${job.id} done`, hosts)
        job.deferred.resolve(hosts)
      } catch(err) {
        log.error(`Job ${job.id} failed`, err);
        // Resolve with empty array to maintain backward compatibility
        // (callers don't handle promise rejections)
        job.deferred.resolve([])
      } finally {
        // Remove job after processing (shift is O(n) but queue is typically small)
        this.scanQ.shift()
        this.scanning = false
      }
    }
  }

  createJob(obj) {
    // Check if job with same ID already exists
    const existingJob = this.scanQ.find(j => j.id === obj.id)
    if (existingJob) {
      return existingJob
    }
    
    // Create new job
    log.verbose(`creating job ${obj.id}`)
    obj.deferred = buildDeferred()
    this.scanQ.push(obj)
    
    // Start processing queue if not already running
    this.scanQueue().catch(err => {
      log.error('Error in scanQueue', err)
    })
    
    return obj
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

    const cmd = util.format('sudo timeout 5s nmap -6 -PR -sn -n %s', ipv6Addr);

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

  /**
   * Scan network range using nmap
   * @param {string} range - Network range in CIDR notation (IPv4 only)
   * @param {object} options - Optional:
   *   - script: string - Full path to script (e.g., '/path/to/script.nse'). Only 1 script per call is allowed
   *   - ports: number[] - Array of port numbers (e.g., [445]). If provided, performs port scan
   *   - protocols: number[] - optional array for -PO flag (e.g., [1,6] for -PO1,6) - only for ping scan
   *   - sendIp: boolean - optional: add --send-ip flag - only for ping scan
   *   - hostTimeout: string - host timeout (default: '30s' for ping scan, '200s' for UDP scan, '60s' for script scan)
   * @returns {Promise<Array>} Array of host objects
   */
  async scanAsync(range /*Must be v4 CIDR*/, options = {}) {
    if (!range || !net.isIPv4(range.split('/')[0])) {
      return []
    }

    try {
      range = networkTool.capSubnet(range)
    } catch (e) {
      log.error('Nmap:Scan:Error', range, options, e);
      throw e
    }

    let cmd
    const { ports, script, hostTimeout } = options

    if (script) {
      // Port scan with optional script
      const portString = ports && ports.length ? `-p${ports.join(',')}` : '';
      
      cmd = util.format(
        'sudo timeout 1200s nmap -n -Pn --host-timeout %s --script %s %s %s',
        hostTimeout || '200s',
        script,
        portString,
        range
      ).replace(/\s+/g, ' ').trim(); // Clean up extra spaces
    } else {
      // Default: ping scan
      cmd = 'sudo timeout 1200s nmap -sn -n'
      
      // Add protocol specification if provided
      if (options.protocols && Array.isArray(options.protocols)) {
        cmd += ` -PO${options.protocols.join(',')}`  // e.g., -PO1,6
      } else {
        cmd += ' -PO'  // default: all protocols
      }
      
      // Add --send-ip flag if requested
      if (options.sendIp) {
        cmd += ' --send-ip'
      }
      
      const hostTimeout = options.hostTimeout || '30s';
      cmd += ` --host-timeout ${hostTimeout} ${range}`
    }

    if (this.scanQ.length > 3) {
      log.info('======================= Warning Previous instance running====');
      throw new Error('Queue full')
    }

    const jobID = ports ? `script-${range}-${ports.join(',')}` : (script ? 'script-' : 'fast-') + range
    const job = this.createJob({ id: jobID, cmd, scriptName: script })
    const hosts = await job.deferred.promise

    return hosts
  }

  async nmapScan(cmdline, requiremac, scriptName = null) {
    log.info('Running commandline:', cmdline);
    const cp = require('child_process');
    
    // Using child_process.exec directly to maintain process access for cancellation
    // Following async/await pattern similar to child-process-promise
    return new Promise((resolve, reject) => {
      this.process = cp.exec(
        cmdline,
        (err, stdout, stderr) => {
          if (err) {
            log.error('Failed to nmap scan:', err, 'stderr:', stderr);
            reject(err);
            return;
          }

          let hosts = [];
          
          try {
            const parsed = this.parseNmapTextOutput(stdout, scriptName);
            hosts = parsed.hosts;
          } catch (parseErr) {
            log.error('Failed to parse nmap output:', parseErr);
            reject(parseErr);
            return;
          }

          // Filter hosts that require MAC address
          if (requiremac) {
            hosts = hosts.filter(host => host && host.mac != null);
          }

          resolve(hosts);
        }
      );
      
      this.process.on('exit', (code, signal) => {
        log.debug('NMAP exited with', code, signal);
        this.process = null;
      });
    });
  }
};

module.exports = new Nmap();