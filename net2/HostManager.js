/*    Copyright 2016-2021 Firewalla Inc.
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

const rclient = require('../util/redis_manager.js').getRedisClient()

const exec = require('child-process-promise').exec

const ipset = require('./Ipset.js');
const _ = require('lodash');

const timeSeries = require('../util/TimeSeries.js').getTimeSeries()
const util = require('util');
const getHitsAsync = util.promisify(timeSeries.getHits).bind(timeSeries)

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const Spoofer = require('./Spoofer.js');
var spoofer = null;
const sysManager = require('./SysManager.js');
const DNSManager = require('./DNSManager.js');
const dnsManager = new DNSManager('error');
const FlowManager = require('./FlowManager.js');
const flowManager = new FlowManager('debug');
const FlowAggrTool = require('./FlowAggrTool');
const flowAggrTool = new FlowAggrTool();

const FireRouter = require('./FireRouter.js');

const Host = require('./Host.js');

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

const asyncNative = require('../util/asyncNative.js');

const AppTool = require('./AppTool');
const appTool = new AppTool();

const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool()

const tokenManager = require('../util/FWTokenManager.js');

const flowTool = require('./FlowTool.js');

const OpenVPNClient = require('../extension/vpnclient/OpenVPNClient.js');
const vpnClientEnforcer = require('../extension/vpnclient/VPNClientEnforcer.js');

const iptables = require('./Iptables.js');

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()

const NetworkProfileManager = require('./NetworkProfileManager.js');
const TagManager = require('./TagManager.js');
const VPNProfileManager = require('./VPNProfileManager.js');
const Alarm = require('../alarm/Alarm.js');

const CategoryUpdater = require('../control/CategoryUpdater.js');
const categoryUpdater = new CategoryUpdater();

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const SysInfo = require('../extension/sysinfo/SysInfo.js');

const INACTIVE_TIME_SPAN = 60 * 60 * 24 * 7;
const NETWORK_METRIC_PREFIX = "metric:throughput:stat";

let instance = null;

const VpnManager = require('../vpn/VpnManager.js');

const eventApi = require('../event/EventApi.js');

module.exports = class HostManager {
  constructor() {
    if (!instance) {
      this.hosts = {}; // all, active, dead, alarm
      this.hostsdb = {};
      this.hosts.all = [];
      this.callbacks = {};
      this.policy = {};
      spoofer = new Spoofer({}, false);

      let c = require('./MessageBus.js');
      this.messageBus = new c("info");
      this.iptablesReady = false;
      this.spoofing = true;

      // make sure cached host is deleted in all processes
      this.messageBus.subscribe("DiscoveryEvent", "Device:Delete", null, (channel, type, mac, obj) => {
        const host = this.getHostFastByMAC(mac)
        log.info('Removing host cache', mac)

        delete this.hostsdb[`host:ip4:${host.o.ipv4Addr}`]
        log.info('Removing host cache', host.o.ipv4Addr)
        if (Array.isArray(host.ipv6Addr)) {
          host.ipv6Addr.forEach(ip6 => {
            log.info('Removing host cache', ip6)
            delete this.hostsdb[`host:ip6:${ip6}`]
          })
        }
        delete this.hostsdb[`host:mac:${mac}`]

        this.hosts.all = this.hosts.all.filter(host => host.o.mac != mac)
        log.info(this.getHostFastByMAC(mac))
      })

      // ONLY register for these events in FireMain process
      if(f.isMain()) {
        sem.once('IPTABLES_READY', () => {
          log.info("Iptables is ready");
          this.iptablesReady = true;
        })

        // beware that MSG_SYS_NETWORK_INFO_RELOADED will trigger scan from sensors and thus generate Scan:Done event
        // getHosts will be invoked here to reflect updated hosts information
        log.info("Subscribing Scan:Done event...")
        this.messageBus.subscribe("DiscoveryEvent", "Scan:Done", null, (channel, type, ip, obj) => {
          if (!this.iptablesReady) {
            log.warn("Iptables is not ready yet");
            return;
          }
          log.info("New Host May be added rescan");
          this.getHosts((err, result) => {
            if (result && _.isArray(result)) {
              for (const host of result) {
                host.updateHostsFile().catch((err) => {
                  log.error(`Failed to update hosts file for ${host.o.mac}`, err.messsage);
                });
              }
            }
            if (this.callbacks[type]) {
              this.callbacks[type](channel, type, ip, obj);
            }
          });
        });
        this.messageBus.subscribe("DiscoveryEvent", "SystemPolicy:Changed", null, (channel, type, ip, obj) => {
          if (!this.iptablesReady) {
            log.warn("Iptables is not ready yet");
            return;
          }

          this.scheduleExecPolicy();

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

      instance = this;
    }
    return instance;
  }

  scheduleExecPolicy() {
    if (this.execPolicyTask)
      clearTimeout(this.execPolicyTask);
    // set a minimal interval of exec policy to avoid policy apply too frequently
    this.execPolicyTask = setTimeout(() => {
      this.safeExecPolicy();
    }, 3000);
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

  async basicDataForInit(json, options) {
    let networkinfo = sysManager.getDefaultWanInterface();
    if(networkinfo.gateway === null) {
      delete networkinfo.gateway;
    }

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
    json.uptime = process.uptime();

    if(sysManager.language) {
      json.language = sysManager.language;
    } else {
      json.language = 'en'
    }

    json.releaseType = f.getReleaseType()
    if (platform.isFireRouterManaged())
      json.firmwareReleaseType = await FireRouter.getReleaseType();

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

    json.updateTime = Date.now();
    if (sysManager.mySSHPassword() && f.isApi()) {
      json.ssh = sysManager.mySSHPassword();
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
    if (sysManager.sysinfo && sysManager.sysinfo[sysManager.config.monitoringInterface2])
      json.secondaryNetwork = sysManager.sysinfo && sysManager.sysinfo[sysManager.config.monitoringInterface2];
    json.remoteSupport = frp.started;
    json.model = platform.getName();
    json.branch = f.getBranch();
    if(frp.started && f.isApi()) {
      json.remoteSupportStartTime = frp.startTime;
      json.remoteSupportEndTime = frp.endTime;
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
    const sysInfo = SysInfo.getSysInfo();
    json.no_auto_upgrade = sysInfo.no_auto_upgrade;
    json.osUptime = sysInfo.osUptime;
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

  async getStats(statSettings, target) {
    const subKey = target && target != '0.0.0.0' ? ':' + target : '';
    const { granularities, hits} = statSettings;
    const stats = {}
    const metrics = [ 'upload', 'download', 'conn', 'ipB', 'dns', 'dnsB' ]
    for (const metric of metrics) {
      stats[metric] = await getHitsAsync(metric + subKey, granularities, hits)
    }
    return this.generateStats(stats);
  }

  async newLast24StatsForInit(json, target) {
    json.newLast24 = await this.getStats({granularities: '1hour', hits: 24}, target);
  }

  async last12MonthsStatsForInit(json, target) {
    json.last12Months = await this.getStats({granularities: '1month', hits: 12}, target);
  }

  async monthlyDataStats(mac, date) {
    //default calender month
    const now = new Date();
    let days = now.getDate();
    const month = now.getMonth(),
      year = now.getFullYear(),
      lastMonthDays = new Date(year, month, 0).getDate();
    let monthlyBeginTs, monthlyEndTs;
    if (date && date != 1) {
      if (days < date) {
        days = lastMonthDays - date + 1 + days;
        monthlyBeginTs = new Date(year, month - 1, date);
        monthlyEndTs = new Date(year, month, date);
      } else {
        days = days - date + 1;
        monthlyBeginTs = new Date(year, month, date);
        monthlyEndTs = new Date(year, month + 1, date);
      }
    } else {
      monthlyBeginTs = new Date(year, month, 1);
      monthlyEndTs = new Date(year, month + 1, 1);
    }
    const downloadKey = `download${mac ? ':' + mac : ''}`;
    const uploadKey = `upload${mac ? ':' + mac : ''}`;
    const download = await getHitsAsync(downloadKey, '1day', days) || [];
    const upload = await getHitsAsync(uploadKey, '1day', days) || [];
    return Object.assign({
      monthlyBeginTs: monthlyBeginTs / 1000,
      monthlyEndTs: monthlyEndTs / 1000
    }, this.generateStats({ download, upload }))
  }

  async last60MinStatsForInit(json, target) {
    const subKey = target && target != '0.0.0.0' ? ':' + target : ''

    const stats = {}
    const metrics = [ 'upload', 'download', 'conn', 'ipB', 'dns', 'dnsB' ]
    for (const metric of metrics) {
      const s = await getHitsAsync(metric + subKey, "1minute", 61)
      if (s[s.length - 1] && s[s.length - 1][1] == 0) {
        s.pop()
      } else {
        s.shift()
      }
      stats[metric] = s
    }
    json.last60 = this.generateStats(stats)
  }

  async last30daysStatsForInit(json, target) {
    json.last30 = await this.getStats({granularities: '1day', hits: 30}, target);
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
            const portforwardConfig = JSON.parse(data);
            if (portforwardConfig.maps && _.isArray(portforwardConfig.maps))
              portforwardConfig.maps = portforwardConfig.maps.filter(map => map.active !== false);
            extdata['portforward'] = portforwardConfig;
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
    return flowManager.getTargetStats()
      .then((flowsummary) => {
        json.flowsummary = flowsummary;
      });
  }

  async legacyHostsStats(json) {
    log.debug("Reading host legacy stats");

    for (const host of this.hosts.all) {
      host.flowsummary = await flowManager.getTargetStats(host.o.mac)
    }
    await this.loadHostsPolicyRules();
    this.hostsInfoForInit(json);
    return json;
  }

  async dhcpRangeForInit(network, json) {
    const key = network + "DhcpRange";
    let dhcpRange = dnsTool.getDefaultDhcpRange(network);
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

  async ruleGroupsForInit(json) {
    const rgs = policyManager2.getAllRuleGroupMetaData();
    json.ruleGroups = rgs;
  }

  async listLatestAllStateEvents(json) {
    try {
      log.debug("Listing latest all state events");
      const latestAllStateEvents = await eventApi.listLatestStateEventsAll(true);
      if (latestAllStateEvents) json.latestAllStateEvents = latestAllStateEvents;
    } catch (err) {
      log.error("failed to get latest all state events:",err);
    }
  }

  async listLatestErrorStateEvents(json) {
    try {
      log.debug("Listing latest error state events");
      const latestErrorStateEvents = await eventApi.listLatestStateEventsError(true);
      if (latestErrorStateEvents) json.latestStateEventsError = latestErrorStateEvents;
    } catch (err) {
      log.error("failed to get latest error state events:",err);
    }
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
          const screentimeRules = rules.filter(rule=> rule.action == 'screentime');

          rules = rules.filter(rule => {
            if (rule.action == 'screentime') return false;
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
            json.screentimeRules = screentimeRules;
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

  async loadHostsPolicyRules() {
    log.info("Reading individual host policy rules");

    await asyncNative.eachLimit(this.hosts.all, 10, host => host.loadPolicyAsync())
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

  async getCloudURL(json) {
    const url = await rclient.getAsync("sys:bone:url");
    if(json && json.ept && json.ept.url && json.ept.url !== url)  {
      json.ept.url = url;
    }
  }

  async systemdRestartMetrics(json) {
    const result = await rclient.hgetallAsync("stats:systemd:restart");
    json.serviceStartFrequency = result;
  }

  /*
   * data here may be used to recover Firewalla configuration
   */
  async getCheckInAsync() {
    let json = {};
    let requiredPromises = [
      this.getHostsAsync(),
      this.policyDataForInit(json),
      this.extensionDataForInit(json),
      this.modeForInit(json),
      this.policyRulesForInit(json),
      this.exceptionRulesForInit(json),
      this.natDataForInit(json),
      this.getCloudURL(json),
      this.networkConfig(json, true),
      this.networkProfilesForInit(json),
      this.networkMetrics(json),
      this.getCpuUsage(json),
      this.listLatestAllStateEvents(json),
      this.listLatestErrorStateEvents(json),
      this.systemdRestartMetrics(json)
    ]

    await this.basicDataForInit(json, {});

    await Promise.all(requiredPromises);

    json.hostCount = this.hosts.all.length;

    let firstBinding = await rclient.getAsync("firstBinding")
    if(firstBinding) {
      json.firstBinding = firstBinding
    }

    json.bootingComplete = await f.isBootingComplete()

    // Delete anything that may be private
    if (json.ssh) delete json.ssh
    if (json.remoteSupportConnID) delete json.remoteSupportConnID;
    if (json.remoteSupportPassword) delete json.remoteSupportPassword;
    if (json.policy && json.policy.wireguard && json.policy.wireguard.privateKey) delete json.policy.wireguard.privateKey;

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

  async ovpnClientProfilesForInit(json) {
    let profiles = [];
    const dirPath = f.getHiddenFolder() + "/run/ovpn_profile";
    const cmd = "mkdir -p " + dirPath;
    await exec(cmd);
    const files = await fs.readdirAsync(dirPath);
    const ovpns = files.filter(filename => filename.endsWith('.ovpn'));
    Array.prototype.push.apply(profiles, await Promise.all(ovpns.map(async filename => {
      const profileId = filename.slice(0, filename.length - 5);
      const ovpnClient = new OpenVPNClient({ profileId: profileId });
      const passwordPath = ovpnClient.getPasswordPath();
      const profile = { profileId: profileId };
      let password = "";
      if (fs.existsSync(passwordPath)) {
        password = await fs.readFileAsync(passwordPath, "utf8");
        if (password === "dummy_ovpn_password")
          password = ""; // not a real password, just a placeholder
      }
      profile.password = password;
      const userPassPath = ovpnClient.getUserPassPath();
      let user = "";
      let pass = "";
      if (fs.existsSync(userPassPath)) {
        const userPass = await fs.readFileAsync(userPassPath, "utf8");
        const lines = userPass.split("\n", 2);
        if (lines.length == 2) {
          user = lines[0];
          pass = lines[1];
        }
      }
      const settings = await ovpnClient.loadSettings();
      profile.user = user;
      profile.pass = pass;
      profile.settings = settings;
      const status = await ovpnClient.status();
      profile.status = status;
      const stats = await ovpnClient.getStatistics();
      profile.stats = stats;
      return profile;
    })));
    json.ovpnClientProfiles = profiles;
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
    const nicStates = await platform.getNicStates();
    json.nicSpeed = speed;
    json.nicStates = nicStates;
    const versionUpdate = await sysManager.getVersionUpdate();
    if (versionUpdate)
      json.versionUpdate = versionUpdate;
    const customizedCategories = await categoryUpdater.getCustomizedCategories();
    json.customizedCategories = customizedCategories;
    // add connected vpn client statistics
    json.vpnCliStatistics = await new VpnManager().getStatistics();
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

  async getGuardian(json) {
    const data = await rclient.getAsync("ext.guardian.business");
    if(!data) {
      return;
    }

    try {
      const result = JSON.parse(data);
      if(result) {
        json.guardianBiz = result;
      }
    } catch(err) {
      log.error(`Failed to parse data, err: ${err}`);
      return;
    }
  }

  async getDataUsagePlan(json) {
    const enable = fc.isFeatureOn('data_plan');
    const data = await rclient.getAsync('sys:data:plan');
    if(!data || !enable) {
      return;
    }

    try {
      const result = JSON.parse(data);
      if(result) {
        json.dataUsagePlan = result;
      }
    } catch(err) {
      log.error(`Failed to parse sys:data:plan, err: ${err}`);
      return;
    }
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

  async networkConfig(json, filterSensitive = false) {
    if (!platform.isFireRouterManaged())
      return;
    const config = FireRouter.getConfig();
    if (filterSensitive && config && config.interface && config.interface.pppoe) {
      for (const key in config.interface.pppoe) {
        const temp = _.omit(config.interface.pppoe[key], ['password', 'username']);
        config.interface.pppoe[key] = temp;
      }
    }
    json.networkConfig = config;
  }

  async tagsForInit(json) {
    await TagManager.refreshTags();
    json.tags = await TagManager.toJson();
  }

  async btMacForInit(json) {
    json.btMac = await rclient.getAsync("sys:bt:mac");
  }

  async networkProfilesForInit(json) {
    await NetworkProfileManager.refreshNetworkProfiles();
    json.networkProfiles = await NetworkProfileManager.toJson();
  }

  async getVPNInterfaces() {
      let intfs;
      try {
          const result = await exec("ls -l /sys/class/net | awk '/vpn_|tun_/ {print $9}'")
          intfs = result.stdout.split("\n").filter(line => line.length > 0);
      } catch (err) {
          log.error("failed to get VPN interfaces: ",err);
          intfs = [];
      }
      return intfs;
  }

  async networkMetrics(json) {
    try {
      const config = FireRouter.getConfig();
      const ethxs =  Object.keys(config.interface.phy);
      const vpns = await this.getVPNInterfaces();
      const ifs = [ ...ethxs, ...vpns ];
      let nm = {};
      await Promise.all(ifs.map( async (ifx) => {
          nm[ifx] = nm[ifx] || {};
          nm[ifx]['rx'] = await rclient.hgetallAsync(`${NETWORK_METRIC_PREFIX}:${ifx}:rx`);
          nm[ifx]['tx'] = await rclient.hgetallAsync(`${NETWORK_METRIC_PREFIX}:${ifx}:tx`);
      }));
      json.networkMetrics = nm;
    } catch (err) {
      log.error("failed to get network metrics from redis: ", err);
      json.networkMetrics = {};
    }
  }

  async getCpuUsage(json) {
    let result = {};
    try{
      const psOutput = await exec("ps -e -o %cpu=,cmd= | awk '$2~/Fire[AM]/ {print $0}'");
      psOutput.stdout.match(/[^\n]+/g).forEach( line => {
        const columns = line.match(/[^ ]+/g);
        result[columns[1]] = columns[0];
      })
    } catch(err) {
      log.error("failed to get CPU usage with ps: ", err);
    }
    json.cpuUsage = result;
  }

  async vpnProfilesForInit(json) {
    await VPNProfileManager.refreshVPNProfiles();
    json.vpnProfiles = await VPNProfileManager.toJson();
  }

  toJson(includeHosts, options, callback) {

    if(typeof options === 'function') {
      callback = options;
      options = {}
    } else if (!options) {
      options = {}
    }

    let json = {};

    this.getHosts(async () => {
      try {

        let requiredPromises = [
          this.last24StatsForInit(json),
          this.newLast24StatsForInit(json),
          this.last60MinStatsForInit(json),
          this.extensionDataForInit(json),
          this.last30daysStatsForInit(json),
          this.last12MonthsStatsForInit(json),
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
          this.getGuessedRouters(json),
          this.getGuardian(json),
          this.getDataUsagePlan(json),
          this.networkConfig(json),
          this.networkProfilesForInit(json),
          this.networkMetrics(json),
          this.vpnProfilesForInit(json),
          this.tagsForInit(json),
          this.btMacForInit(json),
          this.loadStats(json),
          this.ovpnClientProfilesForInit(json),
          this.ruleGroupsForInit(json),
          this.listLatestAllStateEvents(json),
          this.listLatestErrorStateEvents(json)
        ];
        const platformSpecificStats = platform.getStatsSpecs();
        json.stats = {};
        for (const statSettings of platformSpecificStats) {
          requiredPromises.push(this.getStats(statSettings)
            .then(s => json.stats[statSettings.stat] = s)
          )
        }
        await Promise.all(requiredPromises)

        await this.basicDataForInit(json, options);

        await Promise.all(requiredPromises);

        // mode should already be set in json
        if (json.mode === "dhcp") {
          await this.dhcpRangeForInit("alternative", json);
          await this.dhcpRangeForInit("secondary", json);
          json.dhcpServerStatus = await rclient.getAsync("sys:scan:dhcpserver");
        }

        await this.loadDDNSForInit(json);

        await this.legacyHostFlag(json)

        json.nameInNotif = await rclient.hgetAsync("sys:config", "includeNameInNotification")
        const fnlFlag = await rclient.hgetAsync("sys:config", "forceNotificationLocalization");
        if(fnlFlag === "1") {
          json.forceNotifLocal = true;
        } else {
          json.forceNotifLocal = false;
        }

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

        const suffix = await rclient.getAsync('local:domain:suffix');
        json.localDomainSuffix = suffix ? suffix : 'lan';
        json.cpuProfile = await this.getCpuProfile();
        callback(null, json);
      } catch(err) {
        log.error("Caught error when preparing init data: " + err);
        log.error(err.stack);
        callback(err);
      }
    });
  }

  getHostFastByMAC(mac) {
    if (mac == null) {
      return null;
    }

    return this.hostsdb[`host:mac:${mac}`];
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
      o = await hostTool.getMACEntry(target)
      if (host) {
        o && host.update(o);
        return host;
      }


    } else {
      o = await dnsManager.resolveLocalHostAsync(target)

      host = this.hostsdb[`host:ip4:${o.ipv4Addr}`];

      if (host) {
        o && host.update(o);
        return host
      }
    }

    if (o == null) return null;

    host = new Host(o);

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

  async syncHost(host, save) {
    if (host.o.mac == null) {
      log.error("HostManager:Sync:Error:MacNull", host.o.mac, host.o.ipv4Addr, host.o);
      throw new Error("No mac")
    }
    let mackey = "host:mac:" + host.o.mac;
    await host.identifyDevice(false);
    let data = await rclient.hgetallAsync(mackey)
    if (!data) return;

    let ipv6array = data.ipv6Addr ? JSON.parse(data.ipv6Addr) : [];
    if (host.ipv6Addr == null) {
      host.ipv6Addr = [];
    }

    let needsave = false;

    // if updated ipv6 array is not same as the old ipv6 array, need to save the new ipv6 array to redis host:mac:
    // the number of addresses in new array is usually fewer than the old since Host.cleanV6() cleans up the expired addresses
    if (ipv6array.some(a => !host.ipv6Addr.includes(a)) || host.ipv6Addr.some(a => !ipv6array.includes(a)))
      needsave = true;

    sysManager.setNeighbor(host.o.ipv4Addr);

    for (let j in host.ipv6Addr) {
      sysManager.setNeighbor(host.ipv6Addr[j]);
    }

    host.redisfy();
    if (needsave == true && save == true) {
      await rclient.hmsetAsync(mackey, {
        ipv6Addr: host.o.ipv6Addr
      });
    }
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

  getHosts(callback) {
    callback = callback || function(){}

    util.callbackify(this.getHostsAsync).bind(this)(callback)
  }

  // super resource-heavy function, be careful when calling this
  async getHostsAsync() {
    log.info("getHosts: started");

    // Only allow requests be executed in a frenquency lower than 1 every 5 mins
    const getHostsActiveExpire = Math.floor(new Date() / 1000) - 60 * 5 // 5 mins
    if (this.getHostsActive && this.getHostsActive > getHostsActiveExpire) {
      log.info("getHosts: too frequent, returning cache");
      if(this.hosts.all && this.hosts.all.length>0){
        return this.hosts.all
      }
    }

    this.getHostsActive = Math.floor(new Date() / 1000);
    // end of mutx check

    if(f.isMain()) {
      this.safeExecPolicy(true); // do not apply host policy here, since host information may be out of date. Host policy will be applied later after information is refreshed from host:mac:*
    }
    for (let h in this.hostsdb) {
      if (this.hostsdb[h]) {
        this.hostsdb[h]._mark = false;
      }
    }
    const keys = await rclient.keysAsync("host:mac:*");
    let multiarray = [];
    for (let i in keys) {
      multiarray.push(['hgetall', keys[i]]);
    }
    let inactiveTimeline = Date.now()/1000 - INACTIVE_TIME_SPAN; // one week ago
    const replies = await rclient.multi(multiarray).execAsync();
    await asyncNative.eachLimit(replies, 2, async (o) => {
      if (!o) {
        // defensive programming
        return;
      }
      if (o.ipv4) {
        o.ipv4Addr = o.ipv4;
      }
      if (o.ipv4Addr == null) {
        log.debug("getHosts: no ipv4", o.uid, o.mac); // probably just offline/inactive
        return;
      }
      if (!sysManager.isLocalIP(o.ipv4Addr) || o.lastActiveTimestamp <= inactiveTimeline) {
        return
      }
      //log.info("Processing GetHosts ",o);
      let hostbymac = this.hostsdb["host:mac:" + o.mac];
      let hostbyip = this.hostsdb["host:ip4:" + o.ipv4Addr];

      if (hostbymac == null) {
        hostbymac = new Host(o);
        this.hosts.all.push(hostbymac);
        // do not update host:ip4 entries in this.hostsdb since it may be previously occupied by other host
        // it will be updated later by checking if there is double mapping
        // this.hostsdb['host:ip4:' + o.ipv4Addr] = hostbymac;
        this.hostsdb['host:mac:' + o.mac] = hostbymac;

        let ipv6Addrs = hostbymac.ipv6Addr
        if(ipv6Addrs && ipv6Addrs.constructor.name === 'Array') {
          for(let i in ipv6Addrs) {
            let ip6 = ipv6Addrs[i]
            // ipv6 address conflict hardly happens, so update here is relatively safe
            let key = `host:ip6:${ip6}`
            this.hostsdb[key] = hostbymac
          }
        }

      } else {
        if (o.ipv4 != hostbymac.o.ipv4) {
          // the physical host get a new ipv4 address
          // remove host:ip4 entry from this.hostsdb only if the entry belongs to this mac
          if (hostbyip && hostbyip.o.mac === o.mac)
            this.hostsdb['host:ip4:' + hostbymac.o.ipv4] = null;
        }
        // do not update host:ip4 entries here for the same reason in if cause
        // this.hostsdb['host:ip4:' + o.ipv4] = hostbymac;

        try {
          const ipv6Addr = o.ipv6Addr && JSON.parse(o.ipv6Addr) || []
          if (hostbymac.ipv6Addr && Array.isArray(hostbymac.ipv6Addr)) {
            // verify if old ipv6 addresses in 'hostbymac' still exists in new record in 'o'
            for (const oldIpv6 of hostbymac.ipv6Addr) {
              if (!ipv6Addr.includes(oldIpv6)) {
                // the physical host dropped old ipv6 address
                this.hostsdb['host:ip6:' + oldIpv6] = null;
              }
            }
          }
          for (const newIpv6 of ipv6Addr) {
            this.hostsdb['host:ip6:' + newIpv6] = hostbymac;
          }
        } catch(err) {
          log.error('Failed to check v6 address of', o.mac, err)
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
          log.info(`${hostbymac.o.mac} is more up-to-date than ${hostbyip.o.mac}`);
          this.hostsdb['host:ip4:' + o.ipv4Addr] = hostbymac;
        } else {
          log.info(`${hostbyip.o.mac} is more up-to-date than ${hostbymac.o.mac}`);
          this.hostsdb['host:ip4:' + o.ipv4Addr] = hostbyip;
        }
      } else {
        // update host:ip4 entries in this.hostsdb here if it is a new IPv4 address or belongs to the same device
        this.hostsdb['host:ip4:' + o.ipv4Addr] = hostbymac;
      }
      await hostbymac.cleanV6()
      if (f.isMain()) {
        await hostbymac.applyPolicyAsync()
        // call apply policy before to ensure policy data is loaded before device indentification
        await this.syncHost(hostbymac, true)
      }
    })
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

    for (let h in this.hostsdb) {
      let hostbymac = this.hostsdb[h];
      if (hostbymac && h.startsWith("host:mac")) {
        if (hostbymac.ipv6Addr!=null && hostbymac.ipv6Addr.length>0) {
          if (hostbymac.o.ipv4Addr && !sysManager.isMyIP(hostbymac.o.ipv4Addr)) {   // local ipv6 do not count
            allIPv6Addrs = allIPv6Addrs.concat(hostbymac.ipv6Addr);
          }
        }
        if (hostbymac.o.ipv4Addr!=null && !sysManager.isMyIP(hostbymac.o.ipv4Addr)) {
          allIPv4Addrs.push(hostbymac.o.ipv4Addr);
        }
      }
      if (this.hostsdb[h] && this.hostsdb[h]._mark == false) {
        let index = this.hosts.all.indexOf(this.hostsdb[h]);
        if (index!=-1) {
          this.hosts.all.splice(index,1);
          log.info("Removing host due to sweeping", h);
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
    log.debug("removing:hosts", removedHosts);
    this.hosts.all.sort(function (a, b) {
      return Number(b.o.lastActiveTimestamp) - Number(a.o.lastActiveTimestamp);
    })
    this.getHostsActive = null;
    if (f.isMain()) {
      spoofer.validateV6Spoofs(allIPv6Addrs);
      spoofer.validateV4Spoofs(allIPv4Addrs);
    }
    log.info("done Devices: ",this.hosts.all.length," ipv6 addresses ",allIPv6Addrs.length );
    if (f.isMain()) {
      const Dnsmasq = require('../extension/dnsmasq/dnsmasq.js');
      const dnsmasq = new Dnsmasq();
      dnsmasq.onDHCPReservationChanged(); // trigger dhcp hosts file update
    }
    return this.hosts.all;
  }

  setPolicy(name, data, callback) {
    if (!callback) callback = function() {}
    return util.callbackify(this.setPolicyAsync).bind(this)(name, data, callback)
  }

  async setPolicyAsync(name, data) {
    await this.loadPolicyAsync()
    if (this.policy[name] != null && this.policy[name] == data) {
      log.debug("System:setPolicy:Nochange", name, data);
      return;
    }
    this.policy[name] = data;
    log.debug("System:setPolicy:Changed", name, data);

    await this.saveSinglePolicy(name)
    let obj = {};
    obj[name] = data;
    log.debug(name, obj)
    if (this.messageBus) {
      this.messageBus.publish("DiscoveryEvent", "SystemPolicy:Changed", null, obj);
    }
    return obj
  }

  isMonitoring() {
    return this.spoofing;
  }

  async qos(policy) {
    let state = null;
    let qdisc = "fq_codel";
    switch (typeof policy) {
      case "boolean":
        state = policy;
        break;
      case "object":
        state = policy.state;
        qdisc = policy.qdisc || "fq_codel";
        break;
      default:
        return;
    }
    await platform.switchQoS(state, qdisc);
  }

  async acl(state) {
    if (state == false) {
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_ACL_OFF} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4}`).catch((err) => {
        log.error(`Failed to add ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4} to ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_ACL_OFF} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6}`).catch((err) => {
        log.error(`Failed to add ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6} to ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
    } else {
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_ACL_OFF} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4}`).catch((err) => {
        log.error(`Failed to remove ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4} from ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_ACL_OFF} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6}`).catch((err) => {
        log.error(`Failed to remove ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6} from ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
    }
  }

  async spoof(state) {
    this.spoofing = state;
    const sm = new SpooferManager();
    if (state == false) {
      // create dev flag file if it does not exist, and restart bitbridge
      // bitbridge binary will be replaced with mock file if this flag file exists
      await fs.accessAsync(`${f.getFirewallaHome()}/bin/dev`, fs.constants.F_OK).catch((err) => {
        return exec(`touch ${f.getFirewallaHome()}/bin/dev`).then(() => {
          sm.scheduleReload();
        });
      });
    } else {
      const redisSpoofOff = await rclient.getAsync('sys:bone:spoofOff');
      if (redisSpoofOff) {
        return;
      }
      // remove dev flag file if it exists and restart bitbridge
      await fs.accessAsync(`${f.getFirewallaHome()}/bin/dev`, fs.constants.F_OK).then(() => {
        return exec(`rm ${f.getFirewallaHome()}/bin/dev`).then(() => {
          sm.scheduleReload();
        });
      }).catch((err) => {});
    }
  }

  async enhancedSpoof(state) {
    await modeManager.toggleCompatibleSpoof(state);
  }

  async shield(policy) {

  }

  async getVpnActiveDeviceCount(profileId) {
    let activeDevices = this.getActiveHumanDevices();
    let iCount = 0;
    for (const mac of activeDevices) {
      const policy = await hostTool.loadDevicePolicyByMAC(mac);
      if (policy && policy["vpnClient"]) {
        try {
          const vpnClientConfig = JSON.parse(policy["vpnClient"]);
          if (vpnClientConfig.state && vpnClientConfig.profileId == profileId)
            iCount += 1;
        } catch (err) {
          log.error(`Failed to parse policy`, err)
        }
      }
    }
    return iCount;
  }

  async vpnClient(policy) {
    const type = policy.type;
    const state = policy.state;
    const reconnecting = policy.reconnecting || 0;
    switch (type) {
      case "openvpn": {
        const profileId = policy.openvpn && policy.openvpn.profileId;
        if (!profileId) {
          log.error("profileId is not specified", policy);
          return {state: false, running: false, reconnecting: 0};
        }
        let settings = policy.openvpn && policy.openvpn.settings || {};
        const ovpnClient = new OpenVPNClient({profileId: profileId});
        await ovpnClient.saveSettings(settings);
        settings = await ovpnClient.loadSettings(); // settings is merged with default settings
        const rtId = await vpnClientEnforcer.getRtId(ovpnClient.getInterfaceName());
        if (!rtId) {
          log.error(`Routing table id is not found for ${profileId}`);
          return {state: false, running: false, reconnecting: 0};
        }
        if (state === true) {
          let setupResult = true;
          await ovpnClient.setup().catch((err) => {
            // do not return false here since following start() operation should fail
            log.error(`Failed to setup openvpn client for ${profileId}`, err);
            setupResult = false;
          });
          if (!setupResult)
            return {state: false, running: false, reconnecting: 0};
          if (ovpnClient.listenerCount('push_options_start') === 0) {
            ovpnClient.once('push_options_start', async (content) => {
              const dnsServers = ovpnClient.getPushedDNSSServers() || [];
              // redirect dns to vpn channel
              if (dnsServers.length > 0) {
                if (settings.routeDNS) {
                  await vpnClientEnforcer.enforceDNSRedirect(ovpnClient.getInterfaceName(), dnsServers, await ovpnClient.getRemoteIP());
                } else {
                  await vpnClientEnforcer.unenforceDNSRedirect(ovpnClient.getInterfaceName(), dnsServers, await ovpnClient.getRemoteIP());
                }
              }

              const updatedPolicy = this.policy["vpnClient"];
              if (settings.strictVPN) {
                if (updatedPolicy && updatedPolicy.waitresume && updatedPolicy.waitresume == 1 && fc.isFeatureOn("vpn_restore")){
                  const device_cout = await this.getVpnActiveDeviceCount(profileId);
                  let alarm = new Alarm.VPNRestoreAlarm(
                    new Date() / 1000,
                    null,
                    {
                      'p.vpn.profileid': profileId,
                      'p.vpn.subtype': settings && settings.subtype,
                      'p.vpn.devicecount': device_cout,
                      'p.vpn.displayname': (settings && (settings.displayName || settings.serverBoxName)) || profileId,
                      'p.vpn.strictvpn': settings && settings.strictVPN || false
                    }
                  );
                  await alarmManager2.enqueueAlarm(alarm);
                }
              }
              if (updatedPolicy) {
                updatedPolicy.waitresume = 0;
                updatedPolicy.running = true;
                await this.setPolicyAsync("vpnClient", updatedPolicy);
              }
            });
          }
          const result = await ovpnClient.start();
          // apply strict VPN option even no matter whether VPN client is started successfully
          if (settings.overrideDefaultRoute && settings.strictVPN) {
            await vpnClientEnforcer.enforceStrictVPN(ovpnClient.getInterfaceName());
          } else {
            await vpnClientEnforcer.unenforceStrictVPN(ovpnClient.getInterfaceName());
          }
          // enable VPN client chain in mangle PREROUTING chain
          await iptables.switchVPNClientAsync(true, 4);
          await iptables.switchVPNClientAsync(true, 6);
          if (result) {
            if (ovpnClient.listenerCount('link_broken') === 0) {
              ovpnClient.once('link_broken', async () => {
                const updatedPolicy = this.policy["vpnClient"];
                if (!updatedPolicy) return;
                updatedPolicy.running = false;
                settings = await ovpnClient.loadSettings(); // reload settings in case settings is changed
                // increment reconnecting count and trigger reconnection
                updatedPolicy.reconnecting = (updatedPolicy.reconnecting || 0) + 1;
                await this.setPolicyAsync("vpnClient", updatedPolicy);
                if (fc.isFeatureOn("vpn_disconnect")) {
                  const broken_time = new Date() / 1000;
                  setTimeout(async () => {
                    // sem.sendEventToFireApi({
                    //   type: 'FW_NOTIFICATION',
                    //   titleKey: 'NOTIF_VPN_CLIENT_LINK_BROKEN_TITLE',
                    //   bodyKey: 'NOTIF_VPN_CLIENT_LINK_BROKEN_BODY',
                    //   titleLocalKey: 'VPN_CLIENT_LINK_BROKEN',
                    //   bodyLocalKey: 'VPN_CLIENT_LINK_BROKEN',
                    //   bodyLocalArgs: [(settings && (settings.displayName || settings.serverBoxName)) || profileId],
                    //   payload: {
                    //     profileId: (settings && (settings.displayName || settings.serverBoxName)) || profileId
                    //   }
                    // });
                    const updatedPolicy = this.policy["vpnClient"];
                    if (!updatedPolicy) return;
                    if (!updatedPolicy.running) {
                      const device_cout = await this.getVpnActiveDeviceCount(profileId);
                      let alarm = new Alarm.VPNDisconnectAlarm(
                        broken_time,
                        null,
                        {
                          'p.vpn.profileid': profileId,
                          'p.vpn.subtype': settings && settings.subtype,
                          'p.vpn.devicecount': device_cout,
                          'p.vpn.displayname': (settings && (settings.displayName || settings.serverBoxName)) || profileId,
                          'p.vpn.strictvpn': settings && settings.strictVPN || false
                        }
                      );
                      await alarmManager2.enqueueAlarm(alarm);
                      updatedPolicy.waitresume = (settings.strictVPN) ? 1 : 0;
                      await this.setPolicyAsync("vpnClient", updatedPolicy);
                    }
                  }, 2 * 60 * 1000);
                }
              });
            }
          }
          // clear reconnecting count if successfully connected, otherwise increment the reconnecting count
          return {running: result, reconnecting: (state === true && result === true ? 0 : reconnecting + 1)};
        } else {
          // proceed to stop anyway even if setup is failed
          await ovpnClient.setup().catch((err) => {
            log.error(`Failed to setup openvpn client for ${profileId}`, err);
          });
          ovpnClient.once('push_options_stop', async (content) => {
            const dnsServers = ovpnClient.getPushedDNSSServers() || [];
            if (dnsServers.length > 0) {
              // always attempt to remove dns redirect rule, no matter whether 'routeDNS' in set in settings
              await vpnClientEnforcer.unenforceDNSRedirect(ovpnClient.getInterfaceName(), dnsServers, await ovpnClient.getRemoteIP());
            }

            const updatedPolicy = this.policy["vpnClient"];
            if (!updatedPolicy) return;
            updatedPolicy.waitresume = 0;
            await this.setPolicyAsync("vpnClient", updatedPolicy);
          });
          await ovpnClient.stop();
          // will do no harm to unenforce strict VPN even if strict VPN is not set
          await vpnClientEnforcer.unenforceStrictVPN(ovpnClient.getInterfaceName());
          // disable VPN client chain in mangle PREROUTING chain
          await iptables.switchVPNClientAsync(false, 4);
          await iptables.switchVPNClientAsync(false, 6);
          return {running: false, reconnecting: 0};
        }
        break;
      }
      default:
        log.warn("Unsupported VPN type: " + type);
    }
    // do not change state or running by default
    return {};
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

  async savePolicy() {
    let key = "policy:system";
    let d = {};
    for (let k in this.policy) {
      const policyValue = this.policy[k];
      if(policyValue !== undefined) {
        d[k] = JSON.stringify(policyValue)
      }
    }
    await rclient.hmset(key, d)
  }

  async saveSinglePolicy(name) {
    await rclient.hmset('policy:system', name, JSON.stringify(this.policy[name]))
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

  loadPolicy(callback = () => {}) {
    let key = "policy:system"
    rclient.hgetall(key, (err, data) => {
      if (err != null) {
        log.error("System:Policy:Load:Error", key, err);
        callback(err, null);
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
          callback(null, data);
        } else {
          this.policy = {};
          callback(null, null);
        }
      }
    });
  }

  execPolicy(skipHosts) {
    this.loadPolicy((err, data) => {
      log.debug("SystemPolicy:Loaded", JSON.stringify(this.policy));
      if (f.isMain()) {
        let PolicyManager = require('./PolicyManager.js');
        let policyManager = new PolicyManager('info');

        policyManager.execute(this, "0.0.0.0", this.policy, (err) => {
          if (!skipHosts) {
            log.info("Apply host policies...");
            for (let i in this.hosts.all) {
              this.hosts.all[i].scheduleApplyPolicy();
            }
          }
        });
      }
    });
  }

  // return a list of mac addresses that's active in last xx days
  getActiveMACs() {
    return hostTool.filterOldDevices(this.hosts.all.filter(Boolean)).map(host => host.o.mac);
  }

  // return: Array<{intf: string, macs: Array<string>}>
  getActiveIntfs() {
    let inftMap = {};
    hostTool.filterOldDevices(this.hosts.all.filter(host => host && host.o.intf))
      .forEach(host => {
        host = host.o
        if (inftMap[host.intf]) {
          inftMap[host.intf].push(host.mac);
        } else {
          inftMap[host.intf] = [host.mac];
        }
      });

    return _.map(inftMap, (macs, intf) => {
      return {intf, macs: _.uniq(macs)};
    });
  }

  // need active host?
  getIntfMacs(intf) {
    let macs = this.hosts.all.filter(host => host && host.o.intf && (host.o.intf == intf)).map(host => host.o.mac);
    return _.uniq(macs);
  }

  // return: Array<{tag: number, macs: Array<string>}>
  async getActiveTags() {
    let tagMap = {};
    await this.loadHostsPolicyRules()
    hostTool.filterOldDevices(this.hosts.all.filter(host => host && host.policy && !_.isEmpty(host.policy.tags)))
      .forEach(host => {
        for (const tag of host.policy.tags) {
          if (tagMap[tag]) {
            tagMap[tag].push(host.o.mac);
          } else {
            tagMap[tag] = [host.o.mac];
          }
        }
      });

    return _.map(tagMap, (macs, tag) => {
      return {tag, macs: _.uniq(macs)};
    });
  }

  // need active host?
  async getTagMacs(tag) {
    await this.loadHostsPolicyRules()
    tag = tag.toString();
    const macs = this.hosts.all.filter(host => {
      return host.o && host.policy && !_.isEmpty(host.policy.tags) && host.policy.tags.includes(tag)
    }).map(host => host.o.mac);
    return _.uniq(macs);
  }

  getActiveHumanDevices() {
    const HUMAN_TRESHOLD = 0.05

    this.hosts.all.filter((h) => {
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

  generateStats(stats) {
    const result = {}
    for (const metric in stats) {
      result[metric] = stats[metric]
      result['total' + metric[0].toUpperCase() + metric.slice(1) ] = _.sumBy(stats[metric], 1)
    }
    return result
  }

  async loadStats(json={}, target='', count=50) {
    target = target == '0.0.0.0' ? '' : target;
    const systemFlows = {};

    const keys = ['upload', 'download', 'ipB', 'dnsB'];

    for (const key of keys) {
      const lastSumKey = target ? `lastsumflow:${target}:${key}` : `lastsumflow:${key}`;
      const realSumKey = await rclient.getAsync(lastSumKey);
      if (!realSumKey) {
        continue;
      }

      const elements = target ? realSumKey.replace(`${target}:`,'').split(":") : realSumKey.split(":");
      if (elements.length !== 4) {
        continue;
      }

      const begin = elements[2];
      const end = elements[3];

      const traffic = await flowAggrTool.getTopSumFlowByKeyAndDestination(realSumKey, key, count);

      const enriched = (await flowTool.enrichWithIntel(traffic)).sort((a, b) => {
        return b.count - a.count;
      });

      systemFlows[key] = {
        begin,
        end,
        flows: enriched
      }
    }

    const actitivityKeys = ['app', 'category'];

    for (const key of actitivityKeys) {

      const lastSumKey = target ? `lastsumflow:${target}:${key}` : `lastsumflow:${key}`;
      const realSumKey = await rclient.getAsync(lastSumKey);
      if (!realSumKey) {
        continue;
      }

      const elements = target ? realSumKey.replace(`${target}:`,'').split(":") : realSumKey.split(":");
      if (elements.length !== 4) {
        continue;
      }

      const begin = elements[2];
      const end = elements[3];

      const traffic = await flowAggrTool.getXYActivitySumFlowByKey(realSumKey, key, count);

      traffic.sort((a, b) => {
        return b.count - a.count;
      });

      systemFlows[key] = {
        begin,
        end,
        activities: traffic
      }
    }

    json.systemFlows = systemFlows;
    return systemFlows;
  }
  async getCpuProfile() {
    try {
      const name = await rclient.getAsync('platform:profile:active');
      const content = name ? await rclient.hgetAsync('platform:profile', name) : null;
      if (name && content) {
        return {
          name: name,
          content: content
        }
      }
    } catch (e) {
      log.warn('getCpuProfile error', e)
    }
  }
}
