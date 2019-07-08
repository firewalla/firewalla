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
const log = require('./logger.js')(__filename);

var instances = {};

const rclient = require('../util/redis_manager.js').getRedisClient()

const exec = require('child-process-promise').exec

const _ = require('lodash');

const timeSeries = require('../util/TimeSeries.js').getTimeSeries()
const util = require('util');
const getHitsAsync = util.promisify(timeSeries.getHits).bind(timeSeries)

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const Spoofer = require('./Spoofer.js');
var spoofer = null;
const SysManager = require('./SysManager.js');
const sysManager = new SysManager('info');
const DNSManager = require('./DNSManager.js');
const dnsManager = new DNSManager('error');
const FlowManager = require('./FlowManager.js');
const flowManager = new FlowManager('debug');

const Host = require('./Host.js');

const ShieldManager = require('./ShieldManager.js');

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');

const FRPManager = require('../extension/frp/FRPManager.js')
const fm = new FRPManager()
const frp = fm.getSupportFRP()

const sem = require('../sensor/SensorEventManager.js').getInstance();

const AlarmManager2 = require('../alarm/AlarmManager2.js');
const alarmManager2 = new AlarmManager2();

const PolicyManager2 = require('../alarm/PolicyManager2.js');
const policyManager2 = new PolicyManager2();

const ExceptionManager = require('../alarm/ExceptionManager.js');
const exceptionManager = new ExceptionManager();

const SpooferManager = require('./SpooferManager.js')

const modeManager = require('./ModeManager.js');

const f = require('./Firewalla.js');

const license = require('../util/license.js')

const fConfig = require('./config.js').getConfig();

const fc = require('./config.js')

const _async = require('async');

const AppTool = require('./AppTool');
const appTool = new AppTool();

const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool()

const tokenManager = require('../util/FWTokenManager.js');

const FlowTool = require('./FlowTool.js');
const flowTool = new FlowTool();

const OpenVPNClient = require('../extension/vpnclient/OpenVPNClient.js');
const VPNClientEnforcer = require('../extension/vpnclient/VPNClientEnforcer.js');	
const vpnClientEnforcer = new VPNClientEnforcer();

const INACTIVE_TIME_SPAN = 60 * 60 * 24 * 7;

