/*    Copyright 2016-2023 Firewalla Inc.
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
const MessageBus = require('./MessageBus.js');
const messageBus = new MessageBus('info')

const exec = require('child-process-promise').exec

const ipset = require('./Ipset.js');
const _ = require('lodash');

const timeSeries = require('../util/TimeSeries.js').getTimeSeries()
const util = require('util');
const getHitsAsync = util.promisify(timeSeries.getHits).bind(timeSeries)

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const spoofer = require('./Spoofer')
const sysManager = require('./SysManager.js');
const DNSManager = require('./DNSManager.js');
const dnsManager = new DNSManager('error');
const FlowAggrTool = require('./FlowAggrTool');
const flowAggrTool = new FlowAggrTool();

const FireRouter = require('./FireRouter.js');

const Host = require('./Host.js');

const FRPManager = require('../extension/frp/FRPManager.js')
const fm = new FRPManager()
const frp = fm.getSupportFRP()

const sem = require('../sensor/SensorEventManager.js').getInstance();
const sensorLoader = require('../sensor/SensorLoader.js');

const AlarmManager2 = require('../alarm/AlarmManager2.js');
const alarmManager2 = new AlarmManager2();

const PolicyManager2 = require('../alarm/PolicyManager2.js');
const policyManager2 = new PolicyManager2();

const ExceptionManager = require('../alarm/ExceptionManager.js');
const exceptionManager = new ExceptionManager();

const sm = require('./SpooferManager.js')

const modeManager = require('./ModeManager.js');
const Mode = require('./Mode.js');

const f = require('./Firewalla.js');

const license = require('../util/license.js')

const fConfig = require('./config.js').getConfig();

const fc = require('./config.js')

const asyncNative = require('../util/asyncNative.js');

const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool()

const tokenManager = require('../util/FWTokenManager.js');

const flowTool = require('./FlowTool.js');

const VPNClient = require('../extension/vpnclient/VPNClient.js');
const vpnClientEnforcer = require('../extension/vpnclient/VPNClientEnforcer.js');

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()

const NetworkProfileManager = require('./NetworkProfileManager.js');
const TagManager = require('./TagManager.js');
const IdentityManager = require('./IdentityManager.js');
const VirtWanGroupManager = require('./VirtWanGroupManager.js');

const CategoryUpdater = require('../control/CategoryUpdater.js');
const categoryUpdater = new CategoryUpdater();

const Dnsmasq = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new Dnsmasq();

const fs = require('fs');

const SysInfo = require('../extension/sysinfo/SysInfo.js');

const INACTIVE_TIME_SPAN = 60 * 60 * 24 * 7;
const RAPID_INACTIVE_TIME_SPAN = 60 * 60 * 6;
const NETWORK_METRIC_PREFIX = "metric:throughput:stat";

let instance = null;
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const Message = require('../net2/Message.js');
const moment = require('moment-timezone/moment-timezone.js');
moment.tz.load(require('../vendor_lib/moment-tz-data.json'));

const eventApi = require('../event/EventApi.js');
const Metrics = require('../extension/metrics/metrics.js');
const Constants = require('./Constants.js');
const { Rule, wrapIptables } = require('./Iptables.js');
const QoS = require('../control/QoS.js');
const Monitorable = require('./Monitorable.js')
const AsyncLock = require('../vendor_lib/async-lock');
const TimeUsageTool = require('../flow/TimeUsageTool.js');
const NetworkProfile = require('./NetworkProfile.js');
const lock = new AsyncLock();

module.exports = class HostManager extends Monitorable {
  constructor() {
    if (!instance) {
      super({})
      this.hosts = {}; // all, active, dead, alarm
      this.hostsdb = {};
      this.hosts.all = [];
      this.spoofing = true;

      // make sure cached host is created/deleted in all processes
      messageBus.subscribe("DiscoveryEvent", "Device:Create", null, (channel, type, mac, obj) => {
        this.createHost(obj).catch(err => {
          log.error('Error creating host', err, obj)
        })
      })
      messageBus.subscribe("DiscoveryEvent", "Device:Delete", null, async (channel, type, mac, obj) => {
        let host = this.getHostFastByMAC(mac)
        log.info('Removing host cache', mac)
        if (!host)
          host = await this.getHostAsync(mac, true); // do not create env for host as it will be destroyed soon
        if (!host) {
          log.warn(`Cannot find host with MAC address: ${mac}`);
          return;
        }

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
        await host.destroy().catch((err) => {
          log.error(`Failed to destroy device ${mac}`, err.message);
        });
      })

      sclient.subscribe(Message.MSG_SYS_TIMEZONE_RELOADED);

      // ONLY register for these events in FireMain process
      if(f.isMain()) {
        sem.once('IPTABLES_READY', async () => {
          try {
            await this.getHostsAsync()
            this.scheduleApplyPolicy()
          } catch(err) {
            log.error('Failed to initalize system', err)
          }

          sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, async () => {
            // global qos config will be applied to default WAN, need to re-apply in case of network change
            if (this.policy && _.has(this.policy, "qos"))
              await this.qos(this.policy.qos);
          })

          setInterval(() => this.validateSpoofs(), 5 * 60 * 1000)
        })

        // beware that MSG_SYS_NETWORK_INFO_RELOADED will trigger scan from sensors and thus generate Scan:Done event
        // getHosts will be invoked here to reflect updated hosts information
        log.info("Subscribing Scan:Done event...")
        messageBus.subscribe("DiscoveryEvent", "Scan:Done", null, (channel, type, ip, obj) => {
          if (!sysManager.isIptablesReady()) {
            log.warn(channel, type, "Iptables is not ready yet, skipping...");
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
          });
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

  async save() { /* do nothing */ }

  async keepalive() {
    const mode = await modeManager.mode();
    // keepalive ping devices' IPv6 addresses to keep bitbridge6 working properly, no need to do this in other modes
    if (mode !== Mode.MODE_AUTO_SPOOF)
      return;
    log.info("HostManager:Keepalive");
    for (let i in this.hostsdb) {
      if (i.startsWith("host:mac")) {
        let _h = this.hostsdb[i];
        _h.keepalive();
      }
    }
  }

  validateSpoofs() {
    const allIPv6Addrs = [];
    const allIPv4Addrs = [];
    for (let h in this.hostsdb) {
      let hostbymac = this.hostsdb[h];
      if (hostbymac && h.startsWith("host:mac")) {
        if (Array.isArray(hostbymac.ipv6Addr) && !hostbymac.ipv6Addr.some(ip => sysManager.isMyIP6(ip))) {
          allIPv6Addrs.push(... hostbymac.ipv6Addr);
        }
        if (hostbymac.o.ipv4Addr && !sysManager.isMyIP(hostbymac.o.ipv4Addr)) {
          allIPv4Addrs.push(hostbymac.o.ipv4Addr);
        }
      }
    }
    spoofer.validateV6Spoofs(allIPv6Addrs);
    spoofer.validateV4Spoofs(allIPv4Addrs);
  }

  async basicDataForInit(json, options) {
    let networkinfo = sysManager.getDefaultWanInterface();
    if(networkinfo.gateway === null) {
      delete networkinfo.gateway;
    }

    json.network = _.omit(networkinfo, ["subnetAddress4", "subnetAddress6"]);

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
    json.runtimeDynamicFeatures = fc.getDynamicFeatures()

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
    if (f.isApi()) {
      const SSH = require('../extension/ssh/ssh.js');
      const ssh = new SSH();
      const obj = await ssh.loadPassword();
      json.ssh = obj && obj.password;
      json.sshTs = obj && obj.timestamp;
    }
    if (sysManager.sysinfo.oper && sysManager.sysinfo.oper.LastScan) {
      json.lastscan = sysManager.sysinfo.oper.LastScan;
    }
    json.systemDebug = sysManager.isSystemDebugOn();
    json.version = sysManager.config.version;
    json.longVersion = f.getLongVersion(json.version);
    json.lastCommitDate = f.getLastCommitDate()
    json.device = "Firewalla (beta)"
    json.publicIp = sysManager.publicIp;
    json.publicIp6s = sysManager.publicIp6s;
    json.ddns = sysManager.ddns;
    if (sysManager.sysinfo && sysManager.sysinfo[sysManager.config.monitoringInterface2])
      json.secondaryNetwork = sysManager.sysinfo && sysManager.sysinfo[sysManager.config.monitoringInterface2];
    json.remoteSupport = frp.started;
    json.model = platform.getName();
    json.variant = await platform.getVariant();
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
    if (sysManager.publicIps) {
      json.publicIps = sysManager.publicIps;
    }
    if (sysManager.upgradeEvent) {
      json.upgradeEvent = sysManager.upgradeEvent;
    }
    const sysInfo = SysInfo.getSysInfo();
    json.no_auto_upgrade = await SysInfo.getAutoUpgrade();
    json.distCodename = sysInfo.distCodename;
    json.osUptime = sysInfo.osUptime;
    json.fanSpeed = await platform.getFanSpeed();
    const cpuUsageRecords = await rclient.zrangebyscoreAsync(Constants.REDIS_KEY_CPU_USAGE, Date.now() / 1000 - 60, Date.now() / 1000).map(r => JSON.parse(r));
    json.sysMetrics = {
      memUsage: sysInfo.realMem,
      totalMem: sysInfo.totalMem,
      load1: sysInfo.load1,
      load5: sysInfo.load5,
      load15: sysInfo.load15,
      diskInfo: sysInfo.diskInfo,
      cpuUsage1: cpuUsageRecords
    }
  }

  async hostsToJson(json) {
    let _hosts = [];
    for (let i in this.hosts.all) {
      _hosts.push(this.hosts.all[i].toJson());
    }
    json.hosts = _hosts;
    if (platform.isFireRouterManaged())
      await this.enrichSTAInfo(_hosts);
    await this.enrichWeakPasswordScanResult(_hosts);
  }

  async enrichSTAInfo(hosts) {
    const staStatus = await FireRouter.getAllSTAStatus().catch((err) => {
      log.error(`Failed to get STA status from firerouter`, err.message);
      return null;
    });
    if (_.isObject(staStatus)) {
      for (const host of hosts) {
        const mac = host.mac;
        if (mac && staStatus[mac])
          host.staInfo = staStatus[mac];
      }
    }
  }

  async assetsInfoForInit(json) {
    if (platform.isFireRouterManaged()) {
      const assetsStatus = await FireRouter.getAssetsStatus().catch((err) => {
        log.error(`Failed to get assets status from firerouter`, err.message);
        return null;
      });
      if (assetsStatus) {
        json.assets = {};
        for (const key of Object.keys(assetsStatus)) {
          json.assets[key] = assetsStatus[key];
        }
      }
    }
  }

  async enrichWeakPasswordScanResult(hosts) {
    await Promise.all(hosts.map(async host => {
      await this.enrichWeakPasswordScanResult(host, "mac");
    }));
  }

  async enrichWeakPasswordScanResult(host, uidKey) {
    const uid = host[uidKey];
    if (uid) {
      const key = `weak_password_scan:${uid}`;
      const result = await rclient.getAsync(key).then((data) => JSON.parse(data)).catch((err) => null);
      if (result)
        host.weakPasswordScanResult = result;
    }
  }

  async getStats(statSettings, target, metrics) {
    const subKey = target && target != '0.0.0.0' ? ':' + target : '';
    const { granularities, hits} = statSettings;
    const stats = {}
    const metricArray = metrics || [ 'upload', 'download', 'conn', 'ipB', 'dns', 'dnsB' ]
    for (const metric of metricArray) {
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

  async monthlyDataUsageForInit(json) {
    const dataPlan = await this.getDataUsagePlan({});
    const globalDate = dataPlan && dataPlan.date || 1;
    json.monthlyDataUsage = _.pick(await this.monthlyDataStats(null, globalDate), [
      'totalDownload', 'totalUpload', 'monthlyBeginTs', 'monthlyEndTs'
    ])
    const monthlyDataUsageOnWans = {};
    const wanConfs = dataPlan && dataPlan.wanConfs || {};
    const wanIntfs = sysManager.getWanInterfaces();
    for (const wanIntf of wanIntfs) {
      const date = wanConfs[wanIntf.uuid] && wanConfs[wanIntf.uuid].date || globalDate;
      monthlyDataUsageOnWans[wanIntf.uuid] = _.pick(await this.monthlyDataStats(`wan:${wanIntf.uuid}`, date), 
        ["totalDownload", "totalUpload", "monthlyBeginTs", "monthlyEndTs"]
      );
    }
    json.monthlyDataUsageOnWans = monthlyDataUsageOnWans;
  }

  async monthlyDataStats(mac, date) {
    if (!date) {
      const dataPlan = await this.getDataUsagePlan({});
      date = dataPlan ? dataPlan.date : 1
    }
    const timezone = sysManager.getTimezone();
    const now = timezone ? moment().tz(timezone) : moment();
    let nextOccurrence = (now.get("date") >= date ? moment(now).add(1, "months") : moment(now)).endOf("month").startOf("day");
    while (nextOccurrence.get("date") !== date) {
      if (nextOccurrence.get("date") >= date)
        nextOccurrence.subtract(nextOccurrence.get("date") - date, "days");
      else
        nextOccurrence.add(1, "months").endOf("month").startOf("day");
    }
    let diffMonths = 0;
    while (moment(nextOccurrence).subtract(diffMonths, "months").unix() > now.unix())
      diffMonths++;
      
    const monthlyBeginMoment = moment(nextOccurrence).subtract(diffMonths, "months"); // begin moment of this cycle

    const monthlyBeginTs = monthlyBeginMoment.unix();
    const monthlyEndMoment = moment(monthlyBeginMoment).add(1, "months").endOf("month").startOf("day");
    if (monthlyEndMoment.get("date") > date)
      monthlyEndMoment.subtract(monthlyEndMoment.get("date") - date, "days");
    const monthlyEndTs = monthlyEndMoment.unix();
    const days = Math.floor((now.unix() - monthlyBeginTs) / 86400) + 1;

    const downloadKey = `download${mac ? ':' + mac : ''}`;
    const uploadKey = `upload${mac ? ':' + mac : ''}`;
    const download = await getHitsAsync(downloadKey, '1day', days) || [];
    const upload = await getHitsAsync(uploadKey, '1day', days) || [];
    return Object.assign({
      monthlyBeginTs,
      monthlyEndTs
    }, this.generateStats({ download, upload }))
  }

  utcOffsetBetweenTimezone(tz) {
    if (!tz) return 0;
    const offset1 = moment().utcOffset() * 60 * 1000;
    const offset2 = moment().tz(tz).utcOffset() * 60 * 1000;
    const offset = offset2 - offset1;
    return offset;
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

  async policyDataForInit(json) {
    log.debug("Loading polices");
    json.policy = await this.loadPolicyAsync()
  }

  async extensionDataForInit(json) {
    log.debug("Loading ExtentsionPolicy");
    let extdata = {};

    const portforwardConfig = await this.getPortforwardConfig();
    if (portforwardConfig)
      extdata['portforward'] = portforwardConfig;

    const fpp = await sensorLoader.initSingleSensor('FamilyProtectPlugin');
    const familyConfig = await fpp.getFamilyConfig()
    if (familyConfig) extdata.family = familyConfig

    const ruleStatsPlugin = await sensorLoader.initSingleSensor('RuleStatsPlugin');
    const initTs = await ruleStatsPlugin.getFeatureFirstEnabledTimestamp();
    extdata.ruleStats = { "initTs": initTs };

    extdata.ntp = {
      localServerStatus: fc.isFeatureOn('ntp_redirect') ?
        Number(await rclient.getAsync(Constants.REDIS_KEY_NTP_SERVER_STATUS)) : null
    }

    json.extension = extdata;
  }

  async dohConfigDataForInit(json) {
    const dc = require('../extension/dnscrypt/dnscrypt.js');
    const selectedServers = await dc.getServers();
    const customizedServers = await dc.getCustomizedServers();
    const allServers = await dc.getAllServerNames();
    json.dohConfig = {selectedServers, allServers, customizedServers};
  }

  async unboundConfigDataForInit(json) {
    const unbound = require('../extension/unbound/unbound.js');
    const config = await unbound.getUserConfig();
    json.unboundConfig = config;
  }

  async safeSearchConfigDataForInit(json) {
    const config = await rclient.getAsync("ext.safeSearch.config").then((result) => JSON.parse(result)).catch(err => null);
    json.safeSearchConfig = config;
  }

  async getPortforwardConfig() {
    return rclient.getAsync("extension.portforward.config").then((data) => {
      if (data) {
        const config = JSON.parse(data);
        return config;
      } else
        return null;
    }).catch((err) => null);
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

  async externalScanDataForInit(json) {
    const scanResult = {};
    const result = await rclient.hgetallAsync(Constants.REDIS_KEY_EXT_SCAN_RESULT) || {};
    const wans = sysManager.getWanInterfaces();
    for (const wan of wans) {
      if (_.has(result, wan.uuid)) {
        try {
          scanResult[wan.uuid] = JSON.parse(result[wan.uuid]);
        } catch (err) {
          log.error(`Failed to parse external scan result on ${wan.uuid}`, err.message);
        }
      }
    }
    json.extScan = scanResult;
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

  async weakPasswordDataForInit(json) {
    const result = await rclient.hgetallAsync(Constants.REDIS_KEY_WEAK_PWD_RESULT);
    if (!result)
      return {};
    if (_.has(result, "tasks"))
      result.tasks = JSON.parse(result.tasks);
    if (_.has(result, "lastCompletedScanTs"))
      result.lastCompletedScanTs = Number(result.lastCompletedScanTs);
    json.weakPasswordScanResult = result;
  }

  async hostsInfoForInit(json, options) {
    log.debug("Reading host stats");

    await this.getHostsAsync(options)

    // keeps total download/upload only for sorting on app
    await Promise.all([
      asyncNative.eachLimit(this.hosts.all, 30, async host => {
        const stats = await this.getStats({granularities: '1hour', hits: 24}, host.o.mac, ['upload', 'download']);
        host.flowsummary = {
          inbytes: stats.totalDownload,
          outbytes: stats.totalUpload
        }
      }),
      this.loadHostsPolicyRules(),
    ])
    await this.hostsToJson(json);

    // _totalHosts and _totalPrivateMacHosts will be updated in getHostsAsync
    json.totalHosts = this._totalHosts;
    json.totalPrivateMacHosts = this._totalPrivateMacHosts;

    return json;
  }

  async dhcpRangeForInit(network, json) {
    const key = network + "DhcpRange";
    let dhcpRange = await dnsTool.getDefaultDhcpRange(network);
    const data = await this.loadPolicyAsync()
    if (data && data.dnsmasq) {
      const dnsmasqConfig = data.dnsmasq;
      if (dnsmasqConfig[network + "DhcpRange"]) {
        dhcpRange = dnsmasqConfig[network + "DhcpRange"];
      }
    }
    if (dhcpRange)
      json[key] = dhcpRange;
  }

  async dhcpPoolUsageForInit(json) {
    const stats = await dnsmasq.getDhcpPoolUsage();
    json.dhcpPoolUsage = stats;
  }

  async modeForInit(json) {
    log.debug("Reading mode");
    const mode = await modeManager.mode();
    json.mode = mode;

    if (mode === "dhcp") {
      if (platform.isOverlayNetworkAvailable()) {
        await this.dhcpRangeForInit("alternative", json);
        await this.dhcpRangeForInit("secondary", json);
      }
      json.dhcpServerStatus = await rclient.getAsync("sys:scan:dhcpserver");
    }
  }

  async ruleGroupsForInit(json) {
    const rgs = policyManager2.getAllRuleGroupMetaData();
    json.ruleGroups = rgs;
  }

  async virtWanGroupsForInit(json) {
    const vwgs = await VirtWanGroupManager.toJson();
    json.virtWanGroups = vwgs;
  }

  async internetSpeedtestResultsForInit(json, limit = 50) {
    const end = Date.now() / 1000;
    const begin = Date.now() / 1000 - 86400 * 30;
    const results = (await rclient.zrevrangebyscoreAsync("internet_speedtest_results", end, begin) || []).map(e => {
      try {
        const r = JSON.parse(e);
        r.manual = r.manual || false;
        return r;
      } catch (err) {
        return null;
      }
    }).filter(e => e !== null && e.success).slice(0, limit); // return at most 50 recent results from recent to earlier
    json.internetSpeedtestResults = results;
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

  async getLatestConnStates(json) {
    if (platform.isFireRouterManaged()) {
      try {
        const status = await FireRouter.getWanConnectivity(false);
        json.wanTestResult = status;
      } catch(err) {
        log.error("Got error when get wan connectivity, err:", err);
      }
    }
  }

  async networkMonitorEventsForInit(json) {
    const end = Date.now(); // key of events is time in milliseconds
    const begin = end - 86400 * 1000; // last 24 hours
    const events = await eventApi.listEvents(begin, end, 0, -1, false, true, [
      {event_type: "state", sub_type: "overall_wan_state"},
      {event_type: "action", sub_type: "ping_RTT"},
      {event_type: "action", sub_type: "dns_RTT"},
      {event_type: "action", sub_type: "http_RTT"},
      {event_type: "action", sub_type: "ping_lossrate"},
      {event_type: "action", sub_type: "dns_lossrate"},
      {event_type: "action", sub_type: "http_lossrate"},
      {event_type: "action", sub_type: "system_reboot"}
    ]);
    // get the last state event before 24 hours ago
    const previousStateEvents = await eventApi.listEvents("-inf", begin, 0, 1, true, true, [
      {event_type: "state", sub_type: "overall_wan_state"}
    ]);
    const networkMonitorEvents = (_.isArray(previousStateEvents) && previousStateEvents.slice(0, 1) || []).concat(_.isArray(events) && events.slice(-250) || []);
    json.networkMonitorEvents = networkMonitorEvents;
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

          /*
          rules = rules.filter((r) => {
            return r.type != "ALARM_NEW_DEVICE" // allow new device is default
          })
          */

          // filters out rules with inactive devices
          rules = rules.filter(rule => {
            if(!rule) {
              return false;
            }

            const mac = rule["p.device.mac"];

            if (!mac) return true;

            return this.hosts.all.some(host => host.o.mac === mac) || IdentityManager.getIdentityByGUID(mac);
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
    log.debug("Reading individual host policy rules");
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
    const ddnsToken = await rclient.hgetAsync("sys:network:info", "ddnsToken");
    if (ddnsToken) {
      try {
        json.ddnsToken = JSON.parse(ddnsToken);
      } catch (err) {
        log.error(`Failed to parse ddns token`);
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

  async boxMetrics(json) {
    const result = await Metrics.getMetrics();
    json.boxMetrics = result;
  }

  async getSysInfo(json) {
    const result = await sysManager.getSysInfoAsync();
    json.sysInfo = result;
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
      this.internetSpeedtestResultsForInit(json, 5),
      this.systemdRestartMetrics(json),
      this.boxMetrics(json),
      this.getSysInfo(json),
      this.assetsInfoForInit(json)
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

  async vpnClientProfilesForInit(json) {
    await VPNClient.getVPNProfilesForInit(json);
  }

  async jwtTokenForInit(json) {
    const token = await tokenManager.getToken();
    if(token) {
      json.jwt = token;
    }
  }

  async groupNameForInit(json) {
    const groupName = await f.getBoxName();
    if(groupName) {
      json.groupName = groupName;
    }
  }

  async asyncBasicDataForInit(json) {
    const speed = await platform.getNetworkSpeed();
    const nicStates = await platform.getNicStates();
    if (platform.isFireRouterManaged()) {
      for (const intf in nicStates) {
        const channel = _.get(FireRouter.getInterfaceViaName(intf), 'state.channel')
        if (channel) nicStates[intf].channel = channel
      }
    }
    json.nicSpeed = speed;
    json.nicStates = nicStates;
    const versionUpdate = await sysManager.getVersionUpdate();
    if (versionUpdate)
      json.versionUpdate = versionUpdate;
    const customizedCategories = await categoryUpdater.getCustomizedCategories();
    json.customizedCategories = customizedCategories;
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

  async getGuardians(json) {
    const Guardian = require('../sensor/Guardian.js');
    const result = []
    let aliases = await rclient.zrangeAsync("guardian:alias:list", 0, -1);
    aliases = _.uniq((aliases || []).concat("default"));
    await Promise.all(aliases.map(async alias => {
      const guardian = new Guardian(alias);
      const guardianInfo = await guardian.getGuardianInfo();
      result.push(guardianInfo);
    }))
    json.guardians = result;
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
      return result;
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
    const config = await FireRouter.getConfig(true);
    if (filterSensitive) {
      if (config && config.interface && config.interface.pppoe) {
        for (const key in config.interface.pppoe) {
          const temp = _.omit(config.interface.pppoe[key], ['password', 'username']);
          config.interface.pppoe[key] = temp;
        }
      }
      if (config && config.interface && config.interface.wireguard) {
        for (const key in config.interface.wireguard) {
          const temp = _.omit(config.interface.wireguard[key], ['privateKey']);
          config.interface.wireguard[key] = temp;
        }
      }
      if (config && config.hostapd) {
        for (const key of Object.keys(config.hostapd)) {
          if (config.hostapd[key].params) {
            const temp = _.omit(config.hostapd[key].params, ['ssid', 'wpa_passphrase']);
            config.hostapd[key].params = temp;
          }
        }
      }
      if (config && config.interface && config.interface.wlan) {
        for (const key of Object.keys(config.interface.wlan)) {
          const temp = _.omit(config.interface.wlan[key], ['wpaSupplicant']);
          config.interface.wlan[key] = temp;
        }
      }
    }
    json.networkConfig = config;
  }

  async tagsForInit(json, timeUsageApps) {
    await TagManager.refreshTags();
    const tags = await TagManager.toJson();
    const timezone = sysManager.getTimezone();
    const supportedApps = await TimeUsageTool.getSupportedApps();
    if (!timeUsageApps)
      timeUsageApps = supportedApps;
    else
      timeUsageApps = _.intersection(timeUsageApps, supportedApps);
    for (const uid of Object.keys(tags)) {
      const tag = tags[uid];
      const type = tag.type || Constants.TAG_TYPE_GROUP;
      const initDataKey = _.get(Constants.TAG_TYPE_MAP, [type, "initDataKey"]);
      const needAppTimeInInitData = _.get(Constants.TAG_TYPE_MAP, [type, "needAppTimeInInitData"], false);
      if (initDataKey) {
        if (!json[initDataKey])
          json[initDataKey] = {};
        json[initDataKey][uid] = Object.assign({}, tag);
        if (needAppTimeInInitData) {
          // today's app time usage on this tag
          const begin = (timezone ? moment().tz(timezone) : moment()).startOf("day").unix();
          const end = begin + 86400;
          const {appTimeUsage, appTimeUsageTotal} = await TimeUsageTool.getAppTimeUsageStats(`tag:${uid}`, null, timeUsageApps, begin, end, "hour", false);

          json[initDataKey][uid].appTimeUsageToday = appTimeUsage;
          json[initDataKey][uid].appTimeUsageTotalToday = appTimeUsageTotal;
        }
      }
    }
  }

  async btMacForInit(json) {
    json.btMac = await rclient.getAsync("sys:bt:mac");
  }

  async networkProfilesForInit(json) {
    await NetworkProfileManager.refreshNetworkProfiles(true);
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
      const config = await FireRouter.getConfig();
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

  async identitiesForInit(json) {
    await IdentityManager.generateInitData(json);
    log.debug('identities finished')
  }

  async getWlanInfo(json) {
    const wlan = {}

    wlan.channels = await FireRouter.getWlanChannels().catch((err) => {
      log.error("Got error when getting wlans channels:", err);
      return {};
    })

    json.wlan = wlan
    return wlan
  }

  async getConfigForInit(json) {
    json.userConfig = await fc.getUserConfig()

    json.profiles = {}
    const profileConfig = fc.getConfig().profiles || {}
    for (const category in profileConfig) {
      if (category == 'default') continue
      const currentDefault = profileConfig.default && profileConfig.default[category]
      const cloudDefault = _.get(await fc.getCloudConfig(), ['profiles', 'default', category], currentDefault)
      json.profiles[category] = {
        default: currentDefault || 'default',
        list: Object.keys(profileConfig[category]).filter(p => p != 'default'),
        subTypes: Object.keys(profileConfig[category][cloudDefault])
      }
      if (category == 'alarm') {
        json.profiles.alarm.defaultLargeUpload2TxMin = _.get(
          fc.getConfig().profiles.alarm, [currentDefault, 'large_upload_2', 'txMin'],
          fc.getConfig().profiles.alarm.default.large_upload_2.txMin
        )
      }
    }

  }

  async toJson(options = {}) {
    const json = {};

    let requiredPromises = [
      this.hostsInfoForInit(json, options),
      this.newLast24StatsForInit(json),
      this.last60MinStatsForInit(json),
      this.extensionDataForInit(json),
      this.dohConfigDataForInit(json),
      this.unboundConfigDataForInit(json),
      this.safeSearchConfigDataForInit(json),
      this.last30daysStatsForInit(json),
      this.last12MonthsStatsForInit(json),
      this.policyDataForInit(json),
      this.modeForInit(json),
      this.policyRulesForInit(json),
      this.exceptionRulesForInit(json),
      this.newAlarmDataForInit(json),
      this.archivedAlarmNumberForInit(json),
      this.natDataForInit(json),
      this.externalScanDataForInit(json),
      this.weakPasswordDataForInit(json),
      this.encipherMembersForInit(json),
      this.jwtTokenForInit(json),
      this.groupNameForInit(json),
      this.asyncBasicDataForInit(json),
      this.getGuessedRouters(json),
      this.getGuardian(json),
      this.getGuardians(json),
      this.getDataUsagePlan(json),
      this.monthlyDataUsageForInit(json),
      this.networkConfig(json),
      this.networkProfilesForInit(json),
      this.networkMetrics(json),
      this.identitiesForInit(json),
      this.tagsForInit(json, options.timeUsageApps),
      this.btMacForInit(json),
      this.loadStats(json),
      this.vpnClientProfilesForInit(json),
      this.ruleGroupsForInit(json),
      this.virtWanGroupsForInit(json),
      this.getLatestConnStates(json),
      this.listLatestAllStateEvents(json),
      this.listLatestErrorStateEvents(json),
      this.loadDDNSForInit(json),
      this.basicDataForInit(json, options),
      this.internetSpeedtestResultsForInit(json),
      this.networkMonitorEventsForInit(json),
      this.dhcpPoolUsageForInit(json),
      this.assetsInfoForInit(json),
      this.getConfigForInit(json),
      this.miscForInit(json),
      exec("sudo systemctl is-active firekick").then(() => json.isBindingOpen = 1).catch(() => json.isBindingOpen = 0),
    ];
    // 2021.11.17 not gonna be used in the near future, disabled
    // const platformSpecificStats = platform.getStatsSpecs();
    // json.stats = {};
    // for (const statSettings of platformSpecificStats) {
    //   requiredPromises.push(this.getStats(statSettings)
    //     .then(s => json.stats[statSettings.stat] = s)
    //   )
    // }
    await Promise.all(requiredPromises.map(p => p.catch(log.error)))

    log.debug("Promise array finished")

    return json
  }

  async miscForInit(json) {
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

    const suffix = await rclient.getAsync(Constants.REDIS_KEY_LOCAL_DOMAIN_SUFFIX);
    json.localDomainSuffix = suffix ? suffix : 'lan';
    const noForward = await rclient.getAsync(Constants.REDIS_KEY_LOCAL_DOMAIN_NO_FORWARD);
    json.localDomainNoForward = noForward && JSON.parse(noForward) || false;
    json.cpuProfile = await this.getCpuProfile();
  }

  getHostsFast() {
    return this.hosts.all;
  }

  getHostFastByMAC(mac) {
    if (mac == null) {
      return null;
    }

    return this.hostsdb[`host:mac:${mac.toUpperCase()}`];
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

  async getHostAsync(target, noEnvCreation = false) {
    let host, o;
    if (hostTool.isMacAddress(target)) {
      host = this.hostsdb[`host:mac:${target}`];
      o = await hostTool.getMACEntry(target)
    } else {
      o = await dnsManager.resolveLocalHostAsync(target)
      host = this.hostsdb[`host:ip4:${o.ipv4Addr}`];
    }
    if (host && o) {
      await host.update(o);
      return host;
    }

    if (o == null) return null;

    host = new Host(o, noEnvCreation);

    this.hostsdb[`host:mac:${o.mac}`] = host
    this.hosts.all.push(host);

    this.syncV6DB(host)

    return host
  }

  async createHost(o) {
    let host = await this.getHostAsync(o.mac)
    if (host) {
      log.info('createHost: already exist', o.mac)
      await host.update(o)
      await host.save()
      return
    }

    host = new Host(o)
    await host.save()

    this.hostsdb[`host:mac:${o.mac}`] = host
    this.hosts.all.push(host);

    this.syncV6DB(host)
  }

  syncV6DB(host) {
    if (!host || !host.ipv6Addr || !Array.isArray(host.ipv6Addr)) return

    for (const ip6 of host.ipv6Addr) {
      this.hostsdb[`host:ip6:${ip6}`] = host
    }
  }

  // take hosts list, get mac address, look up mac table, and see if
  // ipv6 or ipv4 addresses needed updating
  async syncHost(host, ipv6AddrOld) {
    if (host.o.mac == null) {
      log.error("HostManager:Sync:Error:MacNull", host.o.mac, host.o.ipv4Addr, host.o);
      throw new Error("No mac")
    }

    let ipv6array = ipv6AddrOld ? JSON.parse(ipv6AddrOld) : [];
    if (host.ipv6Addr == null) {
      host.ipv6Addr = [];
    }

    let needsave = false;

    // if updated ipv6 array is not same as the old ipv6 array, need to save the new ipv6 array to redis host:mac:
    // the number of addresses in new array is usually fewer than the old since Host.cleanV6() cleans up the expired addresses
    if (!_.isArray(ipv6array) || ipv6array.some(a => !host.ipv6Addr.includes(a)) || host.ipv6Addr.some(a => !ipv6array.includes(a)))
      needsave = true;

    if (needsave == true) {
      await host.save()
    }
  }

  getHosts(callback) {
    callback = callback || function(){}

    util.callbackify(this.getHostsAsync).bind(this)(callback)
  }

  // this only returns ture for host that has individual policies, we don't need to worry about
  // tag policies until dhcpIgnore on tag is considered as standalone policy (other than working
  // together with interface policy)
  async _hasDHCPReservation(h) {
    try {
      // if the ip allocation on an old (stale) device is changed in fireapi, firemain will not execute ipAllocation function on the host object, which sets intfIp in host:mac
      // therefore, need to check policy:mac to determine if the device has reserved IP instead of host:mac
      const policy = await hostTool.loadDevicePolicyByMAC(h.mac);
      if (policy.dhcpIgnore) return true
      if (policy.ipAllocation) {
        const ipAllocation = JSON.parse(policy.ipAllocation);
        if (platform.isFireRouterManaged()) {
          if (ipAllocation.allocations && Object.keys(ipAllocation.allocations).some(uuid => ipAllocation.allocations[uuid].type === "static" && sysManager.getInterfaceViaUUID(uuid)))
            return true;
        } else {
          if (ipAllocation.type === "static")
            return true;
        }
      }
    } catch (err) { }
    return false;
  }

  // super resource-heavy function, be careful when calling this
  async getHostsAsync(options = {}) {
    log.verbose("getHosts: started");
    const forceReload = options.forceReload || false;
    const includeInactiveHosts = options.includeInactiveHosts || false;
    const includePinnedHosts = options.includePinnedHosts || false;
    const includePrivateMac = options.hasOwnProperty("includePrivateMac") ? options.includePrivateMac : true;

    const hosts = await lock.acquire("LOCK_GET_HOSTS", async () => {
      // Only allow requests be executed in a frenquency lower than 1 per minute
      const getHostsActiveExpire = Math.floor(new Date() / 1000) - 60 // 1 min
      if (!forceReload && this.getHostsLast && this.getHostsLast > getHostsActiveExpire && _.isEqual(this.getHostsLastOptions, options)) {
        log.verbose("getHosts: too frequent, returning cache");
        if(this.hosts.all && this.hosts.all.length > 0){
          return this.hosts.all
        }
      }
  
      this.getHostsActive = true
      this.getHostsLast = Math.floor(new Date() / 1000);
      this.getHostsLastOptions = options;
      // end of mutx check
      const portforwardConfig = await this.getPortforwardConfig();
  
      for (let h in this.hostsdb) {
        if (this.hostsdb[h]) {
          this.hostsdb[h]._mark = false;
        }
      }
      const keys = await rclient.keysAsync("host:mac:*");
      this._totalHosts = keys.length;
      let multiarray = [];
      for (let i in keys) {
        multiarray.push(['hgetall', keys[i]]);
      }
      const inactiveTS = Date.now()/1000 - INACTIVE_TIME_SPAN; // one week ago
      const rapidInactiveTS = Date.now() / 1000 - RAPID_INACTIVE_TIME_SPAN;
      const replies = await rclient.multi(multiarray).execAsync();
      this._totalPrivateMacHosts = replies.filter(o => _.isObject(o) && o.mac && hostTool.isPrivateMacAddress(o.mac)).length;
      await asyncNative.eachLimit(replies, 20, async (o) => {
        if (!o || !o.mac) {
          // defensive programming
          return;
        }
        if (!hostTool.isMacAddress(o.mac)) {
          log.error(`Invalid MAC address: ${o.mac}`);
          return;
        }
        const ipv6AddrOld = o.ipv6Addr
        if (o.ipv4) {
          o.ipv4Addr = o.ipv4;
        }
        const pinned = o.pinned;
        const hasDHCPReservation = await this._hasDHCPReservation(o);
        const hasPortforward = portforwardConfig && _.isArray(portforwardConfig.maps) && portforwardConfig.maps.some(p => p.toMac === o.mac);
        const hasNonLocalIP = o.ipv4Addr && !sysManager.isLocalIP(o.ipv4Addr);
        const isPrivateMac = o.mac && hostTool.isPrivateMacAddress(o.mac);
        // device might be created during migration with only found ts but no active ts
        const activeTS = o.lastActiveTimestamp || o.firstFoundTimestamp
        const active = (activeTS - o.firstFoundTimestamp > 600 ? activeTS && activeTS >= inactiveTS : activeTS && activeTS >= rapidInactiveTS); // expire transient devices in a short time
        const inUse = (activeTS && activeTS >= inactiveTS) || hasDHCPReservation || hasPortforward || pinned || false;
        // always return devices that has DHCP reservation or port forwards
        const valid = (!isPrivateMac || includePrivateMac) && (active || includeInactiveHosts)
          || hasDHCPReservation
          || hasPortforward
          || (pinned && includePinnedHosts)
        if (!valid)
          return;
        if (hasNonLocalIP) {
          // do not show non-local IP to prevent confusion
          o.ipv4Addr = undefined;
          o.ipv4 = undefined;
        }
  
        //log.info("Processing GetHosts ",o);
        let hostbymac = this.hostsdb["host:mac:" + o.mac];
        let hostbyip = o.ipv4Addr ? this.hostsdb["host:ip4:" + o.ipv4Addr] : null;
  
        if (hostbymac == null) {
          hostbymac = new Host(o);
          this.hosts.all.push(hostbymac);
          this.hostsdb['host:mac:' + o.mac] = hostbymac;
        } else {
          if (o.ipv4 != hostbymac.o.ipv4) {
            // the physical host get a new ipv4 address
            // remove host:ip4 entry from this.hostsdb only if the entry belongs to this mac
            if (hostbyip && hostbyip.o.mac === o.mac)
              this.hostsdb['host:ip4:' + hostbymac.o.ipv4] = null;
          }
  
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
          } catch(err) {
            log.error('Failed to check v6 address of', o.mac, err)
          }
  
          await hostbymac.update(o);
          await hostbymac.identifyDevice(false);
        }
  
        // do not update host:ip4 entries in this.hostsdb since it may be previously occupied by other host
        // it will be updated later by checking if there is double mapping
        // this.hostsdb['host:ip4:' + o.ipv4Addr] = hostbymac;
        // ipv6 address conflict hardly happens, so update here is relatively safe
        this.syncV6DB(hostbymac)
  
        hostbymac.stale = !inUse;
        hostbymac._mark = true;
        if (hostbyip) {
          hostbyip._mark = true;
        }
        // two mac have the same IP,  pick the latest, until the otherone update itself
        if (hostbyip != null && hostbyip.o.mac != hostbymac.o.mac) {
          if ((hostbymac.o.lastActiveTimestamp || 0) > (hostbyip.o.lastActiveTimestamp || 0)) {
            log.verbose(`${hostbymac.o.mac} is more up-to-date than ${hostbyip.o.mac}`);
            this.hostsdb['host:ip4:' + o.ipv4Addr] = hostbymac;
          } else {
            log.verbose(`${hostbyip.o.mac} is more up-to-date than ${hostbymac.o.mac}`);
            this.hostsdb['host:ip4:' + o.ipv4Addr] = hostbyip;
          }
        } else {
          // update host:ip4 entries in this.hostsdb here if it is a new IPv4 address or belongs to the same device
          if (o.ipv4Addr)
            this.hostsdb['host:ip4:' + o.ipv4Addr] = hostbymac;
        }
        await hostbymac.cleanV6()
        if (f.isMain()) {
          await this.syncHost(hostbymac, ipv6AddrOld)
        }
      })
  
      // NOTE: all hosts dropped are still kept in Host.instances
      this.hostsdb = _.pickBy(this.hostsdb, {_mark: true})
      this.hosts.all = _.filter(this.hosts.all, {_mark: true})
      this.hosts.all = _.uniqBy(this.hosts.all, _.property("o.mac")); // in case multiple Host objects with same MAC addresses are added to the array due to race conditions
  
      // for (const key in this.hostsdb) {
      //   if (!this.hostsdb[key]._mark) {
      //     this.hostsdb[key].destory()
      //     delete this.hostsdb[key]
      //   }
      // }
      // // all hosts dropped should have been destroyed, but just in case
      // const groupsByMark = _.groupBy(this.hosts.all, '_mark')
      // for (const host of groupsByMark.false || []) { host.destroy() }
      // this.hosts.all = groupsByMark.true || []
  
      this.hosts.all.sort(function (a, b) {
        return (b.o.lastActiveTimestamp || 0) - (a.o.lastActiveTimestamp || 0);
      })
  
      log.verbose("getHosts: done, Devices: ", this.hosts.all.length);
  
      return this.hosts.all;
    }).catch((err) => {
      log.error(`Error occurred in getHostsAsync`, err.message);
      return this.hosts.all;
    });
    return hosts;
  }

  getUniqueId() { return '0.0.0.0' }

  static getClassName() { return 'System' }

  _getPolicyKey() { return 'policy:system' }

  static defaultPolicy() {
    return Object.assign(super.defaultPolicy(), {
      qos: {state: false},
      ntp_redirect: { state: false },
    })
  }

  async setPolicyAsync(name, policy) {
    if (!this.policy) await this.loadPolicyAsync();
    if (name == 'dnsmasq' || name == 'vpn') {
      policy = Object.assign({}, this.policy[name], policy)
    }

    await super.setPolicyAsync(name, policy)
  }

  async ipAllocation(policy) {
    await dnsmasq.writeAllocationOption(null, policy)
  }

  isMonitoring() {
    return this.spoofing;
  }

  async qos(policy, wanUUID) {
    if (wanUUID) { // per-wan config
      let upload = true;
      let download = true;
      await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
      const oifSet = NetworkProfile.getOifIpsetName(wanUUID);
      if (_.isObject(policy)) {
        if (_.has(policy, "upload"))
          upload = policy.upload;
        if (_.has(policy, "download"))
          download = policy.download;
      }
      // add fallback connmark rule for upload/download traffic
      let mark = 0x0;
      if (upload)
        mark |= 0x800000;
      if (download)
        mark |= 0x10000;
      let rule4 = new Rule("mangle").chn("FW_QOS_GLOBAL_FALLBACK")
        .mdl("set", `--match-set ${ipset.CONSTANTS.IPSET_MONITORED_NET} src,src`)
        .mdl("set", `! --match-set ${ipset.CONSTANTS.IPSET_MONITORED_NET} dst,dst`)
        .mdl("set", `--match-set ${oifSet} dst,dst`)
        .jmp(`CONNMARK --set-xmark 0x${(mark & QoS.QOS_UPLOAD_MASK).toString(16)}/0x${QoS.QOS_UPLOAD_MASK.toString(16)}`)
        .comment(`global-qos`);
      let rule6 = rule4.clone().fam(6);
      await exec(rule4.toCmd('-A')).catch((err) => {
        log.error(`Failed to toggle global upload ipv4 qos`, err.message);
      });
      await exec(rule6.toCmd('-A')).catch((err) => {
        log.error(`Failed to toggle global upload ipv6 qos`, err.message);
      });

      rule4 = new Rule("mangle").chn("FW_QOS_GLOBAL_FALLBACK")
        .mdl("set", `! --match-set ${ipset.CONSTANTS.IPSET_MONITORED_NET} src,src`)
        .mdl("set", `--match-set ${oifSet} src,src`)
        .mdl("set", `--match-set ${ipset.CONSTANTS.IPSET_MONITORED_NET} dst,dst`)
        .jmp(`CONNMARK --set-xmark 0x${(mark & QoS.QOS_DOWNLOAD_MASK).toString(16)}/0x${QoS.QOS_DOWNLOAD_MASK.toString(16)}`)
        .comment(`global-qos`);
      rule6 = rule4.clone().fam(6);
      await exec(rule4.toCmd('-A')).catch((err) => {
        log.error(`Failed to toggle global ipv4 qos`, err.message);
      });
      await exec(rule6.toCmd('-A')).catch((err) => {
        log.error(`Failed to toggle global ipv6 qos`, err.message);
      });
    } else { // global config
      let state = false;
      let qdisc = "fq_codel";
      switch (typeof policy) {
        case "boolean":
          state = policy;
          break;
        case "object":
          state = _.has(policy, "state") ? policy.state : true;
          qdisc = policy.qdisc || "fq_codel";
          break;
        default:
          return;
      }
      await exec(wrapIptables(`sudo iptables -w -t mangle -F FW_QOS_GLOBAL_FALLBACK`)).catch((err) => { });
      await exec(wrapIptables(`sudo ip6tables -w -t mangle -F FW_QOS_GLOBAL_FALLBACK`)).catch((err) => { });
      const wanConfs = _.isObject(policy) && policy.wanConfs || {};
      const wanType = sysManager.getWanType();
      const primaryWanIntf = sysManager.getPrimaryWanInterface();
      const primaryWanUUID = primaryWanIntf && primaryWanIntf.uuid;
      if (platform.isFireRouterManaged()) {
        for (const wanIntf of sysManager.getWanInterfaces()) {
          const uuid = wanIntf.uuid;
          if (_.has(wanConfs, uuid))
            await this.qos(wanConfs[uuid], uuid);
          else {
            // use global config as a fallback for primary WAN or all wans in load balance mode
            if (uuid === primaryWanUUID || wanType === Constants.WAN_TYPE_LB)
              await this.qos(policy, uuid)
          }
        }
      }
      await platform.switchQoS(state, qdisc);
    } 
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

  async aclTimer(policy = {}) {
    if (this._aclTimer)
      clearTimeout(this._aclTimer);
    if (policy.hasOwnProperty("state") && !isNaN(policy.time) && policy.time) {
      const nextState = policy.state;
      if (Number(policy.time) > Date.now() / 1000) {
        this._aclTimer = setTimeout(() => {
          log.info(`Set acl to ${nextState} in acl timer`);
          this.setPolicy("acl", nextState);
          this.setPolicy("aclTimer", {});
        }, policy.time * 1000 - Date.now());
      } else {
        // old timer is already expired when the function is invoked, maybe caused by system reboot
        if (!this.policy || !this.policy.acl || this.policy.acl != nextState) {
          log.info(`Set acl to ${nextState} immediately in acl timer`);
          this.setPolicy("acl", nextState);
        }
        this.setPolicy("aclTimer", {});
      }
    }
  }

  async spoof(state) {
    this.spoofing = state;
    if (state == false) {
      // create dev flag file if it does not exist, and restart bitbridge
      // bitbridge binary will be replaced with mock file if this flag file exists
      try {
        await fs.promises.access(`${f.getFirewallaHome()}/bin/dev`, fs.constants.F_OK)
      } catch(err) {
        await exec(`touch ${f.getFirewallaHome()}/bin/dev`)
        sm.scheduleReload();
      }
    } else {
      const redisSpoofOff = await rclient.getAsync('sys:bone:spoofOff');
      if (redisSpoofOff) {
        return;
      }
      // remove dev flag file if it exists and restart bitbridge
      try {
        await fs.promises.access(`${f.getFirewallaHome()}/bin/dev`, fs.constants.F_OK)
        await exec(`rm ${f.getFirewallaHome()}/bin/dev`)
        sm.scheduleReload();
      } catch(err) {}
    }
  }

  async enhancedSpoof(state) {
    await modeManager.toggleCompatibleSpoof(state);
  }

  async shield(policy) {

  }

  async getVpnActiveDeviceCount(profileId) {
    let activeHosts = this.getActiveHosts();
    let iCount = 0;
    for (const host of activeHosts) {
      const ip4 = host.o.ipv4Addr;
      if (!ip4)
        continue;
      // first check if device is in a LAN, otherwise VPN client will not take effect at all
      const iface = sysManager.getInterfaceViaIP(ip4);
      if (!iface || !iface.name || !iface.uuid)
        continue;
      let isInLAN = false;
      if (iface.type === "lan")
        isInLAN = true;
      if (platform.isOverlayNetworkAvailable()) {
        // on red/blue/navy, if overlay and primary network are in the same subnet, getInterfaceViaIP will return primary network, which is LAN
        if (sysManager.inMySubnets4(ip4, `${iface.name}:0`))
          isInLAN = true;
      }
      if (!isInLAN)
        continue;
      // check device level vpn client settings
      let pid = await host.getVpnClientProfileId();
      if (pid) {
        if (pid === profileId)
          iCount += 1;
        continue;
      }
      // check group level vpn client settings
      let tags = [];
      for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
        const uids = await host.getTags(type) || [];
        tags.push(...uids);
      }
      tags = _.uniq(tags);
      let tagMatched = false;
      for (const uid of tags) {
        const tag = TagManager.getTagByUid(uid);
        if (tag) {
          pid = await tag.getVpnClientProfileId();
          if (pid) {
            if (pid === profileId)
              iCount += 1;
            tagMatched = true;
            break;
          }
        }
      }
      if (tagMatched)
        continue;
      // check network level vpn client settings
      const uuid = iface.uuid;
      const networkProfile = uuid && NetworkProfileManager.getNetworkProfile(uuid);
      if (networkProfile) {
        pid = await networkProfile.getVpnClientProfileId();
        if (pid) {
          if (pid === profileId)
            iCount += 1;
          continue;
        }
      }
    }
    return iCount;
  }

  async _isStrictVPN(policy) {
    const type = policy.type;
    const state = policy.state;
    const profileId = policy[type] && policy[type].profileId;
    if (!profileId) {
      state && log.error("VPNClient profileId is not specified", policy);
      return false;
    }
    const c = VPNClient.getClass(type);
    if (!c) {
      log.error(`Unsupported VPN client type: ${type}`);
      return false;
    }
    const exists = await c.profileExists(profileId);
    if (!exists) {
      log.error(`VPN client ${profileId} does not exist`);
      return false;
    }

    const vpnClient = new c({ profileId });
    const settings = await vpnClient.loadSettings();
    return settings.strictVPN;
  }

  /// return a list of profile id
  async getAllActiveStrictVPNClients(policy) {
    const list = [];
    const multiClients = policy.multiClients;
    if (_.isArray(multiClients)) {
      for (const client of multiClients) {
        const state = client.state;
        if (state) {
          const result = await this._isStrictVPN(client);
          if (result) {
            const type = client.type;
            const profileId = client[type] && client[type].profileId;
            list.push(profileId);
          }
        }
      }
    }   

    return list;
  }

  async vpnClient(policy) {
    /*
      multiple vpn clients config
      {
        "multiClients": [
          {
            "type": "wireguard",
            "state": true,
            "wireguard": {
              "profileId": "xxxxx"
            }
          },
          {
            "type": "openvpn",
            "state": true,
            "openvpn": {
              "profileId": "yyyyy"
            }
          }
        ]
      }
    */
    const multiClients = policy.multiClients;
    if (_.isArray(multiClients)) {
      const updatedClients = [];
      for (const client of multiClients) {
        const result = await this.vpnClient(client);
        updatedClients.push(Object.assign({}, client, result));
      }

      // only send for multicilents
      sem.sendEventToFireMain({
        type: Message.MSG_OSI_GLOBAL_VPN_CLIENT_POLICY_DONE,
        message: ""
      });
      return {multiClients: updatedClients};
    } else {
      const type = policy.type;
      const state = policy.state;
      const profileId = policy[type] && policy[type].profileId;
      if (!profileId) {
        state && log.error("VPNClient profileId is not specified", policy);
        return { state: false };
      }
      let settings = policy[type] && policy[type].settings || {};
      const c = VPNClient.getClass(type);
      if (!c) {
        log.error(`Unsupported VPN client type: ${type}`);
        return { state: false };
      }
      const exists = await c.profileExists(profileId);
      if (!exists) {
        log.error(`VPN client ${profileId} does not exist`);
        return { state: false }
      }
      const vpnClient = new c({ profileId });
      if (Object.keys(settings).length > 0)
        await vpnClient.saveSettings(settings);
      settings = await vpnClient.loadSettings(); // settings is merged with default settings
      const rtId = await vpnClientEnforcer.getRtId(vpnClient.getInterfaceName());
      if (!rtId) {
        log.error(`Routing table id is not found for ${profileId}`);
        return { state: false };
      }
      if (state === true) {
        let setupResult = true;
        await vpnClient.setup().catch((err) => {
          // do not return false here since following start() operation should fail
          log.error(`Failed to setup ${type} client for ${profileId}`, err);
          setupResult = false;
        });
        if (!setupResult)
          return { state: false };
        await vpnClient.start();
      } else {
        // proceed to stop anyway even if setup is failed
        await vpnClient.setup().catch((err) => {
          log.error(`Failed to setup ${type} client for ${profileId}`, err);
        });
        await vpnClient.stop();
      }

      // do not change anything by default
      return {};
    }
  }

  async tags() { /* not supported */ }

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

  getActiveHosts() {
    const activeTimestampThreshold = Date.now() / 1000 - 7 * 86400;
    return this.hosts.all.filter(host => host.o && host.o.lastActiveTimestamp > activeTimestampThreshold)
  }

  // return a list of mac addresses that's active in last xx days
  getActiveMACs() {
    return this.getActiveHosts().map(host => host.o.mac);
  }

  // return: Array<{intf: string, macs: Array<string>}>
  getActiveIntfs() {
    let intfMap = {};
    this.getActiveHosts().filter(host => host && host.o.intf)
      .forEach(host => {
        host = host.o
        if (intfMap[host.intf]) {
          intfMap[host.intf].push(host.mac);
        } else {
          intfMap[host.intf] = [host.mac];
        }
      });

    if (platform.isFireRouterManaged()) {
      const guids = IdentityManager.getAllIdentitiesGUID();
      for (const guid of guids) {
        const identity = IdentityManager.getIdentityByGUID(guid);
        const nicUUID = identity.getNicUUID();
        if (nicUUID) {
          if (intfMap[nicUUID]) {
            intfMap[nicUUID].push(guid);
          } else {
            intfMap[nicUUID] = [guid];
          }
        }
      }
    }

    return _.map(intfMap, (macs, intf) => {
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
    this.getActiveHosts().filter(host => host && host.policy && !_.isEmpty(Object.keys(Constants.TAG_TYPE_MAP).flatMap(type => host.policy[Constants.TAG_TYPE_MAP[type].policyKey])))
      .forEach(host => {
        const tags = Object.keys(Constants.TAG_TYPE_MAP).flatMap(type => host.policy[Constants.TAG_TYPE_MAP[type].policyKey]);
        for (const tag of tags) {
          if (tagMap[tag]) {
            tagMap[tag].push(host.o.mac);
          } else {
            tagMap[tag] = [host.o.mac];
          }
        }
      });
    IdentityManager.getAllIdentitiesFlat().filter(identity => identity.policy && !_.isEmpty(Object.keys(Constants.TAG_TYPE_MAP).flatMap(type => identity.policy[Constants.TAG_TYPE_MAP[type].policyKey])))
      .forEach(identity => {
        const tags = Object.keys(Constants.TAG_TYPE_MAP).flatMap(type => identity.policy[Constants.TAG_TYPE_MAP[type].policyKey])
        for (const tag of tags) {
          if (tagMap[tag])
            tagMap[tag].push(identity.getGUID());
          else
            tagMap[tag] = [identity.getGUID()];
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
      return host.o && host.policy && Object.keys(Constants.TAG_TYPE_MAP).flatMap(type => host.policy[Constants.TAG_TYPE_MAP[type].policyKey] || []).map(String).includes(tag.toString())
    }).map(host => host.o.mac);
    const guids = IdentityManager.getAllIdentitiesFlat().filter(identity => identity.policy && Object.keys(Constants.TAG_TYPE_MAP).flatMap(type => identity.policy[Constants.TAG_TYPE_MAP[type].policyKey] || []).map(String).includes(tag.toString())).map(identity => identity.getGUID());
    return _.uniq(macs.concat(guids));
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
          h.oper = {};
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
