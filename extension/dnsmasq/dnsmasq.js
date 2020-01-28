/*    Copyright 2019-2020 Firewalla Inc.
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
const spawn = require('child_process').spawn
const f = require('../../net2/Firewalla.js');
const ip = require('ip');
const userID = f.getUserID();
const childProcess = require('child_process');
const execAsync = util.promisify(childProcess.exec);
const Promise = require('bluebird');
const redis = require('../../util/redis_manager.js').getRedisClient();
const fs = Promise.promisifyAll(require("fs"));
const validator = require('validator');
const Mode = require('../../net2/Mode.js');
const HostTool = require('../../net2/HostTool.js');
const hostTool = new HostTool();
const rclient = require('../../util/redis_manager.js').getRedisClient();
const PlatformLoader = require('../../platform/PlatformLoader.js')
const platform = PlatformLoader.getPlatform()
const DNSTool = require('../../net2/DNSTool.js')
const dnsTool = new DNSTool()
const fireRouter = require('../../net2/FireRouter.js')
const fc = require('../../net2/config.js')
const { delay } = require('../../util/util.js');

const { Rule, CHAINS } = require('../../net2/Iptables.js');

const FILTER_DIR = f.getUserConfigFolder() + "/dnsmasq";
const LEGACY_FILTER_DIR = f.getUserConfigFolder() + "/dns";
const LOCAL_DOMAIN_FILE = FILTER_DIR + "/local_device_domain.conf";
const LOCAL_DOMAIN_KEY = "local:device:domain"
const systemLevelMac = "FF:FF:FF:FF:FF:FF";

const FILTER_FILE = {
  adblock: FILTER_DIR + "/adblock_filter.conf",
  adblockTmp: FILTER_DIR + "/adblock_filter.conf.tmp",

  family: FILTER_DIR + "/family_filter.conf",
  familyTmp: FILTER_DIR + "/family_filter.conf.tmp",

  policy: FILTER_DIR + "/policy_filter.conf"
}

const policyFilterFile = FILTER_DIR + "/policy_filter.conf";

const pclient = require('../../util/redis_manager.js').getPublishClient();
const sclient = require('../../util/redis_manager.js').getSubscriptionClient();
const sem = require('../../sensor/SensorEventManager.js').getInstance();

const sysManager = require('../../net2/SysManager');

const Config = require('../../net2/config.js');
let fConfig = Config.getConfig(true);

const bone = require("../../lib/Bone.js");

const iptables = require('../../net2/Iptables');
const ip6tables = require('../../net2/Ip6tables.js')

const dnsmasqBinary = __dirname + "/dnsmasq";
const pidFile = f.getRuntimeInfoFolder() + "/dnsmasq.pid";
const startScriptFile = __dirname + "/dnsmasq.sh";

const configFile = __dirname + "/dnsmasq.conf";

const resolvFile = f.getRuntimeInfoFolder() + "/dnsmasq.resolv.conf";

const interfaceDhcpRange = {};

let defaultNameServers = {};
let interfaceNameServers = {};
let upstreamDNS = null;

const FILTER_EXPIRE_TIME = 86400 * 1000;

const BLACK_HOLE_IP = "0.0.0.0"
const BLUE_HOLE_IP = "198.51.100.100"

const DEFAULT_DNS_SERVER = (fConfig.dns && fConfig.dns.defaultDNSServer) || "8.8.8.8";
const FALLBACK_DNS_SERVERS = (fConfig.dns && fConfig.dns.fallbackDNSServers) || ["8.8.8.8", "1.1.1.1"];
const VERIFICATION_DOMAINS = (fConfig.dns && fConfig.dns.verificationDomains) || ["firewalla.encipher.io"];
const RELOAD_INTERVAL = 3600 * 24 * 1000; // one day

const SERVICE_NAME = platform.isFireRouterManaged() ? 'firerouter_dns' : 'firemasq';
const HOSTFILE_PATH = platform.isFireRouterManaged() ?
  f.getUserHome() + fConfig.firerouter.hiddenFolder + '/config/dhcp/hosts/hosts' :
  f.getRuntimeInfoFolder() + "/dnsmasq-hosts";
const MASQ_PORT = platform.isFireRouterManaged() ? 53 : 8853;

let statusCheckTimer = null;

module.exports = class DNSMASQ {
  constructor() {
    if (instance == null) {
      log = require("../../net2/logger.js")(__filename);

      instance = this;

      this.mode = null;
      this.minReloadTime = new Date() / 1000;
      this.deleteInProgress = false;
      this.shouldStart = false;
      this.needRestart = null;
      this.updatingLocalDomain = false;
      this.needWriteHostsFile = null;
      this.throttleTimer = {};
      this.failCount = 0 // this is used to track how many dnsmasq status check fails in a row

      this.hashTypes = {
        adblock: 'ads',
        family: 'family'
      };

      this.state = {
        adblock: undefined,
        family: undefined
      };

      this.nextState = {
        adblock: undefined,
        family: undefined
      };

      this.reloadCount = {
        adblock: 0,
        family: 0
      };

      this.nextReloadFilter = {
        adblock: [],
        family: []
      }

      this.counter = {
        reloadDnsmasq: 0,
        writeHostsFile: 0,
        restart: 0
      }
      this.dnsTag = {
        adblock: "$adblock"
      }
      sem.once('IPTABLES_READY', () => {
        if (f.isMain()) {
          setInterval(() => {
            this.checkIfRestartNeeded()
          }, 10 * 1000) // every 10 seconds

          setInterval(() => {
            this.checkIfWriteHostsFile();
          }, 10 * 1000);

          process.on('exit', () => {
            this.shouldStart = false;
            this.stop();
          });

          sclient.on("message", (channel, message) => {
            switch (channel) {
              case "System:IPChange":
                (async () => {
                  const started = await this.checkStatus();
                  if (started)
                    await this.start(false); // raw restart dnsmasq to refresh all confs and iptables
                })();
                break;
              case "System:VPNSubnetChanged":
                (async () => {
                  const newVpnSubnet = message;
                  if (newVpnSubnet)
                    await this.updateVpnIptablesRules(newVpnSubnet, true);
                })();
                break;
              default:
              //log.warn("Unknown message channel: ", channel, message);
            }
          });

          sclient.subscribe("System:IPChange");
          sclient.subscribe("System:VPNSubnetChanged");
        }
      })
    }

    return instance;
  }

  async install() {
    let install_cmd = util.format('cd %s; bash ./install.sh', __dirname);
    try {
      await execAsync(install_cmd);
      log.info("DNSMASQ:INSTALL:Success", "Dnsmasq is installed successfully");
    } catch (err) {
      log.error("DNSMASQ:INSTALL:Error", "Failed to execute script install.sh", err);
      throw err;
    }
  }

  async uninstall() {
    // TODO
  }

  // in format 127.0.0.1#5353
  async setUpstreamDNS(dns) {
    if (dns === upstreamDNS) {
      log.info("upstreamdns is same as dns, ignored. (" + dns + ")");
      return;
    }

    log.info("upstream dns is set to", dns);
    upstreamDNS = dns;

    let enabled = await this.checkStatus();

    if (enabled) {
      try {
        await this.start(true); // only need to change firemasq service unit file and restart firemasq, no need to update iptables
        log.info("dnsmasq is restarted to apply new upstream dns");
      } catch (err) {
        log.error("Failed to restart dnsmasq to apply new upstream dns");
      }
    } else {
      // do nothing if it is not enabled
    }
  }

  async updateResolvConf() {
    let nameservers = this.getAllDefaultNameServers() || [];
    let secondaryIntfNameServers = interfaceNameServers.secondary || [];
    let alternativeIntfNameServers = interfaceNameServers.alternative || [];

    let effectiveNameServers = nameservers;
    // different interface specific nameservers take effect in different mode
    if (this.mode === Mode.MODE_DHCP) {
      effectiveNameServers = effectiveNameServers.concat(secondaryIntfNameServers); // specified interface dns servers are listed after default name servers, e.g., OpenDNS, upstream DNS
    } else {
      // for simple or dhcp spoof mode
      effectiveNameServers = effectiveNameServers.concat(alternativeIntfNameServers);
    }

    // add local dns as a fallback in dnsmasq's resolv.conf
    sysManager.myDNS().forEach((dns) => {
      if (effectiveNameServers && !effectiveNameServers.includes(dns))
        effectiveNameServers.push(dns);
    })

    // add fallback dns servers in case every previous dns server is broken
    if (FALLBACK_DNS_SERVERS) {
      FALLBACK_DNS_SERVERS.forEach((dns) => {
        if (effectiveNameServers && !effectiveNameServers.includes(dns))
          effectiveNameServers.push(dns);
      })
    }

    if (!effectiveNameServers || effectiveNameServers.length === 0) {
      effectiveNameServers = [DEFAULT_DNS_SERVER];  // use google dns by default, should not reach this code
    }

    let effectiveEntries = effectiveNameServers.map(ip => "nameserver " + ip);
    let effectiveConfig = effectiveEntries.join('\n') + "\n";

    try {
      await fs.writeFileAsync(resolvFile, effectiveConfig);
    } catch (err) {
      log.error("Error when updating resolv.conf:", resolvFile, "error msg:", err.message);
      throw err;
    }

    try {
      await execAsync("pkill -SIGHUP dnsmasq");
    } catch (err) {
      // ignore error if dnsmasq not exists
    }
  }

  async updateFilter(type, force) {
    let result = await this._updateTmpFilter(type, force);
    if (!result) {
      return;
    }

    // needs update
    const filter = FILTER_FILE[type];
    const filterTmp = FILTER_FILE[type + 'Tmp'];

    log.info(`${type} filter file is `, filter);
    log.info(`${type} tmp filter file is `, filterTmp);
    try {
      await fs.accessAsync(filterTmp, fs.constants.F_OK);
      await fs.renameAsync(filterTmp, filter);
    } catch (err) {
      log.error('Error when updating filter', err);
    }
  }

  _scheduleNextReload(type, oldNextState, curNextState) {
    if (oldNextState === curNextState) {
      // no need immediate reload when next state not changed during reloading
      this.nextReloadFilter[type].forEach(t => clearTimeout(t));
      this.nextReloadFilter[type].length = 0;
      log.info(`schedule next reload for ${type} in ${RELOAD_INTERVAL / 1000}s`);
      this.nextReloadFilter[type].push(setTimeout(this._reloadFilter.bind(this), RELOAD_INTERVAL, type));
    } else {
      log.warn(`${type}'s next state changed from ${oldNextState} to ${curNextState} during reload, will reload again immediately`);
      if (this.reloadFilterImmediate) {
        clearImmediate(this.reloadFilterImmediate)
      }
      this.reloadFilterImmediate = setImmediate(this._reloadFilter.bind(this), type);
    }
  }

  _reloadFilter(type) {
    let preState = this.state[type];
    let nextState = this.nextState[type];
    this.state[type] = nextState;
    log.info(`in reloadFilter(${type}): preState: ${preState}, nextState: ${this.state[type]}, this.reloadCount: ${this.reloadCount[type]++}`);

    if (nextState === true) {
      log.info(`Start to update ${type} filters.`);
      this.updateFilter(type, true)
        .then(() => {
          log.info(`Update ${type} filters successful.`);
          this.reload().then(() => this._scheduleNextReload(type, nextState, this.nextState[type]));
        }).catch(err => {
          log.error(`Update ${type} filters Failed!`, err);
        });
    } else {
      if (preState === false && nextState === false) {
        // disabled, no need do anything
        this._scheduleNextReload(type, nextState, this.nextState[type]);
        return;
      }

      log.info(`Start to clean up ${type} filters.`);
      this.cleanUpFilter(type)
        .catch(err => log.error(`Error when clean up ${type} filters`, err))
        .then(() => this.reload().then(() => this._scheduleNextReload(type, nextState, this.nextState[type])));
    }
  }

  controlFilter(type, state) {
    this.nextState[type] = state;
    log.info(`${type} nextState is: ${this.nextState[type]}`);
    if (this.state[type] !== undefined) {
      // already timer running, clear existing ones before trigger next round immediately
      this.nextReloadFilter[type].forEach(t => clearTimeout(t));
      this.nextReloadFilter[type].length = 0;
    }
    if (this.reloadFilterImmediate) {
      clearImmediate(this.reloadFilterImmediate)
    }
    this.reloadFilterImmediate = setImmediate(this._reloadFilter.bind(this), type);
  }

  async cleanUpFilter(type) {
    const file = FILTER_FILE[type];
    log.info("Clean up filter file:", file);
    try {
      await fs.unlinkAsync(file);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // ignore
        log.info(`Filter file '${file}' not exist, ignore`);
      } else {
        log.error(`Failed to remove filter file: '${file}'`, err);
      }
    }
  }

  async addPolicyFilterEntry(domains, options) {
    log.debug("addPolicyFilterEntry", domains, options)
    options = options || {}
    while (this.workingInProgress) {
      log.info("deferred due to dnsmasq is working in progress")
      await delay(1000);  // try again later
    }
    this.workingInProgress = true;

    let entry = "";
    for (const domain of domains) {
      if (options.scope && options.scope.length > 0) {
        for (const mac of options.scope) {
          entry += `address=/${domain}/${BLACK_HOLE_IP}%${mac.toUpperCase()}\n`
        }
      } else {
        entry += `address=/${domain}/${BLACK_HOLE_IP}\n`
      }
    }
    try {
      await fs.appendFileAsync(policyFilterFile, entry);
    } catch (err) {
      log.error("Failed to add policy filter entry into file:", err);
    } finally {
      this.workingInProgress = false;
    }
  }

  async addPolicyCategoryFilterEntry(domains, options) {
    log.debug("addPolicyCategoryFilterEntry", domains, options)
    while (this.workingInProgress) {
      log.info("deferred due to dnsmasq is working in progress")
      await delay(1000);  // try again later
    }
    this.workingInProgress = true;
    options = options || {};
    const category = options.category;
    const categoryBlockDomainsFile = FILTER_DIR + `/${category}_block.conf`;
    const categoryBlcokMacSetFile = FILTER_DIR + `/${category}_mac_set.conf`;
    try {
      let entry = "", macSetEntry = "";
      for (const domain of domains) {
        entry += `address=/${domain}/${BLACK_HOLE_IP}$${category}_block\n`;
      }
      if (options.scope && options.scope.length > 0) {
        for (const mac of options.scope) {
          macSetEntry += `mac-address-tag=%${mac.toUpperCase()}$${category}_block\n`
        }
      } else {
        macSetEntry = `mac-address-tag=%${systemLevelMac}$${category}_block\n`;
      }
      await fs.writeFileAsync(categoryBlockDomainsFile, entry);
      await fs.appendFileAsync(categoryBlcokMacSetFile, macSetEntry);
    } catch (err) {
      log.error("Failed to add category mact set entry into file:", err);
    } finally {
      this.workingInProgress = false; // make sure the flag is reset back
    }
  }

  async removePolicyCategoryFilterEntry(domains, options) {
    log.debug("removePolicyCategoryFilterEntry", domains, options)
    while (this.workingInProgress) {
      log.info("deferred due to dnsmasq is working in progress")
      await delay(1000);  // try again later
    }
    this.workingInProgress = true;
    options = options || {};
    const category = options.category;
    const categoryBlcokMacSetFile = FILTER_DIR + `/${category}_mac_set.conf`;
    let macSetEntry = [];
    if (options.scope && options.scope.length > 0) {
      for (const mac of options.scope) {
        macSetEntry.push(`mac-address-tag=%${mac.toUpperCase()}$${category}_block`)
      }
    } else {
      macSetEntry.push(`mac-address-tag=%${systemLevelMac}$${category}_block`)
    }
    try {
      let data = await fs.readFileAsync(categoryBlcokMacSetFile, 'utf8');
      let newData = data.split("\n").filter((line) => {
        return macSetEntry.indexOf(line) == -1
      }).join("\n");
      await fs.writeFileAsync(categoryBlcokMacSetFile, newData);
    } catch (err) {
      if (err.code != "ENOENT") {
        log.error("Failed to update category mact set entry file:", err);
      }
    } finally {
      this.workingInProgress = false;
    }
  }

  async updatePolicyCategoryFilterEntry(domains, options) {
    log.debug("updatePolicyCategoryFilterEntry", domains, options)
    while (this.workingInProgress) {
      log.info("deferred due to dnsmasq is working in progress")
      await delay(1000);  // try again later
    }
    this.workingInProgress = true;
    options = options || {};
    const category = options.category;
    const categoryBlockDomainsFile = FILTER_DIR + `/${category}_block.conf`;
    const categoryBlcokMacSetFile = FILTER_DIR + `/${category}_mac_set.conf`;
    let entry = "";
    for (const domain of domains) {
      entry += `address=/${domain}/${BLACK_HOLE_IP}$${category}_block\n`;
    }
    try {
      await fs.writeFileAsync(categoryBlockDomainsFile, entry);
      //check dnsmasq need restart or not
      const data = await fs.readFileAsync(categoryBlcokMacSetFile, 'utf8');
      if (data.indexOf(`$${category}_block`) > -1) this.restartDnsmasq();
    } catch (err) {
      if (err.code != 'ENOENT') {
        log.error("Failed to update category entry into file:", err);
      }
    } finally {
      this.workingInProgress = false;
    }
  }

  async removePolicyFilterEntry(domains, options) {
    log.debug("removePolicyFilterEntry", domains, options)
    options = options || {}
    while (this.workingInProgress) {
      log.info("deferred due to dnsmasq is working in progress");
      await delay(1000);  // try again later
    }
    this.workingInProgress = true;
    let entry = [];
    for (const domain of domains) {
      if (options.scope && options.scope.length > 0) {
        for (const mac of options.scope) {
          entry.push(`address=/${domain}/${BLACK_HOLE_IP}%${mac.toUpperCase()}`)
        }
      } else {
        entry.push(`address=/${domain}/${BLACK_HOLE_IP}`);
      }
    }
    try {
      let data = await fs.readFileAsync(policyFilterFile, 'utf8');
      let newData = data.split("\n").filter((line) => {
        return entry.indexOf(line) == -1
      }).join("\n");
      await fs.writeFileAsync(policyFilterFile, newData);
    } catch (err) {
      log.error("Failed to write policy data file:", err);
    } finally {
      this.workingInProgress = false; // make sure the flag is reset back
    }
  }

  async addPolicyFilterEntries(domains) {
    let entries = domains.map(domain => util.format("address=/%s/%s", domain, BLACK_HOLE_IP));
    let data = entries.join("\n");
    await fs.appendFileAsync(policyFilterFile, data);
  }

  setDefaultNameServers(key, ips) {
    let _ips;
    if (Array.isArray(ips)) {
      _ips = ips.filter(x => validator.isIP(x));
    } else {
      if (!validator.isIP(ips.toString())) {
        return;
      }
      _ips = [ips.toString()];
    }
    defaultNameServers[key] = _ips;
  }

  setInterfaceNameServers(intf, ips) {
    let _ips;
    if (Array.isArray(ips)) {
      _ips = ips.filter(x => validator.isIP(x));
    } else {
      if (!validator.isIP(ips.toString())) {
        return;
      }
      _ips = [ips.toString()];
    }
    interfaceNameServers[intf] = _ips;
  }

  unsetDefaultNameServers(key) {
    delete defaultNameServers[key]
  }

  getAllDefaultNameServers() {
    let list = [];
    Object.keys(defaultNameServers).sort().forEach(key => {
      let ips = defaultNameServers[key]
      if (Array.isArray(ips)) {
        Array.prototype.push.apply(list, ips);
      }
    });
    return list
  }

  async getCurrentNameServerList() {
    let cmd = `grep 'nameserver' ${resolvFile} | head -n 1 | cut -d ' ' -f 2`;
    log.info("Command to get current name server: ", cmd);

    let { stdout } = await execAsync(cmd);

    if (!stdout || stdout === '') {
      return [];
    }

    let list = stdout.split('\n');
    return list.filter((x, i) => list.indexOf(x) === i);
  }

  async reload() {
    log.info("Dnsmasq reloading.");
    let self = this;
    try {
      await self.start(false);
      log.info("Dnsmasq reload complete.");
    } catch (err) {
      log.error("Got error when reloading dnsmasq:", err);
    }
  }

  async _updateTmpFilter(type, force) {
    let mkdirp = util.promisify(require('mkdirp'));

    try {
      await mkdirp(FILTER_DIR);
    } catch (err) {
      log.error("Error when mkdir:", FILTER_DIR, err);
      return;
    }

    const filterFile = FILTER_FILE[type];
    const filterFileTmp = FILTER_FILE[type + 'Tmp'];

    // Check if the filter file is older enough that needs to refresh
    let stats, noent;
    try {
      stats = await fs.statAsync(filterFile);
    } catch (err) {
      // no such file, need to crate one
      //log.error("Error when fs.stat", filterFile, err);
      if (err.code !== "ENOENT") {
        throw err;
      }
      noent = true;
    }

    // to update only if filter file has not been updated recently or doesn't exsit
    if (force || noent || (new Date() - stats.mtime) > FILTER_EXPIRE_TIME) {
      try {
        await fs.statAsync(filterFileTmp);
        await fs.unlinkAsync(filterFileTmp);
      } catch (err) {
        if (err.code !== "ENOENT") {
          throw err;
        }
      }

      let hashes = null;
      try {
        hashes = await this._loadFilterFromBone(type);
      } catch (err) {
        log.error("Error when load filter from bone", err);
        return;
      }

      try {
        await this._writeHashFilterFile(type, hashes, filterFileTmp);
      } catch (err) {
        log.error("Error when writing hashes into filter file", err);
        return;
      }

      try {
        await this._writeHashIntoRedis(type, hashes);
      } catch (err) {
        log.error("Error when writing hashes into filter redis", err);
        return;
      }

      return true; // successfully updated hash filter files
    }
  }

  async _loadFilterFromBone(type) {
    const name = f.isProduction() ? this.hashTypes[type] : this.hashTypes[type] + '-dev';

    log.info(`Load data set from bone: ${name}`);

    let data = await bone.hashsetAsync(name);
    return JSON.parse(data);
  }

  async updateVpnIptablesRules(newVpnSubnet, force) {
    const oldVpnSubnet = this.vpnSubnet;
    // TODO: to another dnsmasq instance
    const dns = `127.0.0.1:${MASQ_PORT}`;
    const started = await this.checkStatus();
    if (!started)
      return;
    if (oldVpnSubnet != newVpnSubnet || force === true) {
      // remove iptables rule for old vpn subnet
      await iptables.dnsFlushAsync('vpn');
    }
    // then add new iptables rule for new vpn subnet. If newVpnSubnet is null, no new rule is added
    if (newVpnSubnet) {
      // newVpnSubnet is null means to delete previous nat rule. The previous vpn subnet should be kept in case of dnsmasq reloading
      await iptables.dnsChangeAsync(newVpnSubnet, dns, 'vpn', true);
      this.vpnSubnet = newVpnSubnet;
    }
  }

  async _add_all_iptables_rules() {
    if (this.vpnSubnet) {
      await this.updateVpnIptablesRules(this.vpnSubnet, true);
    }
    await this._add_iptables_rules();
    await this._add_ip6tables_rules();
  }

  async _add_iptables_rules() {
    const interfaces = sysManager.getMonitoringInterfaces()
    for (const intf of interfaces) {
      const redirectTCP = new Rule('nat').chn('FW_PREROUTING_DNS_DEFAULT').pro('tcp')
        .mth(intf.subnet, null, 'src')
        .pam('-m set ! --match-set no_dns_caching_mac_set src')
        .mth(53, null, 'dport')
        .jmp(`DNAT --to-destination ${intf.ip_address}:${MASQ_PORT}`)
      const redirectUDP = redirectTCP.clone().pro('udp')
      await execAsync(redirectTCP.toCmd('-I'))
      await execAsync(redirectUDP.toCmd('-I'))
    }
  }

  async _add_ip6tables_rules() {
    const ipv6s = sysManager.myIp6();

    for (let index in ipv6s) {
      const ip6 = ipv6s[index]
      if (ip6.startsWith("fe80::")) {
        // use local link ipv6 for port forwarding, both ipv4 and v6 dns traffic should go through dnsmasq
        await ip6tables.dnsRedirectAsync(ip6, MASQ_PORT, 'local');
      }
    }
  }

  async _remove_all_iptables_rules() {
    if (this.vpnSubnet) {
      await this.updateVpnIptablesRules(null, true);
    }
    await this._remove_iptables_rules()
    await this._remove_ip6tables_rules();
  }

  async _remove_iptables_rules() {
    try {
      const flush = new Rule('nat').chn('FW_PREROUTING_DNS_DEFAULT')
      await execAsync(flush.toCmd('-F'))
    } catch (err) {
      log.error("Error when removing iptable rules", err);
    }
  }

  async _remove_ip6tables_rules() {
    try {
      const flush = new Rule('nat').fam(6).chn('FW_PREROUTING_DNS_DEFAULT')
      await execAsync(flush.toCmd('-F'))
    } catch (err) {
      log.error("Error when remove ip6tables rules", err);
    }
  }

  async _writeHashIntoRedis(type, hashes) {
    log.info(`Writing hash into redis for type: ${type}`);
    let key = `dns:hashset:${type}`;
    await Promise.map(hashes, async hash => redis.saddAsync(key, hash));
    let count = await redis.scardAsync(key);
    log.info(`Finished writing hash into redis for type: ${type}, count: ${count}`);
  }

  async _writeHashFilterFile(type, hashes, file) {
    return new Promise((resolve, reject) => {
      log.info("Writing hash filter file:", file);

      let writer = fs.createWriteStream(file);

      writer.on('finish', () => {
        log.info("Finished writing hash filter file", file);
        resolve();
      });

      writer.on('error', err => {
        reject(err);
      });

      let targetIP = BLACK_HOLE_IP

      if (type === "family") {
        targetIP = BLUE_HOLE_IP
      }
      const tag = this.dnsTag[type] ? this.dnsTag[type] : "";
      hashes.forEach((hash) => {
        let line = util.format("hash-address=/%s/%s%s\n", hash.replace(/\//g, '.'), targetIP, tag)
        writer.write(line);
      });

      writer.end();
    });
  }

  async checkStatus() {
    let cmd = `pgrep -f ${dnsmasqBinary}`;
    log.info("Command to check dnsmasq: ", cmd);

    try {
      await execAsync(cmd);
      return true;
    } catch (err) {
      return false;
    }
  }

  checkIfRestartNeeded() {
    const MINI_RESTART_INTERVAL = 10 // 10 seconds

    if (this.needRestart) {
      log.info("need restart is", this.needRestart);
    }

    if (this.shouldStart && this.needRestart && (new Date() / 1000 - this.needRestart) > MINI_RESTART_INTERVAL) {
      this.needRestart = null
      this.rawRestart((err) => {
        if (err) {
          log.error("Failed to restart dnsmasq")
        } else {
          log.info("dnsmasq restarted:", this.counter.restart);
        }
      }) // just restart to have new policy filters take effect
    }
  }

  checkIfWriteHostsFile() {
    if (this.needWriteHostsFile) {
      log.info("need writeHostsFile is", this.needWriteHostsFile);
    }
    if (this.shouldStart && this.needWriteHostsFile) {
      this.needWriteHostsFile = null;
      this.writeHostsFile().then((reload) => {
        if (reload) {
          this.reloadDnsmasq();
        }
      });
    }
  }

  onDHCPReservationChanged() {
    if (this.mode === Mode.MODE_DHCP ||
        this.mode === Mode.MODE_DHCP_SPOOF ||
        this.mode === Mode.MODE_ROUTER
    ) {
      this.needWriteHostsFile = true;
      log.debug("DHCP reservation changed, set needWriteHostsFile file to true");
    }
  }

  onSpoofChanged() {
    if (this.mode === Mode.MODE_DHCP || this.mode === Mode.MODE_DHCP_SPOOF) {
      this.needWriteHostsFile = true;
      log.debug("Spoof status changed, set needWriteHostsFile to true");
    }
  }

  async reloadDnsmasq() {
    this.counter.reloadDnsmasq++;
    log.info("start to reload dnsmasq (-HUP):", this.counter.reloadDnsmasq);
    try {
      await execAsync('sudo systemctl reload firemasq');
    } catch (err) {
      log.error("Unable to reload firemasq service", err);
    }
    log.info("Dnsmasq has been Reloaded:", this.counter.reloadDnsmasq);
  }

  computeHash(content) {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(content).digest("hex");
  }

  async writeHostsFile() {
    this.counter.writeHostsFile++;
    log.info("start to generate hosts file for dnsmasq:", this.counter.writeHostsFile);

    const lease_time = '24h';

    // legacy ip reservation is set in host:mac:*
    const hosts = (await Promise.map(redis.keysAsync("host:mac:*"), key => redis.hgetallAsync(key)))
      .filter((x) => (x && x.mac) != null)
      .sort((a, b) => a.mac.localeCompare(b.mac));

    hosts.forEach(h => {
      try {
        if (h.intfIp) h.intfIp = JSON.parse(h.intfIp)
      } catch(err) {
        log.error('Invalid host:mac->intfIp', h.intfIp, err)
        delete h.intfIp
      }
    })

    // const policyKeys = await rclient.keysAsync("policy:mac:*")
    // // generate a map of mac -> ipAllocation host policy
    // const policyMap = policyKeys.reduce(async (mapResult, key) => {
    //   const map = await mapResult
    //   const mac = key.substring(11)

    //   const policy = await rclient.hgetAsync(key, 'ipAllocation')
    //   if (policy) map[mac] = policy
    //   return map
    // }, Promise.resolve({}))

    const hostsList = []

    for (const h of hosts) {
      for (const intf of sysManager.getMonitoringInterfaces()) {
        const monitor = h.spoofing === 'true' ? 'monitor' : 'unmonitor'

        let reservedIp = null;
        if (h.intfIp && h.intfIp[intf.uuid]) {
          reservedIp = h.intfIp[intf.uuid].ipv4
        } else if (h.staticAltIp && (!monitor || this.mode == Mode.MODE_DHCP_SPOOF)) {
          reservedIp = h.staticAltIp
        } else if (h.staticSecIp && monitor && this.mode == Mode.MODE_DHCP) {
          reservedIp = h.staticSecIp
        }

        reservedIp = reservedIp ? reservedIp + ',' : ''

        hostsList.push(
          `${h.mac},set:${monitor},${reservedIp}${lease_time}`
        )
      }
    }

    let _hosts = hostsList.join("\n") + "\n";

    let shouldUpdate = false;
    const _hostsHash = this.computeHash(_hosts);

    if (this.lastHostsHash !== _hostsHash) {
      shouldUpdate = true;
      this.lastHostsHash = _hostsHash;
    }

    if (shouldUpdate === false) {
      log.info("No need to update hosts file, skipped");
      return false;
    }

    log.debug("HostsFile:", util.inspect(hostsList));

    fs.writeFileSync(HOSTFILE_PATH, _hosts);
    log.info("Hosts file has been updated:", this.counter.writeHostsFile)

    return true;
  }

  async rawStart() {
    // use restart to ensure the latest configuration is loaded
    let cmd = `${dnsmasqBinary}.${f.getPlatform()} -k --clear-on-reload -u ${userID} -C ${configFile} -r ${resolvFile}`;

    cmd = await this.prepareDnsmasqCmd(cmd);

    if (upstreamDNS) {
      log.info("upstream server", upstreamDNS, "is specified");
      cmd = util.format("%s --server=%s --no-resolv", cmd, upstreamDNS);
    }

    this.writeStartScript(cmd);

    await this.writeHostsFile();

    if (f.isDocker()) {
      await this.restartDnsmasqDocker();
    } else {
      await this.restartDnsmasq();
    }
  }

  async restartDnsmasqDocker() {
    try {
      childProcess.execSync("sudo pkill dnsmasq")
    } catch (err) {
      // do nothing
    }

    const p = spawn('/bin/bash', ['-c', 'sudo service dnsmasq restart'])

    p.stdout.on('data', (data) => {
      log.info("DNSMASQ STDOUT:", data.toString());
    })

    p.stderr.on('data', (data) => {
      log.info("DNSMASQ STDERR:", data.toString());
    })

    await delay(1000);
  }

  async restartDnsmasq() {
    try {
      if (!this.needRestart)
        this.needRestart = new Date() / 1000;
      if (!statusCheckTimer) {
        statusCheckTimer = setInterval(() => {
          this.statusCheck()
        }, 1000 * 60 * 1) // check status every minute
        log.info("Status check timer installed")
      }
    } catch (err) {
      log.error("Got error when restarting firemasq:", err);
    }
  }

  writeStartScript(cmd) {
    log.info("Command to start dnsmasq: ", cmd);

    let content = [
      '#!/bin/bash',
      cmd + " &",
      'trap "trap - SIGTERM && kill -- -$$" SIGINT SIGTERM EXIT',
      'for job in `jobs -p`; do wait $job; echo "$job exited"; done',
      ''
    ];

    fs.writeFileSync(startScriptFile, content.join("\n"));
  }

  setDhcpRange(network, begin, end) {
    interfaceDhcpRange[network] = {
      begin: begin,
      end: end
    };
  }

  getDhcpRange(network) {
    let range = interfaceDhcpRange[network];
    if (!range) {
      range = dnsTool.getDefaultDhcpRange(network);
    }
    return range;
  }

  async prepareDnsmasqCmd(cmd) {
    fConfig = Config.getConfig(true);
    const secondaryRange = this.getDhcpRange("secondary");
    const secondaryRouterIp = sysManager.myIp2();
    const secondaryMask = sysManager.myIpMask2();
    let secondaryDnsServers = sysManager.myDNS().join(',');
    if (interfaceNameServers.secondary && interfaceNameServers.secondary.length != 0) {
      // if secondary dns server is set, use specified dns servers in dhcp response
      secondaryDnsServers = interfaceNameServers.secondary.join(',');
    }

    const alternativeRange = this.getDhcpRange("alternative");
    const alternativeRouterIp = sysManager.myGateway();
    const alternativeMask = sysManager.myIpMask();
    let alternativeDnsServers = sysManager.myDNS().join(',');
    if (interfaceNameServers.alternative && interfaceNameServers.alternative.length != 0) {
      // if alternative dns server is set, use specified dns servers in dhcp response
      alternativeDnsServers = interfaceNameServers.alternative.join(',');
    }

    let wifiDnsServers = sysManager.myDNS().join(',');
    if (interfaceNameServers.wifi && interfaceNameServers.wifi.length != 0) {
      // if wifi dns server is set, use specified dns servers in dhcp response
      wifiDnsServers = interfaceNameServers.wifi.join(',');
    }

    const leaseTime = fConfig.dhcp && fConfig.dhcp.leaseTime || "24h";
    const monitoringInterface = fConfig.monitoringInterface || "eth0";

    if (fConfig.wifiInterface) {
      const wifiIntf = fConfig.wifiInterface;
      const mode = wifiIntf.mode || "router";
      const intf = wifiIntf.intf || "wlan0";

      switch (mode) {
        case "router": {
          // need to setup dhcp service on wifi interface for router mode
          if (!wifiIntf.ip)
            break;
          const cidr = ip.cidrSubnet(wifiIntf.ip);
          const wifiRouterIp = wifiIntf.ip.split('/')[0];
          const wifiNetmask = cidr.subnetMask;
          const wifiRange = this.getDhcpRange("wifi");
          if (!wifiRouterIp || !wifiNetmask || !wifiRange)
            break;
          cmd = util.format("%s --dhcp-range=tag:%s,%s,%s,%s,%s",
            cmd,
            intf,
            wifiRange.begin,
            wifiRange.end,
            wifiNetmask,
            leaseTime
          );
          // wifi interface ip as router
          cmd = util.format("%s --dhcp-option=tag:%s,3,%s", cmd, intf, wifiRouterIp);
          // same dns servers as secondary interface
          cmd = util.format("%s --dhcp-option=tag:%s,6,%s", cmd, intf, wifiDnsServers);
          break;
        }
        case "bridge":
          break;
        default:
      }
    }

    if (this.mode === Mode.MODE_DHCP) {
      log.info("DHCP feature is enabled");
      // allocate secondary interface ip to monitored hosts and new hosts
      cmd = util.format("%s --dhcp-range=tag:%s,tag:!unmonitor,%s,%s,%s,%s",
        cmd,
        monitoringInterface,
        secondaryRange.begin,
        secondaryRange.end,
        secondaryMask,
        leaseTime
      );

      // allocate primary(alternative) interface ip to unmonitored hosts
      cmd = util.format("%s --dhcp-range=tag:%s,tag:unmonitor,%s,%s,%s,%s",
        cmd,
        monitoringInterface,
        alternativeRange.begin,
        alternativeRange.end,
        alternativeMask,
        leaseTime
      );

      // secondary interface ip as router for monitored hosts and new hosts
      cmd = util.format("%s --dhcp-option=tag:%s,tag:!unmonitor,3,%s", cmd, monitoringInterface, secondaryRouterIp);

      // gateway ip as router for unmonitored hosts
      if (alternativeRouterIp) {
        cmd = util.format("%s --dhcp-option=tag:%s,tag:unmonitor,3,%s", cmd, monitoringInterface, alternativeRouterIp);
      }

      cmd = util.format("%s --dhcp-option=tag:%s,tag:!unmonitor,6,%s", cmd, monitoringInterface, secondaryDnsServers);
      cmd = util.format("%s --dhcp-option=tag:%s,tag:unmonitor,6,%s", cmd, monitoringInterface, alternativeDnsServers);
    }

    if (this.mode === Mode.MODE_ROUTER) {
      log.info("Router mode is enabled, firerouter will provide dhcp service.");      
    }

    if (this.mode === Mode.MODE_DHCP_SPOOF) {
      log.info("DHCP spoof feature is enabled");
      // allocate primary(alternative) interface ip to all hosts from monitoring interface, no matter it is monitored, unmonitored or new hosts
      cmd = util.format("%s --dhcp-range=tag:%s,%s,%s,%s,%s",
        cmd,
        monitoringInterface,
        alternativeRange.begin,
        alternativeRange.end,
        alternativeMask,
        leaseTime
      );

      // Firewalla's ip as router for monitored hosts and new hosts. In case Firewalla's ip is changed, a thorough restart is required
      cmd = util.format("%s --dhcp-option=tag:%s,tag:!unmonitor,3,%s", cmd, monitoringInterface, sysManager.myIp());

      // gateway ip as router for unmonitored hosts
      cmd = util.format("%s --dhcp-option=tag:%s,tag:unmonitor,3,%s", cmd, monitoringInterface, alternativeRouterIp);

      cmd = util.format("%s --dhcp-option=tag:%s,6,%s", cmd, monitoringInterface, alternativeDnsServers);
    }

    return cmd;
  }

  async rawStop() {
    let cmd = null;
    if (f.isDocker()) {
      cmd = util.format("(file %s &>/dev/null && (cat %s | sudo xargs kill)) || true", pidFile, pidFile);
    } else {
      cmd = "sudo systemctl stop firemasq";
    }

    log.info("Command to stop dnsmasq: ", cmd);

    try {
      await execAsync(cmd);
      if (statusCheckTimer) {
        clearInterval(statusCheckTimer)
        statusCheckTimer = null
        log.info("status check timer is stopped")
      }
    } catch (err) {
      log.error("DNSMASQ:START:Error", "Failed to stop dnsmasq, error code:", err);
    }
  }

  async rawRestart() {
    log.info("Restarting dnsmasq...")
    this.counter.restart++;
    
    // stop first to ensure the child processes are fully terminated before start
    const cmd = `sudo systemctl stop ${SERVICE_NAME}; sudo systemctl start ${SERVICE_NAME}`; 

    try {
      await execAsync(cmd);
      log.info("Dnsmasq restart successful");
    } catch (err) {
      log.error("DNSMASQ:START:Error", "Failed to restart dnsmasq:", err);
    }
  }

  async start(skipIptablesUpdate) {
    // 0. update resolv.conf
    // 1. update filter (by default only update filter once per configured interval, unless force is true)
    // 2. start dnsmasq service
    // 3. update iptables rule
    log.info("Starting DNSMASQ...");

    this.shouldStart = false

    await this.updateResolvConf();
    // no need to stop dnsmasq, this.rawStart() will restart dnsmasq. Otherwise, there is a cooldown before restart, causing dns outage during that cool down window.
    try {
      await this.rawStart();
    } catch (err) {
      log.error('Error when raw start dnsmasq', err);
      await this.rawStop();
      log.error("Dnsmasq start is aborted due to failed to raw start");
      return;
    }

    if (!skipIptablesUpdate) {
      try {
        await this._remove_all_iptables_rules();
        await this._add_all_iptables_rules();
      } catch (err) {
        log.error('Error when add iptables rules', err);
        await this.rawStop();
        await this._remove_all_iptables_rules();
        log.error("Dnsmasq start is aborted due to failed to add iptables rules");
        return;
      }
    }

    log.info("DNSMASQ is started successfully");
    this.shouldStart = true;
  }

  async stop() {
    // 1. remove iptables rules
    // 2. stop service
    // optional to remove filter file
    this.shouldStart = false;

    log.info("Stopping DNSMASQ:");
    await this._remove_all_iptables_rules();
    await this.rawStop();
  }

  async restart() {
    try {
      await execAsync("sudo systemctl restart firemasq");
    } catch (err) {
      log.error("DNSMASQ:RESTART:Error", "Failed to restart dnsmasq: " + err);
    }
  }

  async applyMode(mode) {
    if (this.mode === mode) {
      log.info("Mode is not changed: " + mode);
      return;
    }
    log.info(`Mode is changed from ${this.mode} to ${mode}`);
    this.mode = mode;
    try {
      await this.start(true); // restart firemasq service, no need to update iptables
    } catch (err) {
      log.error("Failed to restart dnsmasq while enabling " + mode, err);
    }
  }

  // set mode but not apply it, this is invoked before dnsmasq is started
  async setMode(mode) {
    this.mode = mode;
  }

  async verifyDNSConnectivity() {
    for (let i in VERIFICATION_DOMAINS) {
      const domain = VERIFICATION_DOMAINS[i];
      const STATUS_CHECK_INTERFACE = platform.isFireRouterManaged() && sysManager.getMonitoringInterfaces().length > 0 ?
          sysManager.getMonitoringInterfaces()[0].ip_address :
          'localhost';
      let cmd = `dig -4 +short +time=5 -p ${MASQ_PORT} @${STATUS_CHECK_INTERFACE} ${domain}`;
      log.debug(`Verifying DNS connectivity via ${domain}...`)

      try {
        let { stdout, stderr } = await execAsync(cmd);
        if (stderr !== "" || stdout === "") {
          let error = new Error(`Error verifying dns connectivity to ${domain}`);
          Object.assign(error, { stdout, stderr });
          throw error;
        } else {
          log.debug("DNS connectivity looks good")
          return true
        }
      } catch (err) {
        log.error(`Got error when verifying dns connectivity to ${domain}:`, err.stdout, err.stderr);
      }
    }

    log.error("DNS connectivity check fails to resolve all domains.");
    return false;
  }

  async statusCheck() {
    log.debug("Keep-alive checking dnsmasq status")
    let checkResult = await this.verifyDNSConnectivity() ||
      await this.verifyDNSConnectivity() ||
      await this.verifyDNSConnectivity() ||
      await this.verifyDNSConnectivity();

    if (checkResult) {
      this.failCount = 0 // reset
      return;
    }

    this.failCount++
    log.warn(`DNS status check has failed ${this.failCount} times`);

    if (this.failCount > 8) {
      if (!f.isProductionOrBeta()) {
        pclient.publishAsync("DNS:DOWN", this.failCount);
      }
      if (this.mode === Mode.MODE_DHCP || this.mode === Mode.MODE_DHCP_SPOOF) {
        // dnsmasq is needed for dhcp service, still need to erase dns related rules in iptables
        log.warn("Dnsmasq keeps running under DHCP mode, remove all dns related rules from iptables...");
        await this._remove_all_iptables_rules();
      } else {
        await this.stop(); // make sure iptables rules are also stopped..
      }
      bone.logAsync("error", {
        type: 'DNSMASQ CRASH',
        msg: `dnsmasq failed to restart after ${this.failCount} retries`,
      });
    } else {
      try {
        let { stdout, stderr } = await execAsync("ps aux | grep dns[m]asq");
        log.info("dnsmasq running status: \n", stdout, stderr)
      } catch (e) {
        log.error("Failed to query process list of dnsmasq", e)
      }

      // restart this service, something is wrong
      try {
        await this.rawRestart();
      } catch (err) {
        log.error("Failed to restart dnsmasq:", err);
      }
    }
  }

  async cleanUpLeftoverConfig() {
    try {
      await fs.mkdirAsync(FILTER_DIR, { recursive: true, mode: 0o755 }).catch((err) => {
        if (err.code !== "EEXIST")
          log.error(`Failed to create ${FILTER_DIR}`, err);
      });
      const dirs = [FILTER_DIR, LEGACY_FILTER_DIR];

      const cleanDir = (async (dir) => {
        const dirExists = await fs.accessAsync(dir, fs.constants.F_OK).then(() => true).catch(() => false);
        if (!dirExists)
          return;

        const files = await fs.readdirAsync(dir);
        await Promise.all(files.map(async (filename) => {
          const filePath = `${dir}/${filename}`;

          try {
            const fileStat = await fs.statAsync(filePath);
            if (fileStat.isFile()) {
              await fs.unlinkAsync(filePath).catch((err) => {
                log.error(`Failed to remove ${filePath}, err:`, err);
              });
            }
            if (fileStat.isDirectory()) {
              await cleanDir(filePath);
            }
          } catch (err) {
            log.info(`File ${filePath} not exist`);
          }
        }));
      });

      for (let dir of dirs) {
        await cleanDir(dir);
      }
    } catch (err) {
      log.error("Failed to clean up leftover config", err);
    }
  }

  //save data in redis
  //{mac:{ipv4Addr:ipv4Addr,name:name}}
  //host: { ipv4Addr: '192.168.218.160',mac: 'F8:A2:D6:F1:16:53',name: 'LAPTOP-Lenovo' }
  async setupLocalDeviceDomain(macArr, isInit) {
    if (!fc.isFeatureOn('local_domain')) {
      return;
    }
    if (this.updatingLocalDomain) {
      const cooldown = 3 * 1000;
      return setTimeout(() => {
        this.setupLocalDeviceDomain(macArr, isInit)
      }, cooldown)
    }
    this.updatingLocalDomain = true;
    const json = await rclient.getAsync(LOCAL_DOMAIN_KEY);
    try {
      let needUpdate = false;
      let deviceDomainMap = JSON.parse(json) || {};
      for (const mac of macArr) {
        const key = hostTool.getMacKey(mac);
        const localDomain = await rclient.hgetAsync(key, "localDomain");
        const userLocalDomain = await rclient.hgetAsync(key, "userLocalDomain");
        const ipv4Addr = await rclient.hgetAsync(key, "ipv4Addr");
        if (!deviceDomainMap[mac]) {
          deviceDomainMap[mac] = {
            mac: mac,
            ipv4Addr: ipv4Addr,
            localDomain: localDomain,
            userLocalDomain: userLocalDomain
          }
          // new device found
          needUpdate = true;
        } else {
          let deviceDomain = deviceDomainMap[mac];
          if (deviceDomain.localDomain != localDomain || deviceDomain.userLocalDomain != userLocalDomain) {
            if (deviceDomain.userLocalDomain) {
              //If userLocalDomain is specified,only update when userLocalDomain changed
              needUpdate = (deviceDomain.userLocalDomain != userLocalDomain);
            } else {
              //If userLocalDomain is not specified, update when preferredName is changed
              needUpdate = (deviceDomain.localDomain != localDomain);
            }
            needUpdate = (deviceDomain.ipv4Addr != ipv4Addr || needUpdate);
            deviceDomain.mac = mac;
            deviceDomain.ipv4Addr = ipv4Addr;
            deviceDomain.userLocalDomain = userLocalDomain;
            deviceDomain.localDomain = localDomain;
          }
        }
      }
      await rclient.setAsync(LOCAL_DOMAIN_KEY, JSON.stringify(deviceDomainMap));
      let localDeviceDomain = "";
      for (const key in deviceDomainMap) {
        const deviceDomain = deviceDomainMap[key];
        let { localDomain, userLocalDomain } = deviceDomain;
        if (deviceDomain.ipv4Addr && validator.isIP(deviceDomain.ipv4Addr)) {
          localDomain && (localDeviceDomain += `address=/${localDomain}/${deviceDomain.ipv4Addr}\n`);
          userLocalDomain && (localDeviceDomain += `address=/${userLocalDomain}/${deviceDomain.ipv4Addr}\n`);
        }
      }
      (isInit || needUpdate) && this.throttleUpdatingConf(LOCAL_DOMAIN_FILE, localDeviceDomain);
    } catch (e) {
      log.error("Failed to setup local device domain", e);
    }
    this.updatingLocalDomain = false;
  }
  async throttleUpdatingConf(filePath, data) {
    const cooldown = 5 * 1000;
    if (this.throttleTimer[filePath]) {
      clearTimeout(this.throttleTimer[filePath])
    }
    this.throttleTimer[filePath] = setTimeout(async () => {
      log.info(`Going to update ${filePath}`)
      await fs.writeFileAsync(filePath, data);
      this.restartDnsmasq()
    }, cooldown)
  }
};