module.exports = class HostManager {
  // type is 'server' or 'client'
  constructor(name, type, loglevel) {
    loglevel = loglevel || 'info';

    if (instances[name] == null) {

      this.instanceName = name;
      this.hosts = {}; // all, active, dead, alarm
      this.hostsdb = {};
      this.hosts.all = [];
      this.callbacks = {};
      this.type = type;
      this.policy = {};
      sysManager.update((err) => {
        if (err == null) {
          log.info("System Manager Updated");
          if(!f.isDocker()) {
            spoofer = new Spoofer(sysManager.config.monitoringInterface, {}, false);
          } else {
            // for docker
            spoofer = {
              isSecondaryInterfaceIP: () => {},
              newSpoof: () => new Promise(resolve => resolve()),
              newUnspoof: () => new Promise(resolve => resolve()),
              newSpoof6: () => new Promise(resolve => resolve()),
              newUnspoof6: () => new Promise(resolve => resolve()),
              spoof: () => {},
              spoofMac6: () => {},
              clean: () => {},
              clean7: () => {},
              clean6byIp: () => {},
              clean6: () => {},
              validateV6Spoofs: () => {},
              validateV4Spoofs: () => {},
            };
          }
        }
      });

      let c = require('./MessageBus.js');
      this.subscriber = new c(loglevel);

      // ONLY register for these events if hostmanager type IS server
      if(this.type === "server") {

        log.info("Subscribing Scan:Done event...")
        this.subscriber.subscribe("DiscoveryEvent", "Scan:Done", null, (channel, type, ip, obj) => {
          log.info("New Host May be added rescan");
          this.getHosts((err, result) => {
            if (this.callbacks[type]) {
              this.callbacks[type](channel, type, ip, obj);
            }
          });
        });
        this.subscriber.subscribe("DiscoveryEvent", "SystemPolicy:Changed", null, (channel, type, ip, obj) => {
          if (this.type != "server") {
            return;
          };

          this.safeExecPolicy()

          /*
          this.loadPolicy((err,data)=> {
              log.debug("SystemPolicy:Changed",JSON.stringify(this.policy));
              policyManager.execute(this,"0.0.0.0",this.policy,null);
          });
          */
          log.info("SystemPolicy:Changed", channel, ip, type, obj);
        });

        this.keepalive();
        setInterval(()=>{
          this.keepalive();
        },1000*60*5);
      }

      instances[name] = this;
    }
    return instances[name];
  }

  keepalive() {
    log.info("HostManager:Keepalive");
    for (let i in this.hostsdb) {
      if (i.startsWith("host:mac")) {
        let _h = this.hostsdb[i];
        _h.keepalive();
      }
    }
  }

  on(event, callback) {
    this.callbacks[event] = callback;
  }

  basicDataForInit(json, options) {
    let networkinfo = sysManager.sysinfo[sysManager.config.monitoringInterface];
    json.network = networkinfo;

    sysManager.updateInfo();

    if(f.isDocker() &&
      ! options.simulator &&
      fConfig.docker &&
      fConfig.docker.hostIP
    ) {
      // if it is running inside docker, and app is not from simulator
      // use docker host as the network ip
      json.network.ip_address = fConfig.docker.hostIP;
    }

    json.cpuid = platform.getBoardSerial();
    json.uptime = process.uptime()

    if(sysManager.language) {
      json.language = sysManager.language;
    } else {
      json.language = 'en'
    }

    json.releaseType = f.getReleaseType()

    if(sysManager.timezone) {
      json.timezone = sysManager.timezone;
    }

    json.features = { // do not change these settings, it will impact how app works
      archiveAlarm: true,
      alarmMoreItems: true,
      ignoreAlarm: true,
      reportAlarm: true
    }

    json.runtimeFeatures = fc.getFeatures()

    if(f.isDocker()) {
      json.docker = true;
    }

    let branch = f.getBranch()
    if(branch === "master") {
      json.isBeta = true
    } else {
      json.isBeta = false
    }

    json.cpuid = platform.getBoardSerial();
    json.updateTime = Date.now();
    if (sysManager.sshPassword) {
      json.ssh = sysManager.sshPassword;
    }
    if (sysManager.sysinfo.oper && sysManager.sysinfo.oper.LastScan) {
      json.lastscan = sysManager.sysinfo.oper.LastScan;
    }
    json.systemDebug = sysManager.isSystemDebugOn();
    json.version = sysManager.config.version;
    json.longVersion = f.getVersion();
    json.lastCommitDate = f.getLastCommitDate()
    json.device = "Firewalla (beta)"
    json.publicIp = sysManager.publicIp;
    json.ddns = sysManager.ddns;
    json.secondaryNetwork = sysManager.sysinfo && sysManager.sysinfo[sysManager.config.monitoringInterface2];
    json.wifiNetwork = sysManager.sysinfo && sysManager.sysinfo[sysManager.config.monitoringWifiInterface];
    json.remoteSupport = frp.started;
    json.model = platform.getName();
    json.branch = f.getBranch();
    if(frp.started) {
      json.remoteSupportConnID = frp.port + ""
      json.remoteSupportPassword = json.ssh
    }
    json.license = sysManager.license;
    if(!json.license) {
      json.license = license.getLicense()
    }
    json.ept = sysManager.ept;
    if (sysManager.publicIp) {
      json.publicIp = sysManager.publicIp;
    }
    if (sysManager.upgradeEvent) {
      json.upgradeEvent = sysManager.upgradeEvent;
    }
  }


  hostsInfoForInit(json) {
    let _hosts = [];
    for (let i in this.hosts.all) {
      _hosts.push(this.hosts.all[i].toJson());
    }
    json.hosts = _hosts;
  }

  async last24StatsForInit(json) {
    const download = flowManager.getLast24HoursDownloadsStats();
    const upload = flowManager.getLast24HoursUploadsStats();

    const [d, u] = await Promise.all([download, upload]);
    json.last24 = { upload: u, download: d, now: Math.round(new Date() / 1000)};

    return json;
  }

  async last60MinStats() {
    let downloadStats = await getHitsAsync("download", "1minute", 60)
    let uploadStats = await getHitsAsync("upload", "1minute", 60)
    return { downloadStats, uploadStats }
  }

  async last60MinStatsForInit(json, mac) {
    const subKey = mac ? ':' + mac : ''

    let downloadStats = await getHitsAsync("download" + subKey, "1minute", 61)
    if(downloadStats[downloadStats.length - 1] && downloadStats[downloadStats.length - 1][1] == 0) {
      downloadStats = downloadStats.slice(0, 60)
    } else {
      downloadStats = downloadStats.slice(1)
    }
    let uploadStats = await getHitsAsync("upload" + subKey, "1minute", 61)
    if(uploadStats[uploadStats.length - 1] &&  uploadStats[uploadStats.length - 1][1] == 0) {
      uploadStats = uploadStats.slice(0, 60)
    } else {
      uploadStats = uploadStats.slice(1)
    }

    let totalDownload = 0
    downloadStats.forEach((s) => {
      totalDownload += s[1]
    })

    let totalUpload = 0
    uploadStats.forEach((s) => {
      totalUpload += s[1]
    })

    json.last60 = {
      upload: uploadStats,
      download: downloadStats,
      totalUpload: totalUpload,
      totalDownload: totalDownload
    }
  }

  async last60MinTopTransferForInit(json) {
    const top = await rclient.hgetallAsync("last60stats")
    let values = Object.values(top)

    values = values.map((value) => {
      try {
        return JSON.parse(value)
      } catch(err) {
        return null
      }
    })

    values.sort((x, y) => {
      return x.ts - y.ts
    })

    json.last60top = values
  }

  async last30daysStatsForInit(json, mac) {
    const subKey = mac ? ':' + mac : ''
    let downloadStats = await getHitsAsync("download" + subKey, "1day", 30)
    let uploadStats = await getHitsAsync("upload" + subKey, "1day", 30)

    let totalDownload = 0
    downloadStats.forEach((s) => {
      totalDownload += s[1]
    })

    let totalUpload = 0
    uploadStats.forEach((s) => {
      totalUpload += s[1]
    })

    json.last30 = {
      upload: uploadStats,
      download: downloadStats,
      totalUpload: totalUpload,
      totalDownload: totalDownload
    }
  }

  policyDataForInit(json) {
    log.debug("Loading polices");

    return new Promise((resolve, reject) => {
      this.loadPolicy((err, data) => {
        if(err) {
          reject(err);
          return;
        }

        if (this.policy) {
          json.policy = this.policy;
        }
        resolve(json);
      });
    });
  }

  extensionDataForInit(json) {
    log.debug("Loading ExtentsionPolicy");
    let extdata = {};
    return new Promise((resolve,reject)=>{
      rclient.get("extension.portforward.config",(err,data)=>{
        try {
          if (data != null) {
            extdata['portforward'] = JSON.parse(data);
          }
        } catch (e) {
          log.error("ExtensionData:Unable to parse data",e,data);
          resolve(json);
          return;
        }
        json.extension = extdata;
        resolve(json);
      });
    });
  }

  async newAlarmDataForInit(json) {
    json.activeAlarmCount = await alarmManager2.getActiveAlarmCount();
    json.newAlarms = await alarmManager2.loadActiveAlarmsAsync();
  }

  async archivedAlarmNumberForInit(json) {
    log.debug("Reading total number of archived alarms");
    const count = await alarmManager2.numberOfArchivedAlarms();
    json.archivedAlarmCount = count;
    return json;
  }

  natDataForInit(json) {
    log.debug("Reading nat data");

    return new Promise((resolve, reject) => {
      rclient.hgetall("sys:scan:nat", (err, data) => {
        if(err) {
          reject(err);
          return;
        }

        if (data) {
          json.scan = {};
          for (let d in data) {
            json.scan[d] = JSON.parse(data[d]);
            if(typeof json.scan[d].description === 'object') {
              json.scan[d].description = ""
            }
          }
        }

        resolve(json);
      });
    });
  }

  boneDataForInit(json) {
    log.debug("Bone for Init");
    return new Promise((resolve, reject) => {
      f.getBoneInfo((err,boneinfo)=>{
        if(err) {
          reject(err);
          return;
        }
        json.boneinfo = boneinfo;
        resolve(json);
      });
    });
  }

  legacyStats(json) {
    log.debug("Reading legacy stats");
    return flowManager.getSystemStats()
      .then((flowsummary) => {
        json.flowsummary = flowsummary;
      });
  }

  legacyHostsStats(json) {
    log.debug("Reading host legacy stats");

    let promises = this.hosts.all.map((host) => flowManager.getStats2(host))
    return Promise.all(promises)
      .then(() => {
        return this.hostPolicyRulesForInit(json)
          .then(() => {
            this.hostsInfoForInit(json);
            return json;
          })
      });
  }

  async dhcpRangeForInit(network, json) {
    const key = network + "DhcpRange";
    const dnsmasq = new DNSMASQ();
    let dhcpRange = dnsmasq.getDefaultDhcpRange(network);
    return new Promise((resolve, reject) => {
      this.loadPolicy((err, data) => {
        if (data && data.dnsmasq) {
          const dnsmasqConfig = JSON.parse(data.dnsmasq);
          if (dnsmasqConfig[network + "DhcpRange"]) {
            dhcpRange = dnsmasqConfig[network + "DhcpRange"];
          }
        }
        if (dhcpRange)
          json[key] = dhcpRange;
        resolve();
      })
    });
  }

  modeForInit(json) {
    log.debug("Reading mode");
    return modeManager.mode()
      .then((mode) => {
        json.mode = mode;
      });
  }

  // what is blocked
  policyRulesForInit(json) {
    log.debug("Reading policy rules");
    return new Promise((resolve, reject) => {
      policyManager2.loadActivePolicies({includingDisabled: 1}, (err, rules) => {
        if(err) {
          reject(err);
          return;
        } else {
          // filters out rules with inactive devices
          rules = rules.filter(rule => {
            if (_.isEmpty(rule.scope)) return true;

            return rule.scope.some(mac =>
              this.hosts.all.some(host => host.o.mac == mac)
            )
          })

          let alarmIDs = rules.map((p) => p.aid);

          alarmManager2.idsToAlarms(alarmIDs, (err, alarms) => {
            if(err) {
              log.error("Failed to get alarms by ids:", err);
              reject(err);
              return;
            }

            for(let i = 0; i < rules.length; i ++) {
              if(rules[i] && alarms[i]) {
                rules[i].alarmMessage = alarms[i].localizedInfo();
                rules[i].alarmTimestamp = alarms[i].timestamp;
              }
            }

            rules.sort((x,y) => {
              if(y.timestamp < x.timestamp) {
                return -1
              } else {
                return 1
              }
            })

            json.policyRules = rules;

            resolve();
          });
        }
      });
    });
  }

  // whats is allowed
  exceptionRulesForInit(json) {
    log.debug("Reading exception rules");
    return new Promise((resolve, reject) => {
      exceptionManager.loadExceptions((err, rules) => {
        if(err) {
          reject(err);
        } else {

          rules = rules.filter((r) => {
            return r.type != "ALARM_NEW_DEVICE" // allow new device is default
          })

          // filters out rules with inactive devices
          rules = rules.filter(rule => {
            if(!rule) {
              return false;
            }

            const mac = rule["p.device.mac"];

            if (!mac) return true;

            return this.hosts.all.some(host => host.o.mac === mac);
          })

          let alarmIDs = rules.map((p) => p.aid);

          alarmManager2.idsToAlarms(alarmIDs, (err, alarms) => {
            if(err) {
              log.error("Failed to get alarms by ids:", err);
              reject(err);
              return;
            }

            for(let i = 0; i < rules.length; i ++) {
              if(rules[i] && alarms[i]) {
                rules[i].alarmMessage = alarms[i].localizedInfo();
                rules[i].alarmTimestamp = alarms[i].timestamp;
              }
            }

            rules.sort((x,y) => {
              if(y.timestamp < x.timestamp) {
                return -1
              } else {
                return 1
              }
            })

            json.exceptionRules = rules
            resolve();
          });
        }
      });
    });
  }

  hostPolicyRulesForInit(json) {
    log.debug("Reading individual host policy rules");

    return new Promise((resolve, reject) => {
      _async.eachLimit(this.hosts.all, 10, (host, cb) => {
        host.loadPolicy(cb)
      }, (err) => {
        if(err) {
          log.error("Failed to load individual host policy rules", err);
          reject(err);
        } else {
          resolve(json);
        }
      });
    })
  }

  async loadDDNSForInit(json) {
    log.debug("Reading DDNS");

    let ddnsString = await rclient.hgetAsync("sys:network:info", "ddns");
    if(ddnsString) {
      try {
        let ddns = JSON.parse(ddnsString);
        json.ddns = ddns;
      } catch(err) {
        log.error("Failed to parse ddns string:", ddnsString);
      }
    }
  }

  migrateStats() {
    let ipList = [];
    for(let index in this.hosts.all) {
      ipList.push.apply(ipList, this.hosts.all[index].getAllIPs());
    }

    ipList.push("0.0.0.0"); // system one

    // total ip list to migrate
    return Promise.all(ipList.map((ip) => flowManager.migrateFromOldTableForHost(ip)));
  }

  async getCloudURL(json) {
    const url = await rclient.getAsync("sys:bone:url");
    if(json && json.ept && json.ept.url && json.ept.url !== url)  {
      json.ept.url = url;
    }
  }

  /*
   * data here may be used to recover Firewalla configuration
   */
  async getCheckInAsync() {
    let json = {};
    let requiredPromises = [
      this.policyDataForInit(json),
      this.extensionDataForInit(json),
      this.modeForInit(json),
      this.policyRulesForInit(json),
      this.exceptionRulesForInit(json),
      this.natDataForInit(json),
      this.getCloudURL(json)
    ]

    this.basicDataForInit(json, {});

    await requiredPromises;

    let firstBinding = await rclient.getAsync("firstBinding")
    if(firstBinding) {
      json.firstBinding = firstBinding
    }

    json.bootingComplete = await f.isBootingComplete()

    // Delete anything that may be private
    if (json.ssh) delete json.ssh

    return json;
  }

  // convert host internet block to old format, this should be removed when all apps are migrated to latest format
  async legacyHostFlag(json) {
    const rules = json.policyRules
    const hosts = json.hosts
    rules.forEach((rule) => {
      if(rule.type === "mac" &&
        (!rule.disabled || rule.disabled != "1")) { // disable flag not exist or flag is not equal to 1
        let target = rule.target
        for (const index in hosts) {
          const host = hosts[index]
          if(host.mac === target && host.policy) {
            host.policy.blockin = true
            break
          }
        }
      }
    })
  }

  async jwtTokenForInit(json) {
    const token = await tokenManager.getToken();
    if(token) {
      json.jwt = token;
    }
  }

  async groupNameForInit(json) {
    const groupName = await rclient.getAsync("groupName");
    if(groupName) {
      json.groupName = groupName;
    }
  }

  async asyncBasicDataForInit(json) {
    const speed = await platform.getNetworkSpeed();
    json.nicSpeed = speed;
  }

  async getRecentFlows(json) {
    const recentFlows = await flowTool.getGlobalRecentConns();
    json.recentFlows = recentFlows;
  }

  async getGuessedRouters(json) {
    try {
      const routersString = await rclient.getAsync("guessed_router");
      if(routersString) {
        const routers = JSON.parse(routersString);
        if(!_.isEmpty(routers)) {
          json.guessedRouters = routers;
        }
      }
    } catch (err) {
      log.error("Failed to get guessed routers:", err);
    }
  }

  async groupNameForInit(json) {
    const groupName = await rclient.getAsync("groupName");
    if(groupName) {
      json.groupName = groupName;
    }
  }

  async asyncBasicDataForInit(json) {
    const speed = await platform.getNetworkSpeed();
    json.nicSpeed = speed;
  }

  async encipherMembersForInit(json) {
    let members = await rclient.smembersAsync("sys:ept:members")
    if(members && members.length > 0) {
      const mm = members.map((m) => {
        try {
          return JSON.parse(m)
        } catch(err) {
          return null
        }
      }).filter((x) => x != null)

      if(mm && mm.length > 0) {
        const names = await rclient.hgetallAsync("sys:ept:memberNames")
        const lastVisits = await rclient.hgetallAsync("sys:ept:member:lastvisit")

        if(names) {
          mm.forEach((m) => {
            m.dName = m.eid && names[m.eid]
          })
        }

        if(lastVisits) {
          mm.forEach((m) => {
            m.lastVisit = m.eid && lastVisits[m.eid]
          })
        }

        json.eMembers = mm
      }
    }
  }

  toJson(includeHosts, options, callback) {

    if(typeof options === 'function') {
      callback = options;
      options = {}
    }

    let json = {};

    this.getHosts(async () => {
      try {

        let requiredPromises = [
          this.last24StatsForInit(json),
          this.last60MinStatsForInit(json),
          //            this.last60MinTopTransferForInit(json),
          this.extensionDataForInit(json),
          this.last30daysStatsForInit(json),
          this.policyDataForInit(json),
          this.legacyHostsStats(json),
          this.modeForInit(json),
          this.policyRulesForInit(json),
          this.exceptionRulesForInit(json),
          this.newAlarmDataForInit(json),
          this.archivedAlarmNumberForInit(json),
          this.natDataForInit(json),
          this.boneDataForInit(json),
          this.encipherMembersForInit(json),
          this.jwtTokenForInit(json),
          this.groupNameForInit(json),
          this.asyncBasicDataForInit(json),
          this.getRecentFlows(json),
          this.getGuessedRouters(json)
        ]

        this.basicDataForInit(json, options);

        await Promise.all(requiredPromises);

        // mode should already be set in json
        if (json.mode === "dhcp") {
          await this.dhcpRangeForInit("alternative", json);
          await this.dhcpRangeForInit("secondary", json);
        }

        await this.loadDDNSForInit(json);

        await this.legacyHostFlag(json)

        json.nameInNotif = await rclient.hgetAsync("sys:config", "includeNameInNotification")

        // for any pi doesn't have firstBinding key, they are old versions
        let firstBinding = await rclient.getAsync("firstBinding")
        if(firstBinding) {
          json.firstBinding = firstBinding
        }

        json.bootingComplete = await f.isBootingComplete()

        if(!appTool.isAppReadyToDiscardLegacyFlowInfo(options.appInfo)) {
          await this.legacyStats(json);
        }

        try {
          await exec("sudo systemctl is-active firekick")
          json.isBindingOpen = 1;
        } catch(err) {
          json.isBindingOpen = 0;
        }

        callback(null, json);
      } catch(err) {
        log.error("Caught error when preparing init data: " + err);
        log.error(err.stack);
        callback(err);
      };
    });
  }

  getHostFast(ip) {
    if (ip == null) {
      return null;
    }

    return this.hostsdb["host:ip4:"+ip];
  }

  getHostFast6(ip6) {
    if(ip6) {
      return this.hostsdb[`host:ip6:${ip6}`]
    }

    return null
  }

  getHost(target, callback) {
    callback = callback || function() {}

    this.getHostAsync(target)
      .then(res => callback(null, res))
      .catch(err => {
        callback(err);
      })
  }

  async getHostAsync(target) {

    let host, o;
    if (hostTool.isMacAddress(target)) {
      host = this.hostsdb[`host:mac:${target}`];

      if (host) {
        return host;
      }

      o = await hostTool.getMACEntry(target)
    } else {
      o = await dnsManager.resolveLocalHostAsync(target)

      host = this.hostsdb[`host:ip4:${o.ipv4Addr}`];

      if (host) {
        host.update(o);
        return host
      }
    }

    if (o == null) return null;

    host = new Host(o, this);
    host.type = this.type;

    //this.hostsdb[`host:mac:${o.mac}`] = host
    // do not update host:mac entry in this.hostsdb intentionally,
    // since host:mac entry in this.hostsdb should be strictly consistent with things in this.hosts.all and should only be updated in getHosts() by design
    this.hostsdb[`host:ip4:${o.ipv4Addr}`] = host

    let ipv6Addrs = host.ipv6Addr
    if(ipv6Addrs && ipv6Addrs.constructor.name === 'Array') {
      for(let i in ipv6Addrs) {
        let ip6 = ipv6Addrs[i]
        let key = `host:ip6:${ip6}`
        this.hostsdb[key] = host
      }
    }

    return host
  }

  // take hosts list, get mac address, look up mac table, and see if
  // ipv6 or ipv4 addresses needed updating

  syncHost(host, save, callback) {
    if (host.o.mac == null) {
      log.error("HostManager:Sync:Error:MacNull", host.o.mac, host.o.ipv4Addr, host.o);
      callback("mac", null);
      return;
    }
    let mackey = "host:mac:" + host.o.mac;
    host.identifyDevice(false,null);
    host.calculateDType((err, data) => {
      rclient.hgetall(mackey, (err, data) => {
        if (data == null || err != null) {
          callback(err, null);
          return;
        }
        if (data.ipv6Addr == null) {
          callback(null, null);
          return;
        }

        let ipv6array = JSON.parse(data.ipv6Addr);
        if (host.ipv6Addr == null) {
          host.ipv6Addr = [];
        }

        let needsave = false;

        //log.debug("=======>",host.o.ipv4Addr, host.ipv6Addr, ipv6array);
        for (let i in ipv6array) {
          if (host.ipv6Addr.indexOf(ipv6array[i]) == -1) {
            host.ipv6Addr.push(ipv6array[i]);
            needsave = true;
          }
        }

        sysManager.setNeighbor(host.o.ipv4Addr);

        for (let j in host.ipv6Addr) {
          sysManager.setNeighbor(host.ipv6Addr[j]);
        }

        host.redisfy();
        if (needsave == true && save == true) {
          rclient.hmset(mackey, {
            ipv6Addr: host.o.ipv6Addr
          }, (err, data) => {
            callback(err);
          });
        } else {
          callback(null);
        }
      });
    });
  }


  getHostsAsync() {
    return new Promise((resolve,reject) => {
      this.getHosts((err, hosts) => {
        if(err) {
          reject(err)
        } else {
          resolve(hosts)
        }
      })
    })
  }

  safeExecPolicy(skipHosts) {
    // a very dirty hack, only call system policy change every 5 seconds
    const now = new Date() / 1000
    if(this.lastExecPolicyTime && this.lastExecPolicyTime > now - 5) {
      // just run execPolicy, defer this one
      this.pendingExecPolicy = true
      setTimeout(() => {
        if(this.pendingExecPolicy) {
          this.lastExecPolicyTime = new Date() / 1000
          this.execPolicy(skipHosts)
          this.pendingExecPolicy = false
        }
      }, (this.lastExecPolicyTime + 5 - now) * 1000)
    } else {
      this.lastExecPolicyTime = new Date() / 1000
      this.execPolicy(skipHosts)
      this.pendingExecPolicy = false
    }
  }

  // super resource-heavy function, be careful when calling this
  getHosts(callback,retry) {
    log.info("hostmanager:gethosts:started",retry);
    // ready mark and sweep
    // Only allow requests be executed in a frenquency lower than 1 every 5 mins
    const getHostsActiveExpire = Math.floor(new Date() / 1000) - 60 * 5 // 5 mins
    if (this.getHostsActive && this.getHostsActive > getHostsActiveExpire) {
      log.info("hostmanager:gethosts:mutx",retry);
      let stack = new Error().stack
      let retrykey = retry;
      if (retry == null) {
        retrykey = Date.now();
      }
      if (Date.now()-retrykey > 1000*10) {
        log.error("hostmanager:gethosts:mutx:timeout", retrykey, Date.now()-retrykey);
        callback(null, this.hosts.all);
        return;
      }
      log.debug("hostmanager:gethosts:mutx:stack:",retrykey, stack )
      setTimeout(() => {
        this.getHosts(callback,retrykey);
      },3000);
      return;
    }
    if (retry == null) {
      // let stack = new Error().stack
      // log.info("hostmanager:gethosts:mutx:first:", stack )
    } else {
      let stack = new Error().stack
      log.info("hostmanager:gethosts:mutx:last:", retry,stack )
    }
    this.getHostsActive = Math.floor(new Date() / 1000);
    // end of mutx check

    if(this.type === "server") {
      this.safeExecPolicy(true); // do not apply host policy here, since host information may be out of date. Host policy will be applied later after information is refreshed from host:mac:*
    }
    for (let h in this.hostsdb) {
      if (this.hostsdb[h]) {
        this.hostsdb[h]._mark = false;
      }
    }
    rclient.keys("host:mac:*", (err, keys) => {
      let multiarray = [];
      for (let i in keys) {
        multiarray.push(['hgetall', keys[i]]);
      }
      let inactiveTimeline = Date.now()/1000 - INACTIVE_TIME_SPAN; // one week ago
      rclient.multi(multiarray).exec((err, replies) => {
        _async.eachLimit(replies, 2, (o, cb) => {
          if (!o) {
            // defensive programming
            _async.setImmediate(cb);
            return;
          }
          if (o.ipv4) {
            o.ipv4Addr = o.ipv4;
          }
          if (o.ipv4Addr == null) {
            log.info("hostmanager:gethosts:error:noipv4", o.uid, o.mac);
            _async.setImmediate(cb);
            return;
          }
          if (sysManager.isLocalIP(o.ipv4Addr) && o.lastActiveTimestamp > inactiveTimeline) {
            //log.info("Processing GetHosts ",o);
            let hostbymac = this.hostsdb["host:mac:" + o.mac];
            let hostbyip = this.hostsdb["host:ip4:" + o.ipv4Addr];

            if (hostbymac == null) {
              hostbymac = new Host(o,this);
              hostbymac.type = this.type;
              this.hosts.all.push(hostbymac);
              this.hostsdb['host:ip4:' + o.ipv4Addr] = hostbymac;
              this.hostsdb['host:mac:' + o.mac] = hostbymac;

              let ipv6Addrs = hostbymac.ipv6Addr
              if(ipv6Addrs && ipv6Addrs.constructor.name === 'Array') {
                for(let i in ipv6Addrs) {
                  let ip6 = ipv6Addrs[i]
                  let key = `host:ip6:${ip6}`
                  this.hostsdb[key] = hostbymac
                }
              }

            } else {
              if (o.ipv4!=hostbymac.o.ipv4) {
                // the physical host get a new ipv4 address
                //
                this.hostsdb['host:ip4:' + hostbymac.o.ipv4] = null;
              }
              this.hostsdb['host:ip4:' + o.ipv4] = hostbymac;

              let ipv6Addrs = hostbymac.ipv6Addr
              if(ipv6Addrs && ipv6Addrs.constructor.name === 'Array') {
                for(let i in ipv6Addrs) {
                  let ip6 = ipv6Addrs[i]
                  let key = `host:ip6:${ip6}`
                  this.hostsdb[key] = hostbymac
                }
              }

              hostbymac.update(o);
            }
            hostbymac._mark = true;
            if (hostbyip) {
              hostbyip._mark = true;
            }
            // two mac have the same IP,  pick the latest, until the otherone update itself
            if (hostbyip != null && hostbyip.o.mac != hostbymac.o.mac) {
              log.info("HOSTMANAGER:DOUBLEMAPPING", hostbyip.o.mac, hostbymac.o.mac);
              if (hostbymac.o.lastActiveTimestamp > hostbyip.o.lastActiveTimestamp) {
                this.hostsdb['host:ip4:' + o.ipv4Addr] = hostbymac;
              }
            }
            hostbymac.cleanV6().then(()=>{
              this.syncHost(hostbymac, true, (err) => {
                if (this.type == "server") {
                  hostbymac.applyPolicy((err)=>{
                    hostbymac._mark = true;
                    cb();
                  });
                } else {
                  hostbymac._mark = true;
                  cb();
                }
              });
            });
          } else {
            cb();
          }
        }, (err) => {
          let removedHosts = [];
          /*
          for (let h in this.hostsdb) {
              let hostbymac = this.hostsdb[h];
              if (hostbymac) {
                  log.info("BEFORE CLEANING CHECKING MARKING:", h,hostbymac.o.mac,hostbymac._mark);
              }
          }
          */
          let allIPv6Addrs = [];
          let allIPv4Addrs = [];

          let myIp = sysManager.myIp();

          for (let h in this.hostsdb) {
            let hostbymac = this.hostsdb[h];
            if (hostbymac && h.startsWith("host:mac")) {
              if (hostbymac.ipv6Addr!=null && hostbymac.ipv6Addr.length>0) {
                if (hostbymac.ipv4Addr != myIp) {   // local ipv6 do not count
                  allIPv6Addrs = allIPv6Addrs.concat(hostbymac.ipv6Addr);
                }
              }
              if (hostbymac.o.ipv4Addr!=null && hostbymac.o.ipv4Addr != myIp) {
                allIPv4Addrs.push(hostbymac.o.ipv4Addr);
              }
            }
            if (this.hostsdb[h] && this.hostsdb[h]._mark == false) {
              let index = this.hosts.all.indexOf(this.hostsdb[h]);
              if (index!=-1) {
                this.hosts.all.splice(index,1);
                log.info("Removing host due to sweeping");
              }
              removedHosts.push(h);
            }  else {
              if (this.hostsdb[h]) {
                //this.hostsdb[h]._mark = false;
              }
            }
          }
          for (let h in removedHosts) {
            delete this.hostsdb[removedHosts[h]];
          }
          log.debug("hostmanager:removing:hosts", removedHosts);
          this.hosts.all.sort(function (a, b) {
            return Number(b.o.lastActiveTimestamp) - Number(a.o.lastActiveTimestamp);
          })
          this.getHostsActive = null;
          if (this.type === "server") {
            spoofer.validateV6Spoofs(allIPv6Addrs);
            spoofer.validateV4Spoofs(allIPv4Addrs);
          }
          log.info("hostmanager:gethosts:done Devices: ",this.hosts.all.length," ipv6 addresses ",allIPv6Addrs.length );
          callback(err, this.hosts.all);
        });
      });
    });
  }

  appendACL(name, data) {
    if (this.policy.acl == null) {
      this.policy.acl = [data];
    } else {
      let acls = this.policy.acl;
      let found = false;
      if (acls) {
        for (let i in acls) {
          let acl = acls[i];
          log.debug("comparing ", acl, data);
          if (acl.src == data.src && acl.dst == data.dst && acl.sport == data.sport && acl.dport == data.dport) {
            if (acl.state == data.state) {
              log.debug("System:setPolicy:Nochange", name, data);
              return;
            } else {
              acl.state = data.state;
              found = true;
              log.debug("System:setPolicy:Changed", name, data);
            }
          }
        }
      }
      if (found == false) {
        acls.push(data);
      }
      this.policy.acl = acls;
    }
  }

  setPolicyAsync(name, data) {
    return util.promisify(this.setPolicy).bind(this)(name, data)
  }

  setPolicy(name, data, callback) {

    let savePolicyWrapper = (name, policy, callback) => {
      this.savePolicy((err, data) => {
        if (err == null) {
          let obj = {};
          obj[name] = policy;
          if (this.subscriber) {
            this.subscriber.publish("DiscoveryEvent", "SystemPolicy:Changed", "0", obj);
          }
          if (callback) {
            callback(null, obj);
          }
        } else {
          if (callback) {
            callback(null, null);
          }
        }
      });
    }

    this.loadPolicy((err, __data) => {
      if (name == "acl") {
        // when adding acl, enrich acl policy with source IP => MAC address mapping.
        // so that iptables can block with MAC Address, which is more accurate
        //
        // will always associate a mac with the
        let localIP = null;
        if (sysManager.isLocalIP(data.src)) {
          localIP = data.src;
        }
        if (sysManager.isLocalIP(data.dst)) {
          localIP = data.dst;
        }

        if(localIP) {
          this.getHost(localIP, (err, host) => {
            if(!err) {
              data.mac = host.o.mac; // may add more attributes in the future
            }
            this.appendACL(name, data);
            savePolicyWrapper(name, data, callback);
          });
        } else {
          this.appendACL(name, data);
          savePolicyWrapper(name, data, callback);
        }

      } else {
        if (this.policy[name] != null && this.policy[name] == data) {
          log.debug("System:setPolicy:Nochange", name, data);
          if (callback) {
            callback(null, null);
          }
          return;
        }
        this.policy[name] = data;
        log.debug("System:setPolicy:Changed", name, data);

        savePolicyWrapper(name, data, callback);
      }

    });
  }

  async spoof(state) {
    log.debug("System:Spoof:", state, this.spoofing);
    let gateway = sysManager.monitoringInterface().gateway;
    if (state == false) {
      // flush all ip addresses
      log.info("Flushing all ip addresses from monitoredKeys since monitoring is switched off")
      await new SpooferManager().emptySpoofSet()
    } else {
      // do nothing if state is true
    }
  }

  async enhancedSpoof(state) {
    await modeManager.toggleCompatibleSpoof(state);
  }

  async shield(policy) {
    const shieldManager = new ShieldManager(); // ShieldManager is a singleton class
    const state = policy.state;
    if (state === true) {
      // Raise global shield to block incoming connections
      await shieldManager.activateShield();
    } else {
      await shieldManager.deactivateShield();
    }
  }

  async vpnClient(policy) {
    const type = policy.type;
    const state = policy.state;
    const appliedInterfaces = policy.appliedInterfaces || [];
    switch (type) {
      case "openvpn": 
        const profileId = policy.openvpn && policy.openvpn.profileId;
        if (!profileId) {
          log.error("profileId is not specified", policy);
          return false;
        }
        const ovpnClient = new OpenVPNClient({profileId: profileId});
        // apply vpn client access to interfaces in appliedInterfaces
        const supportedInterfaces = {
          wifi: fConfig.monitoringWifiInterface
        };
        try {
          // set/clear vpn access of all supported interfaces accordingly
          for (let supportedInterface in supportedInterfaces) {
            const intfName = supportedInterfaces[supportedInterface];
            if (appliedInterfaces.includes(supportedInterface)) {
              await vpnClientEnforcer.enableInterfaceVPNAccess(intfName, ovpnClient.getInterfaceName());
            } else {
              await vpnClientEnforcer.disableInterfaceVPNAccess(intfName, ovpnClient.getInterfaceName());
            }
          }
        } catch (err) {
          log.error("Failed to apply VPN client access to interfaces", err);
          return false;
        }
        if (state === true) {
          await ovpnClient.setup().catch((err) => {
            // do not return false here since following start() operation should fail
            log.error(`Failed to setup openvpn client for ${profileId}`, err);
          });
          ovpnClient.once('push_options_start', async (content) => {
            const dnsServers = [];
            for (let line of content.split("\n")) {
              if (line && line.length != 0) {
                log.info(`Apply push options from ${profileId}: ${line}`);
                const options = line.split(/\s+/);
                switch (options[0]) {
                  case "dhcp-option":
                    if (options[1] === "DNS") {
                      dnsServers.push(options[2]);
                    }
                    break;
                  default:
                }
              }
            }
            // redirect dns to vpn channel
            if (dnsServers.length > 0) {
              await vpnClientEnforcer.enforceDNSRedirect(ovpnClient.getInterfaceName(), dnsServers);
              // set/clear dns redirection of all supported interfaces accordingly
              for (let supportedInterface in supportedInterfaces) {
                const intfName = supportedInterfaces[supportedInterface];
                if (appliedInterfaces.includes(supportedInterface)) {
                  await vpnClientEnforcer.enforceInterfaceDNSRedirect(intfName, ovpnClient.getInterfaceName(), dnsServers);
                } else {
                  await vpnClientEnforcer.unenforceInterfaceDNSRedirect(intfName, ovpnClient.getInterfaceName(), dnsServers);
                }
              }
            }
          });
          const result = await ovpnClient.start();
          if (result) {
            ovpnClient.once('link_broken', () => {
              sem.sendEventToFireApi({
                type: 'FW_NOTIFICATION',
                titleKey: 'NOTIF_VPN_CLIENT_LINK_BROKEN_TITLE',
                bodyKey: 'NOTIF_VPN_CLIENT_LINK_BROKEN_BODY',
                payload: {
                  profileId: profileId
                }
              });
              const updatedPolicy = JSON.parse(JSON.stringify(policy));
              updatedPolicy.state = false;
              // update vpnClient system policy to state false
              this.setPolicy("vpnClient", updatedPolicy);
            });
          }
          return result;
        } else {
          await ovpnClient.setup().catch((err) => {
            log.error(`Failed to setup openvpn client for ${profileId}`, err);
          });
          ovpnClient.once('push_options_stop', async (content) => {
            const dnsServers = [];
            for (let line of content.split("\n")) {
              if (line && line.length != 0) {
                log.info(`Roll back push options from ${profileId}: ${line}`);
                const options = line.split(/\s+/);
                switch (options[0]) {
                  case "dhcp-option":
                    if (options[1] === "DNS") {
                      dnsServers.push(options[2]);
                    }
                    break;
                  default:
                }
              }
            }
            // remove dns redirect rule
            if (dnsServers.length > 0) {
              await vpnClientEnforcer.unenforceDNSRedirect(ovpnClient.getInterfaceName(), dnsServers);
              // clear dns redirect for all supported interfaces
              for (let supportedInterface in supportedInterfaces) {
                const intfName = supportedInterfaces[supportedInterface];
                await vpnClientEnforcer.unenforceInterfaceDNSRedirect(intfName, ovpnClient.getInterfaceName(), dnsServers);
              }
            }
          });
          await ovpnClient.stop();
        }
        break;
      default:
        log.warn("Unsupported VPN type: " + type);
    }
    return true;
  }

  policyToString() {
    if (this.policy == null || Object.keys(this.policy).length == 0) {
      return "No policy defined";
    } else {
      let msg = "";
      for (let k in this.policy) {
        msg += k + " : " + this.policy[k] + "\n";
      }
      return msg;
    }
  }

  getPolicyFast() {
    return this.policy;
  }

  savePolicy(callback) {
    let key = "policy:system";
    let d = {};
    for (let k in this.policy) {
      const policyValue = this.policy[k];
      if(policyValue !== undefined) {
        d[k] = JSON.stringify(policyValue)
      }
    }
    rclient.hmset(key, d, (err, data) => {
      if (err != null) {
        log.error("Host:Policy:Save:Error", key, err);
      }
      if (callback)
        callback(err, null);
    });

  }

  loadPolicyAsync() {
    return new Promise((resolve, reject) => {
      this.loadPolicy((err, data) => {
        if(err) {
          reject(err)
        } else {
          resolve(data)
        }
      });
    });
  }

  loadPolicy(callback) {
    let key = "policy:system"
    rclient.hgetall(key, (err, data) => {
      if (err != null) {
        log.error("System:Policy:Load:Error", key, err);
        if (callback) {
          callback(err, null);
        }
      } else {
        if (data) {
          this.policy = {};
          for (let k in data) {
            try {
              this.policy[k] = JSON.parse(data[k]);
            } catch (err) {
              log.error(`Failed to parse policy ${k} with value ${data[k]}`, err)
            }
          }
          if (callback)
            callback(null, data);
        } else {
          this.policy = {};
          if (callback)
            callback(null, null);
        }
      }
    });
  }

  execPolicy(skipHosts) {
    this.loadPolicy((err, data) => {
      log.debug("SystemPolicy:Loaded", JSON.stringify(this.policy));
      if (this.type == "server") {
        let PolicyManager = require('./PolicyManager.js');
        let policyManager = new PolicyManager('info');

        policyManager.execute(this, "0.0.0.0", this.policy, (err) => {
          dnsManager.queryAcl(this.policy.acl,(err,acls,ipchanged)=> {
            policyManager.executeAcl(this, "0.0.0.0", acls, (err, changed) => {
              if (ipchanged || (changed == true && err == null)) {
                this.savePolicy(null);
              }
              if (!skipHosts) {
                log.info("Apply host policies...");
                for (let i in this.hosts.all) {
                  this.hosts.all[i].applyPolicy();
                }
              }
            });
          });
        });
      }
    });
  }

  // return a list of mac addresses that's active in last xx days
  getActiveMACs() {
    return hostTool.filterOldDevices(this.hosts.all.map(host => host.o).filter(host => host != null))
  }

  getActiveHumanDevices() {
    const HUMAN_TRESHOLD = 0.05

    this.hosts.all.filter((host) => {
      if(h.o && h.o.mac) {
        const dtype = h.o.dtype
        try {
          const dtypeObject = JSON.parse(dtype)
          const human = dtypeObject.human
          return human > HUMAN_TRESHOLD
        } catch(err) {
          return false
        }
      } else {
        return false
      }
    })
    return this.hosts.all.map(h => h.o.mac).filter(mac => mac != null)
  }

  async getActiveHostsFromSpoofList(limit) {
    let activeHosts = []

    let monitoredIP4s = await rclient.smembersAsync("monitored_hosts")

    for(let i in monitoredIP4s) {
      let ip4 = monitoredIP4s[i]
      let host = this.getHostFast(ip4)
      if(host && host.o.lastActiveTimestamp > limit) {
        activeHosts.push(host)
      }
    }

    let monitoredIP6s = await rclient.smembersAsync("monitored_hosts6")

    for(let i in monitoredIP6s) {
      let ip6 = monitoredIP6s[i]
      let host = this.getHostFast6(ip6)
      if(host && host.o.lastActiveTimestamp > limit) {
        activeHosts.push(host)
      }
    }

    // unique
    activeHosts = activeHosts.filter((elem, pos) => {
      return activeHosts.indexOf(elem) === pos
    })

    return activeHosts
  }

  cleanHostOperationHistory() {
    // reset oper history for each device
    if(this.hosts && this.hosts.all) {
      for(let i in this.hosts.all) {
        let h = this.hosts.all[i]
        if(h.oper) {
          delete h.oper
        }
      }
    }
  }
}
