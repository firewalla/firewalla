/*    Copyright 2019-2024 Firewalla Inc.
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
const log = require("../../net2/logger.js")(__filename);

const _ = require('lodash');
const util = require('util');
const net = require('net');
const f = require('../../net2/Firewalla.js');
const userID = f.getUserID();
const childProcess = require('child_process');
const execAsync = util.promisify(childProcess.exec);
const Promise = require('bluebird');
const redis = require('../../util/redis_manager.js').getRedisClient();
const fs = Promise.promisifyAll(require("fs"));
const fsp = require("fs").promises
const validator = require('validator');
const Mode = require('../../net2/Mode.js');
const rclient = require('../../util/redis_manager.js').getRedisClient();
const PlatformLoader = require('../../platform/PlatformLoader.js')
const platform = PlatformLoader.getPlatform()
const DNSTool = require('../../net2/DNSTool.js')
const dnsTool = new DNSTool()
const Message = require('../../net2/Message.js');

const { Rule } = require('../../net2/Iptables.js');
const ipset = require('../../net2/Ipset.js');

const FILTER_DIR = f.getUserConfigFolder() + "/dnsmasq";
const LOCAL_FILTER_DIR = f.getUserConfigFolder() + "/dnsmasq_local";
const LEGACY_FILTER_DIR = f.getUserConfigFolder() + "/dns";
const systemLevelMac = "FF:FF:FF:FF:FF:FF";

const UPSTREAM_SERVER_FILE = FILTER_DIR + "/upstream_server.conf";
const { isHashDomain } = require('../../util/util.js');

const FILTER_FILE = {
  adblock: FILTER_DIR + "/adblock_filter.conf",
  adblockTmp: FILTER_DIR + "/adblock_filter.conf.tmp",

  family: FILTER_DIR + "/family_filter.conf",
  familyTmp: FILTER_DIR + "/family_filter.conf.tmp",

  policy: FILTER_DIR + "/policy_filter.conf"
}

const policyFilterFile = FILTER_DIR + "/policy_filter.conf";

const sclient = require('../../util/redis_manager.js').getSubscriptionClient();
const sem = require('../../sensor/SensorEventManager.js').getInstance();

const sysManager = require('../../net2/SysManager');

const Config = require('../../net2/config.js');
let fConfig = Config.getConfig();

const bone = require("../../lib/Bone.js");

const iptables = require('../../net2/Iptables');

const startScriptFile = __dirname + "/dnsmasq.sh";

const configFile = __dirname + "/dnsmasq.conf";
const { formulateHostname, isDomainValid } = require('../../util/util.js');

const resolvFile = f.getRuntimeInfoFolder() + "/dnsmasq.resolv.conf";

const interfaceDhcpRange = {};

let defaultNameServers = {};
let interfaceNameServers = {};
let upstreamDNS = null;

const FILTER_EXPIRE_TIME = 86400 * 1000;

const BLACK_HOLE_IP = "" // return NXDOMAIN for blocked domains
const BLUE_HOLE_IP = "198.51.100.100"

const DEFAULT_DNS_SERVER = (fConfig.dns && fConfig.dns.defaultDNSServer) || "8.8.8.8";
const FALLBACK_DNS_SERVERS = (fConfig.dns && fConfig.dns.fallbackDNSServers) || ["8.8.8.8", "1.1.1.1"];
const FALLBACK_DNS6_SERVERS = (fConfig.dns && fConfig.dns.fallbackDNS6Servers) || ["2001:4860:4860::8888"];
const VERIFICATION_DOMAINS = (fConfig.dns && fConfig.dns.verificationDomains) || ["firewalla.encipher.io"];
const VERIFICATION_WHILELIST_PATH = FILTER_DIR + "/verification_whitelist.conf";

const SERVICE_NAME = platform.getDNSServiceName();
const DHCP_SERVICE_NAME = platform.getDHCPServiceName();
const ROUTER_DHCP_PATH = f.getUserHome() + fConfig.firerouter.hiddenFolder + '/config/dhcp'
const DHCP_CONFIG_PATH = ROUTER_DHCP_PATH + '/conf'
const HOSTFILE_PATH = platform.isFireRouterManaged() ?
  ROUTER_DHCP_PATH + '/hosts2/' :
  f.getRuntimeInfoFolder() + "/dnsmasq-hosts-dir/";
const MASQ_PORT = platform.isFireRouterManaged() ? 53 : 8853;
const HOSTS_DIR = f.getRuntimeInfoFolder() + "/hosts";
const {Address4} = require('ip-address');

const flowUtil = require('../../net2/FlowUtil.js');
const Constants = require('../../net2/Constants.js');
const VirtWanGroup = require("../../net2/VirtWanGroup.js");
const VPNClient = require("../vpnclient/VPNClient.js");

const globalBlockKey = "redis_zset_match:global_block";
const globalBlockHighKey = "redis_zset_match:global_block_high";
const globalAllowKey = "redis_zset_match:global_allow";
const globalAllowHighKey = "redis_zset_match:global_allow_high";

const AsyncLock = require('../../vendor_lib/async-lock');
const lock = new AsyncLock();
const LOCK_OPS = "LOCK_DNSMASQ_OPS";
const LOCK_LEASE_FILE = "LOCK_DNSMASQ_LEASE";

const extractPid = /[^\/]*policy_([0-9]+)[^\/]*.conf$/


module.exports = class DNSMASQ {
  constructor() {
    if (instance == null) {
      instance = this;

      this.mode = null;
      this.minReloadTime = new Date() / 1000;
      this.deleteInProgress = false;
      this.updatingLocalDomain = false;
      this.throttleTimer = {};
      this.networkFailCountMap = {};
      this.reservedIPHost = {}
      this.lastHostsFileHash = {}
      this.writeHostsFileTask = {}

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
        writeHostsFile: {},
        restart: 0,
        restartDHCP: 0
      }
      this.dnsTag = {
        adblock: "$adblock"
      }
      sem.once('IPTABLES_READY', () => {
        if (f.isMain()) {
          setInterval(() => {
            this.dnsStatusCheck()
          }, 1000 * 60 * 1) // check status every minute

          process.on('exit', () => {
            this.stop();
          });

          sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, async () => {
            const started = await this.isDNSServiceActive();
            if (started) {
              log.info("sys:network:info is reloaded, schedule refreshing dnsmasq and DNS redirect rules ...");
              this.scheduleStart();
            }
          })

          sclient.on("message", (channel, message) => {
            switch (channel) {
              case "System:VPNSubnetChanged":
                (async () => {
                  const newVpnSubnet = message;
                  if (newVpnSubnet)
                    await this.updateVpnIptablesRules(newVpnSubnet, true);
                })();
                break;
              case Message.MSG_WG_SUBNET_CHANGED: {
                const newSubnet = message;
                if (newSubnet)
                  this.updateWGIptablesRules(newSubnet, true);
                break;
              }
              default:
              //log.warn("Unknown message channel: ", channel, message);
            }
          });

          sclient.subscribe("System:VPNSubnetChanged");
          sclient.subscribe(Message.MSG_WG_SUBNET_CHANGED);
        }
      })
    }

    return instance;
  }

  scheduleStart() {
    if (this.startTask)
      clearTimeout(this.startTask);
    this.startTask = setTimeout(() => {
      // raw restart dnsmasq to refresh all confs and iptables
      this.start(false).catch((err) => {
        log.error("Failed to start dnsmasq", err.message);
      });
    }, 5000);
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

  _scheduleWriteHostsFile(host) {
    const hID = host.getGUID()
    log.verbose('Schedule write hosts file', hID)
    if (this.writeHostsFileTask[hID])
      clearTimeout(this.writeHostsFileTask[hID]);
    this.writeHostsFileTask[hID] = setTimeout(async () => {
      await this.writeHostsFile(host).catch(err => {
        log.error("Failed to write hosts file", err.message);
      });
    }, 5000);
  }

  scheduleRestartDNSService(ignoreFileCheck = false) {
    if (this.restartDNSTask)
      clearTimeout(this.restartDNSTask);
    this.restartDNSIgnoreFileCheck = this.restartDNSIgnoreFileCheck || ignoreFileCheck
    this.restartDNSTask = setTimeout(async () => {
      if (!this.restartDNSIgnoreFileCheck) {
        const confChanged = await this.checkConfsChange();
        if (!confChanged)
          return;
      }
      delete this.restartDNSIgnoreFileCheck
      await execAsync(`sudo systemctl stop ${SERVICE_NAME}`).catch((err) => { });
      this.counter.restart++;
      log.info(`Restarting ${SERVICE_NAME}`, this.counter.restart);
      const cmd = `sudo systemctl restart ${SERVICE_NAME}`;
      await execAsync(cmd).then(() => {
        log.verbose(`${SERVICE_NAME} has been restarted`, this.counter.restart);
      }).catch((err) => {
        log.error(`Failed to restart ${SERVICE_NAME} service`, err.message);
      });
    }, 5000);
  }

  scheduleReloadDNSService() {
    if (this.reloadDNSTask)
      clearTimeout(this.reloadDNSTask);
    this.reloadDNSTask = setTimeout(async () => {
      const confChanged = await this.checkConfsChange("dnsmasq:hosts", [`${HOSTS_DIR}/*`]);
      if (!confChanged)
        return;
      this.counter.reloadDnsmasq++;
      log.info(`Reloading ${SERVICE_NAME}`, this.counter.reloadDnsmasq);
      await execAsync(`sudo systemctl reload ${SERVICE_NAME}`).then(() => {
        log.verbose(`${SERVICE_NAME} has been reloaded`, this.counter.reloadDnsmasq);
      }).catch((err) => {
        log.error(`Failed to reload ${SERVICE_NAME} service`, err.message);
      });
    }, 5000);
  }

  scheduleRestartDHCPService(ignoreFileCheck = false) {
    if (this.restartDHCPTask)
      clearTimeout(this.restartDHCPTask);
    this.restartDHCPIgnoreFileCheck = this.restartDHCPIgnoreFileCheck || ignoreFileCheck
    this.restartDHCPTask = setTimeout(async () => {
      if (!this.restartDHCPIgnoreFileCheck) {
        const confChanged = await this.checkConfsChange('dnsmasq:dhcp', [startScriptFile, configFile, HOSTFILE_PATH, DHCP_CONFIG_PATH])
        if (!confChanged) {
          return;
        }
      }
      delete this.restartDHCPIgnoreFileCheck
      await execAsync(`sudo systemctl stop ${DHCP_SERVICE_NAME}`).catch((err) => { });
      this.counter.restartDHCP++;
      log.info(`Restarting ${DHCP_SERVICE_NAME}`, this.counter.restartDHCP);
      await execAsync(`sudo systemctl restart ${DHCP_SERVICE_NAME}`).then(() => {
        log.verbose(`${DHCP_SERVICE_NAME} has been restarted`, this.counter.restartDHCP);
      }).catch((err) => {
        log.error(`Failed to restart ${DHCP_SERVICE_NAME} service`, err.message);
      });
    }, 5000);
  }

  // in format 127.0.0.1#5353
  async setUpstreamDNS(dns) {
    if (dns === upstreamDNS) {
      log.info("upstream dns is not changed, ignored. (" + dns + ")");
      return;
    }

    log.info("upstream dns is set to", dns);
    upstreamDNS = dns;

    if (upstreamDNS) {
      log.info("upstream server", upstreamDNS, "is specified");
      // put upstream server config file to config directory
      const dnsmasqEntry = `server=${upstreamDNS}`;
      await fs.writeFileAsync(UPSTREAM_SERVER_FILE, dnsmasqEntry).catch((err) => {
        log.error(`Failed to write upstream server file`, dnsmasqEntry, err.message);
      });
    } else {
      log.info("unset upstream server");
      // remove upstream server config file from config directory anyway
      await fs.unlinkAsync(UPSTREAM_SERVER_FILE).catch((err) => { });
    }
    this.scheduleRestartDNSService();
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
    sysManager.myDefaultDns().forEach((dns) => {
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

    this.scheduleRestartDNSService();
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
  _getRuleGroupConfigPath(pid, uuid) {
    return `${FILTER_DIR}/rg_${uuid}_policy_${pid}.conf`;
  }

  _getRuleGroupPolicyTag(uuid) {
    return `rg_${uuid}`;
  }

  async cleanUpFilter(type) {
    const file = FILTER_FILE[type];
    log.info("Clean up filter file:", file);
    try {
      await fs.unlinkAsync(file);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // ignore
        log.verbose(`Filter file '${file}' not exist, ignore`);
      } else {
        log.error(`Failed to remove filter file: '${file}'`, err);
      }
    }
  }

  async addIpsetUpdateEntry(domains, ipsets, pid) {
    await lock.acquire(LOCK_OPS, async () => {
      domains = _.uniq(domains.map(d => d === "" ? "" : formulateHostname(d)).filter(d => d === "" || Boolean(d)).filter(d => d === "" || isDomainValid(d)));
      const entries = [];
      for (const domain of domains) {
        entries.push(`ipset=/${domain}/${ipsets.join(',')}`);
      }
      const filePath = `${FILTER_DIR}/policy_${pid}_ipset.conf`;
      await fs.writeFileAsync(filePath, entries.join('\n'));
    }).catch((err) => {
      log.error("Failed to add ipset update entry into config", err);
    });
  }

  async removeIpsetUpdateEntry(pid) {
    await lock.acquire(LOCK_OPS, async() => {
      const filePath = `${FILTER_DIR}/policy_${pid}_ipset.conf`;
      await fs.unlinkAsync(filePath);
    }).catch((err) => {
      log.error("Failed to remove ipset update entry from config", err);
    });
  }

  async addPolicyFilterEntry(domains, options) {
    return await lock.acquire(LOCK_OPS, async () => {
      log.debug("addPolicyFilterEntry", domains, options)
      options = options || {}
      if (options.action === "route") {
        if (!options.wanUUID)
          return;
        if (options.wanUUID.startsWith(Constants.ACL_VIRT_WAN_GROUP_PREFIX)) {
          const dnsMarkTag = VirtWanGroup.getDnsMarkTag(options.wanUUID.substring(Constants.ACL_VIRT_WAN_GROUP_PREFIX.length));
          const routeConfPath = `${VirtWanGroup.getDNSRouteConfDir(options.wanUUID.substring(Constants.ACL_VIRT_WAN_GROUP_PREFIX.length), options.routeType || "hard")}/policy_${options.pid}.conf`;
          await fs.writeFileAsync(routeConfPath, `tag-tag=$policy_${options.pid}$${dnsMarkTag}$!${Constants.DNS_DEFAULT_WAN_TAG}`).catch((err) => {});
        } else {
          if (options.wanUUID.startsWith(Constants.ACL_VPN_CLIENT_WAN_PREFIX)) {
            const dnsMarkTag = VPNClient.getDnsMarkTag(options.wanUUID.substring(Constants.ACL_VPN_CLIENT_WAN_PREFIX.length));
            const routeConfPath = `${VPNClient.getDNSRouteConfDir(options.wanUUID.substring(Constants.ACL_VPN_CLIENT_WAN_PREFIX.length), options.routeType || "hard")}/policy_${options.pid}.conf`;
            await fs.writeFileAsync(routeConfPath, `tag-tag=$policy_${options.pid}$${dnsMarkTag}$!${Constants.DNS_DEFAULT_WAN_TAG}`).catch((err) => {});
          } else {
            const NetworkProfile = require('../../net2/NetworkProfile.js');
            const dnsMarkTag = NetworkProfile.getDnsMarkTag(options.wanUUID);
            const routeConfPath = `${NetworkProfile.getDNSRouteConfDir(options.wanUUID, options.routeType || "hard")}/policy_${options.pid}.conf`;
            const NetworkProfileManager = require('../../net2/NetworkProfileManager.js');
            const profile = NetworkProfileManager.getNetworkProfile(options.wanUUID);
            await fs.writeFileAsync(routeConfPath, `tag-tag=$policy_${options.pid}$${dnsMarkTag}$${profile && profile.isVPNInterface() ? `!${Constants.DNS_DEFAULT_WAN_TAG}` : Constants.DNS_DEFAULT_WAN_TAG}`).catch((err) => {});
          }
        }
      }
      // empty string matches all domains, usually being used by internet block/allow rule
      if (options.matchType === "re") {
        // do nothing
      } else {
        domains = domains.map(d => d === "" ? "" : formulateHostname(d)).filter(d => d === "" || Boolean(d)).filter(d => d === "" || isDomainValid(d)).filter((v, i, a) => a.indexOf(v) === i);
      }
      let directive;
      switch (options.action) {
        case "block":
          directive = (options.matchType === "re" ? "re-match" : "address");
          break;
        case "allow":
          directive = (options.matchType === "re" ? "re-match" : "server");
          break;
        case "resolve":
          directive = (options.matchType === "re" ? "re-match" : "server");
          break;
        case "address":
          // re-match does not support literal address
          directive = "address";
          break;
      }
      for (const domain of domains) {
        if (!_.isEmpty(options.scope) || !_.isEmpty(options.intfs) || !_.isEmpty(options.tags) || !_.isEmpty(options.guids) || !_.isEmpty(options.parentRgId)) {
          const commonEntries = [];
          switch (options.action) {
            case "block":
              commonEntries.push(`${directive}${options.seq === Constants.RULE_SEQ_HI ? "-high" : ""}=/${domain}/${BLACK_HOLE_IP}$policy_${options.pid}`);
              break;
            case "allow":
              commonEntries.push(`${directive}${options.seq === Constants.RULE_SEQ_HI ? "-high" : ""}=/${domain}/#$policy_${options.pid}`);
              break;
            case "resolve":
            case "address":
              // reuse "resolver" field to indicate either upstream server for resolve rule or literal address for address rule
              commonEntries.push(`${directive}${options.seq === Constants.RULE_SEQ_HI ? "-high" : ""}=/${domain}/${options.resolver}$policy_${options.pid}`);
              break;
            default:
          }
          if (!_.isEmpty(options.scope)) {
            // use single config file for all devices configuration
            const entries = [];
            for (const mac of options.scope) {
              if (options.action === "route") {
                if (_.isEmpty(domain))
                  entries.push(`mac-address-tag=%${mac}$policy_${options.pid}&${options.pid}`);
                else
                  entries.push(`mac-address-tag=/${domain}/%${mac}$policy_${options.pid}&${options.pid}`);
              } else {
                entries.push(`mac-address-tag=%${mac}$policy_${options.pid}&${options.pid}`);
              }
            }
            Array.prototype.push.apply(entries, commonEntries);
            const filePath = `${FILTER_DIR}/policy_${options.pid}.conf`;
            await fs.writeFileAsync(filePath, entries.join('\n'));
          }

          if (!_.isEmpty(options.intfs)) {
            const NetworkProfile = require('../../net2/NetworkProfile.js');
            // use separate config file for each network configuration
            for (const intf of options.intfs) {
              const entries = [];
              if (options.action === "route") {
                if (_.isEmpty(domain))
                  entries.push(`mac-address-tag=%00:00:00:00:00:00$policy_${options.pid}&${options.pid}`);
                else
                  entries.push(`mac-address-tag=/${domain}/%00:00:00:00:00:00$policy_${options.pid}&${options.pid}`);
              } else {
                entries.push(`mac-address-tag=%00:00:00:00:00:00$policy_${options.pid}&${options.pid}`);
              }
              Array.prototype.push.apply(entries, commonEntries);
              const filePath = `${NetworkProfile.getDnsmasqConfigDirectory(intf)}/policy_${options.pid}.conf`;
              await fs.writeFileAsync(filePath, entries.join('\n'));
            }
          }

          if (!_.isEmpty(options.tags)) {
            // use separate config file for each tag configuration
            for (const tag of options.tags) {
              const entries = [];
              if (options.action === "route") {
                if (_.isEmpty(domain))
                  entries.push(`group-tag=@${tag}$policy_${options.pid}`);
                else
                  entries.push(`group-tag=/${domain}/@${tag}$policy_${options.pid}`);
              } else {
                entries.push(`group-tag=@${tag}$policy_${options.pid}&${options.pid}`);
              }
              Array.prototype.push.apply(entries, commonEntries);
              const filePath = `${FILTER_DIR}/tag_${tag}_policy_${options.pid}.conf`;
              await fs.writeFileAsync(filePath, entries.join('\n'));
            }
          }

          if (!_.isEmpty(options.guids)) {
            const IdentityManager = require('../../net2/IdentityManager.js');
            for (const guid of options.guids) {
              const identityClass = IdentityManager.getIdentityClassByGUID(guid);
              if (identityClass) {
                const { ns, uid } = IdentityManager.getNSAndUID(guid);
                const filePath = `${FILTER_DIR}/${identityClass.getDnsmasqConfigFilenamePrefix(uid)}_${options.pid}.conf`;
                const entries = [];
                if (options.action === "route") {
                  if (_.isEmpty(domain))
                    entries.push(`group-tag=@${identityClass.getEnforcementDnsmasqGroupId(uid)}$policy_${options.pid}&${options.pid}`);
                  else
                    entries.push(`group-tag=/${domain}/@${identityClass.getEnforcementDnsmasqGroupId(uid)}$policy_${options.pid}&${options.pid}`);
                } else {
                  entries.push(`group-tag=@${identityClass.getEnforcementDnsmasqGroupId(uid)}$policy_${options.pid}&${options.pid}`);
                }
                Array.prototype.push.apply(entries, commonEntries);
                await fs.writeFileAsync(filePath, entries.join('\n'));
              }
            }
          }

          if (!_.isEmpty(options.parentRgId)) {
            const uuid = options.parentRgId;
            const entries = [];
            switch (options.action) {
              case "block":
                entries.push(`${directive}${options.seq === Constants.RULE_SEQ_HI ? "-high" : ""}=/${domain}/${BLACK_HOLE_IP}$${this._getRuleGroupPolicyTag(uuid)}`);
                break;
              case "allow":
                entries.push(`${directive}${options.seq === Constants.RULE_SEQ_HI ? "-high" : ""}=/${domain}/#$${this._getRuleGroupPolicyTag(uuid)}`);
                break;
              case "resolve":
              case "address":
                entries.push(`${directive}${options.seq === Constants.RULE_SEQ_HI ? "-high" : ""}=/${domain}/${options.resolver}$${this._getRuleGroupPolicyTag(uuid)}`);
                break;
              // TODO: support "route" for rules in rule group in dnsmasq
              default:
            }
            const filePath = this._getRuleGroupConfigPath(options.pid, uuid);
            await fs.writeFileAsync(filePath, entries.join('\n'));
          }
        } else {
          // global effective policy
          if (options.scheduling || !domain.includes(".") || options.resolver || options.matchType === "re" || options.action === "route") { // do not add no-dot domain to redis set, domains in redis set needs to have at least one dot to be matched against
            const entries = [];
            if (options.action === "route") {
              if (_.isEmpty(domain))
                entries.push(`mac-address-tag=%FF:FF:FF:FF:FF:FF$policy_${options.pid}&${options.pid}`);
              else
                entries.push(`mac-address-tag=/${domain}/%FF:FF:FF:FF:FF:FF$policy_${options.pid}&${options.pid}`);
            } else {
              entries.push(`mac-address-tag=%FF:FF:FF:FF:FF:FF$policy_${options.pid}&${options.pid}`);
            }
            switch (options.action) {
              case "block":
                entries.push(`${directive}${options.seq === Constants.RULE_SEQ_HI ? "-high" : ""}=/${domain}/${BLACK_HOLE_IP}$policy_${options.pid}`);
                break;
              case "allow":
                entries.push(`${directive}${options.seq === Constants.RULE_SEQ_HI ? "-high" : ""}=/${domain}/#$policy_${options.pid}`);
                break;
              case "resolve":
              case "address":
                entries.push(`${directive}${options.seq === Constants.RULE_SEQ_HI ? "-high" : ""}=/${domain}/${options.resolver}$policy_${options.pid}`);
                break;
              default:
            }
            const filePath = `${FILTER_DIR}/policy_${options.pid}.conf`;
            await fs.writeFileAsync(filePath, entries.join('\n'));
          } else { // a new way to block without restarting dnsmasq, only for non-scheduling
            await this.addGlobalPolicyFilterEntry(domain, options);
            return "skip_restart"; // tell function caller that no need to restart dnsmasq to take effect
          }
        }
      }
    }).catch((err) => {
      log.error("Failed to add policy filter entry into file:", err);
    });
  }

  _getRedisMatchKey(uid, hash = false) {
    return `redis_${hash ? "hash_" : ""}match:${uid}`;
  }

  async addPolicyCategoryFilterEntry(options) {
    await lock.acquire(LOCK_OPS, async () => {
      options = options || {};
      let name = options.name;
      if (!name) {
        name = `policy_${options.pid}`;
      }
      if (options.action === "route") {
        if (!options.wanUUID)
          return;
        if (options.wanUUID.startsWith(Constants.ACL_VIRT_WAN_GROUP_PREFIX)) {
          const dnsMarkTag = VirtWanGroup.getDnsMarkTag(options.wanUUID.substring(Constants.ACL_VIRT_WAN_GROUP_PREFIX.length));
          const routeConfPath = `${VirtWanGroup.getDNSRouteConfDir(options.wanUUID.substring(Constants.ACL_VIRT_WAN_GROUP_PREFIX.length), options.routeType || "hard")}/policy_${options.pid}.conf`;
          await fs.writeFileAsync(routeConfPath, `tag-tag=$policy_${options.pid}$${dnsMarkTag}$!${Constants.DNS_DEFAULT_WAN_TAG}`).catch((err) => {});
        } else {
          if (options.wanUUID.startsWith(Constants.ACL_VPN_CLIENT_WAN_PREFIX)) {
            const dnsMarkTag = VPNClient.getDnsMarkTag(options.wanUUID.substring(Constants.ACL_VPN_CLIENT_WAN_PREFIX.length));
            const routeConfPath = `${VPNClient.getDNSRouteConfDir(options.wanUUID.substring(Constants.ACL_VPN_CLIENT_WAN_PREFIX.length), options.routeType || "hard")}/policy_${options.pid}.conf`;
            await fs.writeFileAsync(routeConfPath, `tag-tag=$policy_${options.pid}$${dnsMarkTag}$!${Constants.DNS_DEFAULT_WAN_TAG}`).catch((err) => {});
          } else {
            const NetworkProfile = require('../../net2/NetworkProfile.js');
            const dnsMarkTag = NetworkProfile.getDnsMarkTag(options.wanUUID);
            const routeConfPath = `${NetworkProfile.getDNSRouteConfDir(options.wanUUID, options.routeType || "hard")}/policy_${options.pid}.conf`;
            const NetworkProfileManager = require('../../net2/NetworkProfileManager.js');
            const profile = NetworkProfileManager.getNetworkProfile(options.wanUUID);
            await fs.writeFileAsync(routeConfPath, `tag-tag=$policy_${options.pid}$${dnsMarkTag}$${profile && profile.isVPNInterface() ? `!${Constants.DNS_DEFAULT_WAN_TAG}` : Constants.DNS_DEFAULT_WAN_TAG}`).catch((err) => {});
          }
        }
      }
      if (!_.isEmpty(options.scope) || !_.isEmpty(options.intfs) || !_.isEmpty(options.tags) || !_.isEmpty(options.guids) || !_.isEmpty(options.parentRgId)) {
        if (options.scope && options.scope.length > 0) {
          // use single config for all devices configuration
          const entries = [];
          for (const category of options.categories) {
            for (const mac of options.scope) {
              switch (options.action) {
                case "block": {
                  entries.push(`mac-address-tag=%${mac}$${category}_block${options.seq === Constants.RULE_SEQ_HI ? "_high" : ""}&${options.pid}`);
                  break;
                }
                case "allow": {
                  entries.push(`mac-address-tag=%${mac}$${category}_allow${options.seq === Constants.RULE_SEQ_HI ? "_high" : ""}&${options.pid}`);
                  break;
                }
                case "route": {
                  entries.push(`mac-address-tag=/@${this._getRedisMatchKey(category, false)}/%${mac}$policy_${options.pid}&${options.pid}`);
                  break;
                }
              }
            }
          }
          const filePath = `${FILTER_DIR}/${name}.conf`;
          await this.writeFileAsync(filePath, entries.join('\n'), options && options.append);
        }

        if (!_.isEmpty(options.intfs)) {
          const NetworkProfile = require('../../net2/NetworkProfile.js');
          // use separate config file for each network configuration
          for (const intf of options.intfs) {
            const entries = [];
            for (const category of options.categories) {
              switch (options.action) {
                case "block": {
                  entries.push(`mac-address-tag=%00:00:00:00:00:00$${category}_block${options.seq === Constants.RULE_SEQ_HI ? "_high" : ""}&${options.pid}`);
                  break;
                }
                case "allow": {
                  entries.push(`mac-address-tag=%00:00:00:00:00:00$${category}_allow${options.seq === Constants.RULE_SEQ_HI ? "_high" : ""}&${options.pid}`);
                  break;
                }
                case "route": {
                  entries.push(`mac-address-tag=/@${this._getRedisMatchKey(category, false)}/%00:00:00:00:00:00$policy_${options.pid}&${options.pid}`);
                  break;
                }
              }  
            }
            const filePath = `${NetworkProfile.getDnsmasqConfigDirectory(intf)}/${name}.conf`;
            await this.writeFileAsync(filePath, entries.join('\n'), options && options.append);
          }
        }

        if (!_.isEmpty(options.tags)) {
          // use separate config file for each tag configuration
          for (const tag of options.tags) {
            const entries = [];
            for (const category of options.categories) {
              switch (options.action) {
                case "block": {
                  entries.push(`group-tag=@${tag}$${category}_block${options.seq === Constants.RULE_SEQ_HI ? "_high" : ""}&${options.pid}`);
                  break;
                }
                case "allow": {
                  entries.push(`group-tag=@${tag}$${category}_allow${options.seq === Constants.RULE_SEQ_HI ? "_high" : ""}&${options.pid}`);
                  break;
                }
                case "route": {
                  entries.push(`group-tag=/@${this._getRedisMatchKey(category, false)}/@${tag}$policy_${options.pid}&${options.pid}`);
                  break;
                }
              }
            }
            const filePath = `${FILTER_DIR}/tag_${tag}_${name}.conf`;
            await this.writeFileAsync(filePath, entries.join('\n'), options && options.append);
          }
        }

        if (!_.isEmpty(options.guids)) {
          const IdentityManager = require('../../net2/IdentityManager.js');
          for (const guid of options.guids) {
            const identityClass = IdentityManager.getIdentityClassByGUID(guid);
            if (identityClass) {
              const { ns, uid } = IdentityManager.getNSAndUID(guid);
              const filePath = `${FILTER_DIR}/${identityClass.getDnsmasqConfigFilenamePrefix(uid)}_${name}.conf`;
              const entries = [];
              for (const category of options.categories) {
                switch (options.action) {
                  case "block": {
                    entries.push(`group-tag=@${identityClass.getEnforcementDnsmasqGroupId(uid)}$${category}_block${options.seq === Constants.RULE_SEQ_HI ? "_high" : ""}&${options.pid}`);
                    break;
                  }
                  case "allow": {
                    entries.push(`group-tag=@${identityClass.getEnforcementDnsmasqGroupId(uid)}$${category}_allow${options.seq === Constants.RULE_SEQ_HI ? "_high" : ""}&${options.pid}`);
                    break;
                  }
                  case "route": {
                    entries.push(`group-tag=/@${this._getRedisMatchKey(category, false)}/@${identityClass.getEnforcementDnsmasqGroupId(uid)}$policy_${options.pid}&${options.pid}`);
                    break;
                  }
                }
              }
              await this.writeFileAsync(filePath, entries.join('\n'), options && options.append);
            }
          }
        }

        if (!_.isEmpty(options.parentRgId)) {
          const uuid = options.parentRgId;
          let path = this._getRuleGroupConfigPath(options.pid, uuid);
          const entries = [];
          for (const category of options.categories) {
            entries.push(`redis-match${options.seq === Constants.RULE_SEQ_HI ? "-high" : ""}=/${this._getRedisMatchKey(category, false)}/${options.action === "block" ? "" : "#"}$${this._getRuleGroupPolicyTag(uuid)}`);
            entries.push(`redis-hash-match${options.seq === Constants.RULE_SEQ_HI ? "-high" : ""}=/${this._getRedisMatchKey(category, true)}/${options.action === "block" ? "" : "#"}$${this._getRuleGroupPolicyTag(uuid)}`);
          }
          await fs.writeFileAsync(path, entries.join('\n'));
        }
      } else {
        // global effective policy
        const entries = [];
        for (const category of options.categories) {
          switch (options.action) {
            case "block": {
              entries.push(`mac-address-tag=%${systemLevelMac}$${category}_block${options.seq === Constants.RULE_SEQ_HI ? "_high" : ""}&${options.pid}`);
              break;
            }
            case "allow": {
              entries.push(`mac-address-tag=%${systemLevelMac}$${category}_allow${options.seq === Constants.RULE_SEQ_HI ? "_high" : ""}&${options.pid}`);
              break;
            }
            case "route": {
              entries.push(`mac-address-tag=/@${this._getRedisMatchKey(category, false)}/%${systemLevelMac}$policy_${options.pid}&${options.pid}`);
              break;
            }
          }
        }
        const filePath = `${FILTER_DIR}/${name}.conf`;
        await this.writeFileAsync(filePath, entries.join('\n'), options && options.append);
      }
    }).catch((err) => {
      log.error("Failed to add category mac set entry into file:", err);
    });
  }

  async writeFileAsync(filePath, content, append=false) {
    if (append) {
      return await fs.appendFileAsync(filePath, "\n" + content);
    }
    return await fs.writeFileAsync(filePath, content);
  }

  async writeAllocationOption(tagName, policy, known = false) {
    let restartNeeded = false;
    await lock.acquire(LOCK_OPS, async () => {
      log.verbose('Writting allocation file for tag', tagName)
      const filePath = `${DHCP_CONFIG_PATH}/${tagName}_ignore.conf`;
      if (policy.dhcpIgnore) {
        const tags = []
        if (tagName) tags.push(tagName)
        if (!known) tags.push('!known')
        if (tags.length) {
          const entry = `dhcp-ignore=${tags.map(t=>'tag:'+t).join(',')}`
          await fsp.writeFile(filePath, entry)
          restartNeeded = true;
        }
      } else {
        try {
          await fsp.unlink(filePath)
          restartNeeded = true;
        } catch(err) {
          // file not exist, ignore
          if (err.code == 'ENOENT') return
          else throw err
        }
      }
    }).catch(err => {
      log.error("Failed to write allocation file:", err);
    });
    if (restartNeeded)
      this.scheduleRestartDHCPService();
  }

  getGlobalRedisMatchKey(options) {
    if (options.action === 'block') {
      return options.seq === Constants.RULE_SEQ_HI ? globalBlockHighKey : globalBlockKey;
    } else {
      return options.seq === Constants.RULE_SEQ_HI ? globalAllowHighKey : globalAllowKey;
    }
  }
  // only for dns block/allow for global scope
  async addGlobalPolicyFilterEntry(domain, options) {
    const redisKey = this.getGlobalRedisMatchKey(options);
    await rclient.zaddAsync(redisKey, options.pid, !options.exactMatch && !domain.startsWith("*.") ? `*.${domain}` : domain);
  }

  // only for dns block/allow for global scope
  async removeGlobalPolicyFilterEntry(domains, options) {
    const redisKey = this.getGlobalRedisMatchKey(options);
    domains = domains.map(domain => !options.exactMatch && !domain.startsWith("*.") ? `*.${domain}` : domain);
    await rclient.zremAsync(redisKey, domains);
  }

  async removePolicyCategoryFilterEntry(options) {
    await lock.acquire(LOCK_OPS, async () => {
      options = options || {};
      if (options.action === "route") {
        if (!options.wanUUID)
          return;
        if (options.wanUUID.startsWith(Constants.ACL_VIRT_WAN_GROUP_PREFIX)) {
          const routeConfPath = `${VirtWanGroup.getDNSRouteConfDir(options.wanUUID.substring(Constants.ACL_VIRT_WAN_GROUP_PREFIX.length), options.routeType || "hard")}/policy_${options.pid}.conf`;
          await fs.unlinkAsync(routeConfPath).catch((err) => {});
        } else {
          if (options.wanUUID.startsWith(Constants.ACL_VPN_CLIENT_WAN_PREFIX)) {
            const routeConfPath = `${VPNClient.getDNSRouteConfDir(options.wanUUID.substring(Constants.ACL_VPN_CLIENT_WAN_PREFIX.length), options.routeType || "hard")}/policy_${options.pid}.conf`;
            await fs.unlinkAsync(routeConfPath).catch((err) => {});
          } else {
            const NetworkProfile = require('../../net2/NetworkProfile.js');
            const routeConfPath = `${NetworkProfile.getDNSRouteConfDir(options.wanUUID, options.routeType || "hard")}/policy_${options.pid}.conf`;
            await fs.unlinkAsync(routeConfPath).catch((err) => {});
          }
        }
      }
      let name = options.name;
      if (!name) {
        name = `policy_${options.pid}`;
      }
      if (!_.isEmpty(options.scope) || !_.isEmpty(options.intfs) || !_.isEmpty(options.tags) || !_.isEmpty(options.guids) || !_.isEmpty(options.parentRgId)) {
        if (options.scope && options.scope.length > 0) {
          const filePath = `${FILTER_DIR}/${name}.conf`;
          await fs.unlinkAsync(filePath).catch((err) => {
            if (options.muteError) {
              return;
            }
            log.error(`Failed to remove policy config file for ${options.pid}`, err.message);
          });
        }

        if (!_.isEmpty(options.intfs)) {
          const NetworkProfile = require('../../net2/NetworkProfile.js');
          for (const intf of options.intfs) {
            const filePath = `${NetworkProfile.getDnsmasqConfigDirectory(intf)}/${name}.conf`;
            await fs.unlinkAsync(filePath).catch((err) => {
              if (options.muteError) {
                return;
              }
              log.error(`Failed to remove policy config file for ${options.pid}`, err.message);
            });
          }
        }

        if (!_.isEmpty(options.tags)) {
          for (const tag of options.tags) {
            const filePath = `${FILTER_DIR}/tag_${tag}_${name}.conf`;
            await fs.unlinkAsync(filePath).catch((err) => {
              if (options.muteError) {
                return;
              }
              log.error(`Failed to remove policy config file for ${options.pid}`, err.message);
            });
          }
        }

        if (!_.isEmpty(options.guids)) {
          const IdentityManager = require('../../net2/IdentityManager.js');
          for (const guid of options.guids) {
            const identityClass = IdentityManager.getIdentityClassByGUID(guid);
            if (identityClass) {
              const { ns, uid } = IdentityManager.getNSAndUID(guid);
              const filePath = `${FILTER_DIR}/${identityClass.getDnsmasqConfigFilenamePrefix(uid)}_${name}.conf`;
              await fs.unlinkAsync(filePath).catch((err) => {
                if (options.muteError) {
                  return;
                }
                log.error(`Failed to remove policy config file for ${options.pid}`, err.message);
              });
            }
          }
        }

        if (!_.isEmpty(options.parentRgId)) {
          const uuid = options.parentRgId;
          let path = this._getRuleGroupConfigPath(options.pid, uuid);
          await fs.unlinkAsync(path).catch((err) => {
            if (options.muteError) {
              return;
            }
            log.error(`Failed to remove policy config file for ${options.pid} and gid ${uuid}`, err.message);
          });
        }
      } else {
        const filePath = `${FILTER_DIR}/${name}.conf`;
        await fs.unlinkAsync(filePath).catch((err) => {
          if (options.muteError) {
            return;
          }
          log.error(`Failed to remove policy config file for ${options.pid}`, err.message);
        });
      }
    }).catch((err) => {
      log.error("Failed to remove policy config file:", err);
    });
  }

  async createGlobalRedisMatchRule() {
    const globalConf = `${FILTER_DIR}/global.conf`;
    await fs.writeFileAsync(globalConf, [
      "mac-address-tag=%FF:FF:FF:FF:FF:FF$global_acl&-1",
      "mac-address-tag=%FF:FF:FF:FF:FF:FF$global_acl_high&-1",
      `redis-zset-match=/${globalBlockKey}/${BLACK_HOLE_IP}$global_acl`,
      `redis-zset-match-high=/${globalBlockHighKey}/${BLACK_HOLE_IP}$global_acl_high`,
      `redis-zset-match=/${globalAllowKey}/#$global_acl`,
      `redis-zset-match-high=/${globalAllowHighKey}/#$global_acl_high`
    ].join("\n"));
    await rclient.unlinkAsync(globalBlockKey);
    await rclient.unlinkAsync(globalBlockHighKey);
    await rclient.unlinkAsync(globalAllowKey);
    await rclient.unlinkAsync(globalAllowHighKey);
  }

  async createCategoryFilterMappingFile(category, meta) {
    const blackhole = "127.0.0.153#59953";
    const categoryBlockDomainsFile = FILTER_DIR + `/${category}_block.conf`;
    const categoryAllowDomainsFile = FILTER_DIR + `/${category}_allow.conf`;
    await fs.writeFileAsync(categoryBlockDomainsFile, [
      `server-bf=</home/pi/.firewalla/run/category_data/filters/${category}.data,${meta.size},${meta.error}><empty><category:${category}:hit:domain><category:${category}:passthrough:domain>${blackhole}$${category}_block`,
      `server-bf-high=</home/pi/.firewalla/run/category_data/filters/${category}.data,${meta.size},${meta.error}><empty><category:${category}:hit:domain><category:${category}:passthrough:domain>${blackhole}$${category}_block_high`,
      `redis-hash-match=/${this._getRedisMatchKey(category, true)}/$${category}_block`,
      `redis-hash-match-high=/${this._getRedisMatchKey(category, true)}/$${category}_block_high`
    ].join('\n'));
    await fs.writeFileAsync(categoryAllowDomainsFile, [
      `server-bf=</home/pi/.firewalla/run/category_data/filters/${category}.data,${meta.size},${meta.error}><category:${category}:hit:domain><empty><category:${category}:passthrough:domain>#$${category}_allow`,
      `server-bf-high=</home/pi/.firewalla/run/category_data/filters/${category}.data,${meta.size},${meta.error}><category:${category}:hit:domain><empty><category:${category}:passthrough:domain>#$${category}_allow_high`,
      `redis-hash-match=/${this._getRedisMatchKey(category, true)}/#$${category}_allow`,
      `redis-hash-match-high=/${this._getRedisMatchKey(category, true)}/#$${category}_allow_high`
    ].join('\n'));
  }

  async createCategoryMappingFile(category, ipsets) {
    const categoryBlockDomainsFile = FILTER_DIR + `/${category}_block.conf`;
    const categoryAllowDomainsFile = FILTER_DIR + `/${category}_allow.conf`;
    await fs.writeFileAsync(categoryBlockDomainsFile, [
      `redis-match=/${this._getRedisMatchKey(category, false)}/$${category}_block`,
      `redis-hash-match=/${this._getRedisMatchKey(category, true)}/$${category}_block`,
      `redis-match-high=/${this._getRedisMatchKey(category, false)}/$${category}_block_high`,
      `redis-hash-match-high=/${this._getRedisMatchKey(category, true)}/$${category}_block_high`,
      `redis-ipset=/${this._getRedisMatchKey(category, false)}/${ipsets.join(',')}` // no need to duplicate redis-ipset config in block config file, both use the same ipset and redis set
    ].join('\n'));
    await fs.writeFileAsync(categoryAllowDomainsFile, [
      `redis-match=/${this._getRedisMatchKey(category, false)}/#$${category}_allow`,
      `redis-hash-match=/${this._getRedisMatchKey(category, true)}/#$${category}_allow`,
      `redis-match-high=/${this._getRedisMatchKey(category, false)}/#$${category}_allow_high`,
      `redis-hash-match-high=/${this._getRedisMatchKey(category, true)}/#$${category}_allow_high`
    ].join('\n'));
  }

  async deletePolicyCategoryFilterEntry(category) {
    const categoryBlockDomainsFile = FILTER_DIR + `/${category}_block.conf`;
    const categoryAllowDomainsFile = FILTER_DIR + `/${category}_allow.conf`;
    await lock.acquire(LOCK_OPS, async () => {
      await rclient.unlinkAsync(this._getRedisMatchKey(category, false));
      await rclient.unlinkAsync(this._getRedisMatchKey(category, true));
      await fs.unlinkAsync(categoryBlockDomainsFile);
      await fs.unlinkAsync(categoryAllowDomainsFile);
    }).catch((err) => {
      log.warn('failed to delete category filter entry', category, err);
    });
  }

  async flushCategoryFilters() {
    await lock.acquire(LOCK_OPS, async () => {
      const redisKeys = (await rclient.scanResults('redis_*match:*')).filter(k => !k.startsWith('redis_match:global_'))
      log.debug('Flushing category redis keys:', JSON.stringify(redisKeys))
      redisKeys.length && await rclient.unlinkAsync(redisKeys);

      const dir = await fsp.opendir(FILTER_DIR);
      for await (const dirent of dir) {
        if (dirent.name.match(/^[^\/]*_(block|allow)\.conf$/)) {
          log.debug('Removing category conf file: ', dirent.name)
          await fsp.unlink(FILTER_DIR + '/' + dirent.name);
        }
      }
    }).catch((err) => {
      log.warn('failed to flush category filter entries', err);
    });
  }

  async updatePolicyCategoryFilterEntry(domains, options) {
    await lock.acquire(LOCK_OPS, async () => {
      log.debug("updatePolicyCategoryFilterEntry", domains, options);
      options = options || {};
      const category = options.category;
      const hashDomains = domains.filter(d => isHashDomain(d));
      domains = _.uniq(domains.filter(d => !isHashDomain(d)).map(d => formulateHostname(d, false)).filter(Boolean).filter(d => isDomainValid(d.startsWith("*.") ? d.substring(2) : d))).sort();
      await rclient.unlinkAsync(this._getRedisMatchKey(category, false));
      if (domains.length > 0)
        await rclient.saddAsync(this._getRedisMatchKey(category, false), domains);
      if (hashDomains.length > 0)
        await rclient.saddAsync(this._getRedisMatchKey(category, true), hashDomains);
    }).catch((err) => {
      log.error("Failed to update category entry into file:", err);
    });
  }

  async removePolicyFilterEntry(domains, options) {
    return await lock.acquire(LOCK_OPS, async () => {
      options = options || {}
      if (options.action === "route") {
        if (!options.wanUUID)
          return;
        if (options.wanUUID.startsWith(Constants.ACL_VIRT_WAN_GROUP_PREFIX)) {
          const routeConfPath = `${VirtWanGroup.getDNSRouteConfDir(options.wanUUID.substring(Constants.ACL_VIRT_WAN_GROUP_PREFIX.length), options.routeType || "hard")}/policy_${options.pid}.conf`;
          await fs.unlinkAsync(routeConfPath).catch((err) => {});
        } else {
          if (options.wanUUID.startsWith(Constants.ACL_VPN_CLIENT_WAN_PREFIX)) {
            const routeConfPath = `${VPNClient.getDNSRouteConfDir(options.wanUUID.substring(Constants.ACL_VPN_CLIENT_WAN_PREFIX.length), options.routeType || "hard")}/policy_${options.pid}.conf`;
            await fs.unlinkAsync(routeConfPath).catch((err) => {});
          } else {
            const NetworkProfile = require('../../net2/NetworkProfile.js');
            const routeConfPath = `${NetworkProfile.getDNSRouteConfDir(options.wanUUID, options.routeType || "hard")}/policy_${options.pid}.conf`;
            await fs.unlinkAsync(routeConfPath).catch((err) => {});
          }
        }
      }
      if (!_.isEmpty(options.scope) || !_.isEmpty(options.intfs) || !_.isEmpty(options.tags) || !_.isEmpty(options.guids) || !_.isEmpty(options.parentRgId)) {
        if (!_.isEmpty(options.scope)) {
          const filePath = `${FILTER_DIR}/policy_${options.pid}.conf`;
          await fs.unlinkAsync(filePath).catch((err) => {
            log.error(`Failed to remove policy config file for ${options.pid}`, err.message);
          });
        }

        if (!_.isEmpty(options.intfs)) {
          const NetworkProfile = require('../../net2/NetworkProfile.js');
          for (const intf of options.intfs) {
            const filePath = `${NetworkProfile.getDnsmasqConfigDirectory(intf)}/policy_${options.pid}.conf`;
            await fs.unlinkAsync(filePath).catch((err) => {
              log.error(`Failed to remove policy config file for ${options.pid}`, err.message);
            });
          }
        }

        if (!_.isEmpty(options.tags)) {
          for (const tag of options.tags) {
            const filePath = `${FILTER_DIR}/tag_${tag}_policy_${options.pid}.conf`;
            await fs.unlinkAsync(filePath).catch((err) => {
              log.error(`Failed to remove policy config file for ${options.pid}`, err.message);
            });
          }
        }

        if (!_.isEmpty(options.guids)) {
          const IdentityManager = require('../../net2/IdentityManager.js');
          for (const guid of options.guids) {
            const identityClass = IdentityManager.getIdentityClassByGUID(guid);
            if (identityClass) {
              const { ns, uid } = IdentityManager.getNSAndUID(guid);
              const filePath = `${FILTER_DIR}/${identityClass.getDnsmasqConfigFilenamePrefix(uid)}_${options.pid}.conf`;
              await fs.unlinkAsync(filePath).catch((err) => {
                log.error(`Failed to remove policy config file for ${options.pid}`, err.message);
              });
            }
          }
        }

        if (!_.isEmpty(options.parentRgId)) {
          const uuid = options.parentRgId;
          const filePath = this._getRuleGroupConfigPath(options.pid, uuid);
          await fs.unlinkAsync(filePath).catch((err) => {
            log.error(`Failed to remove policy config file for ${options.pid} gid ${uuid}`, err.message);
          });
        }
      } else {
        if (options.scheduling || !domains.some(d => d.includes(".")) || options.resolver || options.matchType === "re" || options.action === "route") {
          const filePath = `${FILTER_DIR}/policy_${options.pid}.conf`;
          await fs.unlinkAsync(filePath).catch((err) => {
            log.error(`Failed to remove policy config file for ${options.pid}`, err.message);
          });
        } else {
          await this.removeGlobalPolicyFilterEntry(domains, options);
          return "skip_restart"; // tell function caller it's not necessary to restart dnsmasq
        }
      }
    }).catch((err) => {
      log.error("Failed to remove policy config file:", err);
    });
  }

  async flushPolicyFilters(pidArray) {
    if (!Array.isArray(pidArray) || !pidArray.length) return

    return lock.acquire(LOCK_OPS, async () => {
      const dir = await fsp.opendir(FILTER_DIR);
      for await (const dirEnt of dir) {
        if (dirEnt.isDirectory()) {
          const subDir = await fsp.opendir(FILTER_DIR + '/' + dirEnt.name);
          for await (const subEnt of subDir) {
            if (subEnt.isFile()) {
              const match = subEnt.name.match(extractPid)
              if (match && pidArray.includes(match[1])) {
                log.info(`Removing policy conf file: ${dirEnt.name}/${subEnt.name}`);
                await fsp.unlink(`${FILTER_DIR}/${dirEnt.name}/${subEnt.name}`);
              }
            }
          }
        } else if (dirEnt.isFile()) {
          log.verbose('checking', dirEnt.name)
          const match = dirEnt.name.match(extractPid)
          if (match && pidArray.includes(match[1])) {
            log.info(`Removing policy conf file: ${dirEnt.name}`);
            await fsp.unlink(`${FILTER_DIR}/${dirEnt.name}`);
          }
        }
      }
      this.scheduleReloadDNSService()
    })
  }

  async linkRuleToRuleGroup(options, uuid) {
    await lock.acquire(LOCK_OPS, async () => {
      options = options || {}
      if (!_.isEmpty(options.scope) || !_.isEmpty(options.intfs) || !_.isEmpty(options.tags) || !_.isEmpty(options.guids)) {
        if (!_.isEmpty(options.scope)) {
          const entries = [];
          for (const mac of options.scope) {
            entries.push(`mac-address-tag=%${mac}$${this._getRuleGroupPolicyTag(uuid)}&${options.pid}`);
          }
          const filePath = `${FILTER_DIR}/policy_${options.pid}.conf`;
          await fs.writeFileAsync(filePath, entries.join('\n'));
        }
        if (!_.isEmpty(options.intfs)) {
          const NetworkProfile = require('../../net2/NetworkProfile.js');
          for (const intf of options.intfs) {
            const entries = [`mac-address-tag=%00:00:00:00:00:00$${this._getRuleGroupPolicyTag(uuid)}&${options.pid}`];
            const filePath = `${NetworkProfile.getDnsmasqConfigDirectory(intf)}/policy_${options.pid}.conf`;
            await fs.writeFileAsync(filePath, entries.join('\n'));
          }
        }
        if (!_.isEmpty(options.tags)) {
          for (const tag of options.tags) {
            const entries = [`group-tag=@${tag}$${this._getRuleGroupPolicyTag(uuid)}&${options.pid}`];
            const filePath = `${FILTER_DIR}/tag_${tag}_policy_${options.pid}.conf`;
            await fs.writeFileAsync(filePath, entries.join('\n'));
          }
        }
        if (!_.isEmpty(options.guids)) {
          const IdentityManager = require('../../net2/IdentityManager.js');
          for (const guid of options.guids) {
            const identityClass = IdentityManager.getIdentityClassByGUID(guid);
            if (identityClass) {
              const { ns, uid } = IdentityManager.getNSAndUID(guid);
              const entries = [`group-tag=@${identityClass.getEnforcementDnsmasqGroupId(uid)}$${this._getRuleGroupPolicyTag(uuid)}&${options.pid}`];
              const filePath = `${FILTER_DIR}/${identityClass.getDnsmasqConfigFilenamePrefix(uid)}_${options.pid}.conf`;
              await fs.writeFileAsync(filePath, entries.join('\n'));
            }

          }
        }
      } else {
        const entries = [`mac-address-tag=%${systemLevelMac}$${this._getRuleGroupPolicyTag(uuid)}&${options.pid}`];
        const filePath = `${FILTER_DIR}/policy_${options.pid}.conf`;
        await fs.writeFileAsync(filePath, entries.join('\n'));
      }
    }).catch((err) => {
      log.error(`Failed to add rule group membership to ${uuid}`, options, err.message);
    });
  }

  async unlinkRuleFromRuleGroup(options, uuid) {
    await lock.acquire(LOCK_OPS, async () => {
      options = options || {}
      if (!_.isEmpty(options.scope) || !_.isEmpty(options.intfs) || !_.isEmpty(options.tags) || !_.isEmpty(options.guids)) {
        if (!_.isEmpty(options.scope)) {
          const filePath = `${FILTER_DIR}/policy_${options.pid}.conf`;
          await fs.unlinkAsync(filePath).catch((err) => { });
        }
        if (!_.isEmpty(options.intfs)) {
          const NetworkProfile = require('../../net2/NetworkProfile.js');
          for (const intf of options.intfs) {
            const filePath = `${NetworkProfile.getDnsmasqConfigDirectory(intf)}/policy_${options.pid}.conf`;
            await fs.unlinkAsync(filePath).catch((err) => { });
          }
        }
        if (!_.isEmpty(options.tags)) {
          for (const tag of options.tags) {
            const filePath = `${FILTER_DIR}/tag_${tag}_policy_${options.pid}.conf`;
            await fs.unlinkAsync(filePath).catch((err) => { });
          }
        }
        if (!_.isEmpty(options.guids)) {
          const IdentityManager = require('../../net2/IdentityManager.js');
          for (const guid of options.guids) {
            const identityClass = IdentityManager.getIdentityClassByGUID(guid);
            if (identityClass) {
              const { ns, uid } = IdentityManager.getNSAndUID(guid);
              const filePath = `${FILTER_DIR}/${identityClass.getDnsmasqConfigFilenamePrefix(uid)}_${options.pid}.conf`;
              await fs.unlinkAsync(filePath).catch((err) => { });
            }
          }
        }
      } else {
        const filePath = `${FILTER_DIR}/policy_${options.pid}.conf`;
        await fs.unlinkAsync(filePath).catch((err) => { });
      }
    }).catch((err) => {
      log.error(`Failed to remove rule group membership from ${uuid}`, options, err.message);
    });
  }

  // deprecated, this is only used in test cases
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

  async keepDomainsLocal(key, policy) {
    const entries = [];
    if (policy) {
      const domains = policy.domains;
      const blackhole = policy.blackhole;
      const filePath = `${FILTER_DIR}/${key}.conf`;
      for (const domain of domains) {
        entries.push(`server-high=/${domain}/${blackhole}`)
      }
      await fs.writeFileAsync(filePath, entries.join('\n'));
      this.scheduleRestartDNSService();
    }
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

  async _updateTmpFilter(type, force) {
    let mkdirp = util.promisify(require('mkdirp'));

    try {
      await mkdirp(FILTER_DIR);
      await mkdirp(LOCAL_FILTER_DIR);
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

  async updateWGIptablesRules(newSubnet, force) {
    const oldSubnet = this.wgSubnet;
    const dns = `127.0.0.1:${MASQ_PORT}`;
    const started = await this.isDNSServiceActive();
    if (!started)
      return;
    if (oldSubnet != newSubnet || force === true) {
      await iptables.dnsFlushAsync('wireguard');
    }
    if (newSubnet) {
      if (!platform.isFireRouterManaged())
        await iptables.dnsChangeAsync(newSubnet, dns, 'wireguard', true);
      this.wgSubnet = newSubnet;
    }
  }

  async updateVpnIptablesRules(newVpnSubnet, force) {
    const oldVpnSubnet = this.vpnSubnet;
    // TODO: to another dnsmasq instance
    const dns = `127.0.0.1:${MASQ_PORT}`;
    const started = await this.isDNSServiceActive();
    if (!started)
      return;
    if (oldVpnSubnet != newVpnSubnet || force === true) {
      // remove iptables rule for old vpn subnet
      await iptables.dnsFlushAsync('vpn');
    }
    // then add new iptables rule for new vpn subnet. If newVpnSubnet is null, no new rule is added
    if (newVpnSubnet) {
      // newVpnSubnet is null means to delete previous nat rule. The previous vpn subnet should be kept in case of dnsmasq reloading
      if (!platform.isFireRouterManaged())
        // vpn network is a monitoring interface on firerouter managed platform
        await iptables.dnsChangeAsync(newVpnSubnet, dns, 'vpn', true);
      this.vpnSubnet = newVpnSubnet;
    }
  }

  async _update_dns_fallback_rules() {
    await execAsync(`sudo iptables -w -t nat -F FW_PREROUTING_DNS_FALLBACK`).catch((err) => { });
    await execAsync(`sudo ip6tables -w -t nat -F FW_PREROUTING_DNS_FALLBACK`).catch((err) => { });
    const interfaces = sysManager.getMonitoringInterfaces();
    const NetworkProfile = require('../../net2/NetworkProfile.js');
    for (const intf of interfaces) {
      const uuid = intf.uuid;
      if (!uuid) {
        log.error(`uuid is not defined for ${intf.name}`);
        continue;
      }
      const resolver4 = sysManager.myResolver(intf.name);
      const resolver6 = sysManager.myResolver6(intf.name);
      const myIp4 = sysManager.myIp(intf.name);
      const myIp6 = sysManager.myIp6(intf.name);
      await NetworkProfile.ensureCreateEnforcementEnv(uuid);
      const netSet = NetworkProfile.getNetIpsetName(uuid);
      const netSet6 = NetworkProfile.getNetIpsetName(uuid, 6);
      if (myIp4 && resolver4 && resolver4.length > 0) {
        // redirect dns request that is originally sent to box itself to the upstream resolver
        for (const i in resolver4) {
          const redirectRule = new Rule('nat').chn('FW_PREROUTING_DNS_FALLBACK')
            .set(netSet, 'src,src').dst(myIp4).dport(53)
            .mdl("statistic", `--mode nth --every ${resolver4.length - i} --packet 0`)
            .jmp(`DNAT --to-destination ${resolver4[i]}:53`);
          await redirectRule.clone().pro('tcp').exec('-A');
          await redirectRule.clone().pro('udp').exec('-A');
        }
      }
      if (!_.isEmpty(myIp6) && resolver6 && resolver6.length > 0) {
        for (const i in resolver6) {
          const redirectRule = new Rule('nat').fam(6).chn('FW_PREROUTING_DNS_FALLBACK')
            .set(netSet6, 'src,src').dst(myIp6.join(",")).dport(53)
            .mdl("statistic", `--mode nth --every ${resolver6.length - i} --packet 0`)
            .jmp(`DNAT --to-destination [${resolver6[i].split('%')[0]}]:53`);
          await redirectRule.clone().pro('tcp').exec('-A');
          await redirectRule.clone().pro('udp').exec('-A');
        }
      }
    }
    for (const dns6_server of FALLBACK_DNS6_SERVERS) {
      await execAsync(iptables.wrapIptables(`sudo ip6tables -w -t nat -A FW_PREROUTING_DNS_FALLBACK -p tcp -m tcp --dport 53 -j DNAT --to-destination [${dns6_server}]:53`)).catch((err) => { });
      await execAsync(iptables.wrapIptables(`sudo ip6tables -w -t nat -A FW_PREROUTING_DNS_FALLBACK -p udp -m udp --dport 53 -j DNAT --to-destination [${dns6_server}]:53`)).catch((err) => { });
    }
    await execAsync(iptables.wrapIptables(`sudo iptables -w -t nat -A FW_PREROUTING_DNS_FALLBACK -p tcp --dport 53 -j ACCEPT`)).catch((err) => { });
    await execAsync(iptables.wrapIptables(`sudo iptables -w -t nat -A FW_PREROUTING_DNS_FALLBACK -p udp --dport 53 -j ACCEPT`)).catch((err) => { });
    await execAsync(iptables.wrapIptables(`sudo ip6tables -w -t nat -A FW_PREROUTING_DNS_FALLBACK -p tcp --dport 53 -j ACCEPT`)).catch((err) => { });
    await execAsync(iptables.wrapIptables(`sudo ip6tables -w -t nat -A FW_PREROUTING_DNS_FALLBACK -p udp --dport 53 -j ACCEPT`)).catch((err) => { });
  }

  async _add_all_iptables_rules() {
    if (this.vpnSubnet) {
      await this.updateVpnIptablesRules(this.vpnSubnet, true);
    }
    if (this.wgSubnet) {
      await this.updateWGIptablesRules(this.wgSubnet, true);
    }
    await this._add_iptables_rules();
    await this._add_ip6tables_rules();
  }

  async _add_iptables_rules() {
    const interfaces = sysManager.getMonitoringInterfaces();
    for (const intf of interfaces) {
      const uuid = intf.uuid;
      if (!uuid) {
        log.error(`uuid is not defined for ${intf.name}`);
        return;
      }
      await this._manipulate_ipv4_iptables_rule(intf, '-A');
      this.networkFailCountMap[uuid] = 0;
    }
  }

  async _add_ip6tables_rules() {
    const interfaces = sysManager.getMonitoringInterfaces();
    for (const intf of interfaces) {
      const uuid = intf.uuid;
      if (!uuid) {
        log.error(`uuid is not defined for ${intf.name}`);
        return;
      }
      await this._manipulate_ipv6_iptables_rule(intf, '-A');
    }
  }

  async _manipulate_ipv4_iptables_rule(intf, action) {
    const NetworkProfile = require('../../net2/NetworkProfile.js');
    const uuid = intf.uuid;
    if (!intf.ip_address) {
      log.error(`No ipv4 address is found on ${intf.name}`);
      return;
    }
    await NetworkProfile.ensureCreateEnforcementEnv(uuid);
    const netSet = NetworkProfile.getNetIpsetName(uuid);
    const redirectRule = new Rule('nat').chn('FW_PREROUTING_DNS_DEFAULT')
      .set(netSet, 'src,src')
      .set(ipset.CONSTANTS.IPSET_NO_DNS_BOOST, 'src,src', true)
      .dport(53)
      .jmp(`DNAT --to-destination ${intf.ip_address}:${MASQ_PORT}`)
    await redirectRule.clone().pro('tcp').exec(action);
    await redirectRule.clone().pro('udp').exec(action);
  }

  async _manipulate_ipv6_iptables_rule(intf, action) {
    const NetworkProfile = require('../../net2/NetworkProfile.js');
    const uuid = intf.uuid;
    const ip6Addrs = intf.ip6_addresses;
    if (!ip6Addrs || ip6Addrs.length == 0) {
      log.info(`No ipv6 address is found on ${intf.name}`);
      return;
    }
    await NetworkProfile.ensureCreateEnforcementEnv(uuid);
    const netSet = NetworkProfile.getNetIpsetName(uuid, 6);
    const ip6 = ip6Addrs.find(i => i.startsWith("fe80")) || ip6Addrs[0]; // prefer to use link local address as DNAT address
    const redirectRule = new Rule('nat').fam(6).chn('FW_PREROUTING_DNS_DEFAULT')
      .set(netSet, 'src,src')
      .set(ipset.CONSTANTS.IPSET_NO_DNS_BOOST, 'src,src', true)
      .dport(53)
      .jmp(`DNAT --to-destination [${ip6}]:${MASQ_PORT}`);
    await redirectRule.clone().pro('tcp').exec(action);
    await redirectRule.clone().pro('udp').exec(action);
  }

  async _remove_all_iptables_rules() {
    if (this.vpnSubnet) {
      await this.updateVpnIptablesRules(null, true);
    }
    if (this.wgSubnet) {
      await this.updateWGIptablesRules(null, true);
    }
    await this._remove_iptables_rules()
    await this._remove_ip6tables_rules();
    this.networkFailCountMap = {};
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

  async isDNSServiceActive() {
    let cmd = `systemctl -q is-active ${SERVICE_NAME}`;
    const result = await execAsync(cmd).then(() => true).catch(() => false);
    return result;
  }

  async isDHCPServiceActive() {
    let cmd = `systemctl -q is-active ${DHCP_SERVICE_NAME}`;
    const result = await execAsync(cmd).then(() => true).catch(() => false);
    return result;
  }

  onDHCPReservationChanged(host) {
    this._scheduleWriteHostsFile(host);
    log.debug("DHCP reservation changed, set needWriteHostsFile file to true");
  }

  onSpoofChanged(host) {
    if (this.mode === Mode.MODE_DHCP || this.mode === Mode.MODE_DHCP_SPOOF) {
      this._scheduleWriteHostsFile(host);
      log.debug("Spoof status changed, set needWriteHostsFile to true");
    }
  }


  computeHash(content) {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(content).digest("hex");
  }

  async writeAllHostsFiles() {
    log.info("start to generate hosts files for dnsmasq...");

    const HostManager = require('../../net2/HostManager.js');
    const hostManager = new HostManager();

    // all device with dhcp policy should be returned here by default
    const hosts = (await hostManager.getHostsAsync())
      .filter(h => !sysManager.isMyMac(h.o.mac))

    // remove previously configured hosts files
    await execAsync(`rm -rf ${HOSTFILE_PATH}; mkdir -p ${HOSTFILE_PATH}`)

    for (const h of hosts) try {
      await this.writeHostsFile(h, true)
    } catch(err) {
      log.error('Error write hosts file for', h.o.mac, err)
    }
  }

  async writeHostsFile(host, force = false) {
    const mac = host.o.mac
    const p = host.policy.ipAllocation || {}
    const monitor = !(host.policy.monitor == false) // monitor default value is true

    const tags = platform.isFireRouterManaged() ? [] : [monitor ? 'monitor' : 'unmonitor'];

    const lines = []
    const reservedIPs = []
    const previousIPs = []
    if (!_.isEmpty(tags))
      lines.push(mac + ',' + tags.map(t => 'set:'+t).join(','))

    if (p.dhcpIgnore === true) { // ignore dhcp requests from this MAC
      lines.push(`${mac},ignore`);
      for (const ip of Object.keys(this.reservedIPHost)) {
        if (this.reservedIPHost[ip] === host) {
          previousIPs.push(ip)
          delete this.reservedIPHost[ip];
        }
      }
    } else for (const intf of sysManager.getMonitoringInterfaces()) { // set reserved IP on different networks for this MAC
      let reservedIp = null;
      const intfAlloc = _.get(p, ['allocations', intf.uuid], {})
      if (intfAlloc.dhcpIgnore) {
        lines.push(`${mac},tag:${intf.name.endsWith(":0") ? intf.name.substring(0, intf.name.length - 2) : intf.name},ignore`);
      } else if (intfAlloc.ipv4 && intfAlloc.type == 'static') {
        reservedIp = intfAlloc.ipv4
      } else if (p.alternativeIp && p.type == 'static' && (!monitor || this.mode == Mode.MODE_DHCP_SPOOF)
        && intf.uuid == "00000000-0000-0000-0000-000000000000"
      ) {
        reservedIp = p.alternativeIp
      } else if (p.secondaryIp && p.type == 'static' && monitor && this.mode == Mode.MODE_DHCP
        && intf.uuid == "11111111-1111-1111-1111-111111111111"
      ) {
        reservedIp = p.secondaryIp
      }

      for (const ip of Object.keys(this.reservedIPHost)) {
        if (ip != reservedIp && this.reservedIPHost[ip] === host && sysManager.inMySubnets4(ip, intf.name)) {
          previousIPs.push(ip)
          delete this.reservedIPHost[ip];
        }
      }

      if (!reservedIp || !sysManager.inMySubnets4(reservedIp, intf.name)) {
        // no reserved IP on this network
        continue
      }

      // app will take care of reserved IP conflict since 1.60. Box will no longer take care of reserved IP conflict
      this.reservedIPHost[reservedIp] = host;
      reservedIPs.push(reservedIp)
      lines.push(`${mac},tag:${intf.name.endsWith(":0") ? intf.name.substring(0, intf.name.length - 2) : intf.name},${reservedIp}`)
    }

    if (_.isEmpty(lines)) {
      if (!force && !_.has(this.lastHostsFileHash, mac)) {
        log.verbose("No need to update hosts file, skipped", mac);
        return
      }
      delete this.lastHostsFileHash[mac];
      await fsp.unlink(HOSTFILE_PATH + mac).catch((err) => {});
    } else {
      const content = lines.join('\n') + '\n'

      const _hostsHash = this.computeHash(content);

      if (!force && this.lastHostsFileHash[mac] == _hostsHash) {
        log.verbose("No need to update hosts file, skipped", mac);
        return
      }

      this.lastHostsFileHash[mac] = _hostsHash;

      log.debug("HostsFile:", util.inspect(lines));

      await fsp.writeFile(HOSTFILE_PATH + mac, content);
    }
    // delete lesase entry in case other device occupies the IP, also deletes for itself but that's fine
    // dnsmasq seems to be able to handle IP conflict if misconfigured, so we are good here
    const deleted = []
    if (reservedIPs.length)
      deleted.push(... await this.deleteLeaseRecord(null, reservedIPs))
    if (previousIPs.length)
      deleted.push(... await this.deleteLeaseRecord(mac, previousIPs))
    for (const entry of deleted) {
      sem.emitEvent({
        type: Message.MSG_MAPPING_IP_MAC_DELETED,
        message: `Deleted DHCP lease record of ${entry.mac} - ${entry.ip}`,
        mac: entry.mac,
        fam: net.isIP(entry.ip),
        ip: entry.ip,
      })
    }
    if (!this.counter.writeHostsFile[mac]) this.counter.writeHostsFile[mac] = 0
    log.info("Hosts file has been updated:", mac, ++this.counter.writeHostsFile[mac], 'times')

    // reload or not is check with config hash
    this.scheduleRestartDHCPService()
  }

  async removeHostsFile(host) {
    await fsp.unlink(HOSTFILE_PATH + host.o.mac);
    log.info("Hosts file has been removed:", host.o.mac)

    const hID = host.getGUID()
    if (this.writeHostsFileTask[hID])
      clearTimeout(this.writeHostsFileTask[hID]);

    delete this.lastHostsFileHash[hID]

    for (const ip in this.reservedIPHost) {
      if (this.reservedIPHost[ip] == host) {
        log.verbose('delete reserved entry', host.getGUID())
        delete this.reservedIPHost[ip]
      }
    }

    this.scheduleRestartDHCPService(true)
  }

  async removeIPFromHost(host, ip) {
    const path = HOSTFILE_PATH + host.o.mac
    try {
      const file = await fsp.readFile(path, 'utf8')
      const lines = file.split('\n').filter(line => !line.includes(ip))
      await fsp.writeFile(path, lines.join('\n'));
    } catch(err) {
      if (err.code == 'ENOENT') return
      else log.error(err)
    }
  }

  async rawStart() {
    if (!platform.isFireRouterManaged()) try {
      // use restart to ensure the latest configuration is loaded
      let cmd = `DP_SO_PATH=${platform.getDnsproxySOPath()} ${platform.getDnsmasqBinaryPath()} -k --clear-on-reload -u ${userID} -C ${configFile} -r ${resolvFile}`;
      cmd = await this.prepareDnsmasqCmd(cmd);
      this.writeStartScript(cmd);
    } catch (err) {
      log.error('Error adding DHCP arguments', err)
    }

    await this.writeAllHostsFiles().catch(err => {
      log.error('Error writing hosts files', err)
    })

    this.scheduleRestartDNSService(true);
    if (DHCP_SERVICE_NAME !== SERVICE_NAME)
      this.scheduleRestartDHCPService(true);
  }

  writeStartScript(cmd) {
    log.info("Command to start dnsmasq: ", cmd);

    let content = ['#!/bin/bash'];

    if (!platform.isFireRouterManaged()) {
      content.push(`diff ${f.getFirewallaHome()}/etc/rsyslog.d/13-dnsmasq.conf /etc/rsyslog.d/13-dnsmasq.conf &>/dev/null || (sudo cp ${f.getFirewallaHome()}/etc/rsyslog.d/13-dnsmasq.conf /etc/rsyslog.d/; sudo systemctl restart rsyslog)`);
    }

    content = content.concat([
      'redis-cli HINCRBY "stats:systemd:restart" firemasq 1',
      cmd + " &",
      'trap "trap - SIGTERM && kill -- -$$" SIGINT SIGTERM EXIT',
      'for job in `jobs -p`; do wait $job; echo "$job exited"; done',
      ''
    ]);

    fs.writeFileSync(startScriptFile, content.join("\n"));
  }

  setDhcpRange(network, begin, end) {
    interfaceDhcpRange[network] = {
      begin: begin,
      end: end
    };
  }

  async getDhcpRange(network) {
    let range = interfaceDhcpRange[network];
    if (!range) {
      range = await dnsTool.getDefaultDhcpRange(network);
    }
    return range;
  }

  async prepareDnsmasqCmd(cmd) {
    fConfig = await Config.getConfig(true);
    const secondaryRange = await this.getDhcpRange("secondary");
    const secondaryRouterIp = sysManager.myIp2();
    const secondaryMask = sysManager.myIpMask2();
    let secondaryDnsServers = sysManager.myDefaultDns().join(',');
    if (interfaceNameServers.secondary && interfaceNameServers.secondary.length != 0) {
      // if secondary dns server is set, use specified dns servers in dhcp response
      secondaryDnsServers = interfaceNameServers.secondary.join(',');
    }

    const alternativeRange = await this.getDhcpRange("alternative");
    const alternativeRouterIp = sysManager.myDefaultGateway();
    const alternativeMask = sysManager.myIpMask();
    let alternativeDnsServers = sysManager.myDefaultDns().join(',');
    if (interfaceNameServers.alternative && interfaceNameServers.alternative.length != 0) {
      // if alternative dns server is set, use specified dns servers in dhcp response
      alternativeDnsServers = interfaceNameServers.alternative.join(',');
    }

    let secondaryLeaseTime = (fConfig.dhcpLeaseTime && fConfig.dhcpLeaseTime.secondary) || (fConfig.dhcp && fConfig.dhcp.leaseTime) || "24h";
    let alternativeLeaseTime = (fConfig.dhcpLeaseTime && fConfig.dhcpLeaseTime.alternative) || (fConfig.dhcp && fConfig.dhcp.leaseTime) || "24h";
    const monitoringInterface = fConfig.monitoringInterface || "eth0";

    if (this.mode === Mode.MODE_DHCP) {
      log.info("DHCP feature is enabled");
      // allocate secondary interface ip to monitored hosts and new hosts
      cmd = util.format("%s --dhcp-range=tag:%s,tag:!unmonitor,%s,%s,%s,%s",
        cmd,
        monitoringInterface,
        secondaryRange.begin,
        secondaryRange.end,
        secondaryMask,
        secondaryLeaseTime
      );

      // allocate primary(alternative) interface ip to unmonitored hosts
      cmd = util.format("%s --dhcp-range=tag:%s,tag:unmonitor,%s,%s,%s,%s",
        cmd,
        monitoringInterface,
        alternativeRange.begin,
        alternativeRange.end,
        alternativeMask,
        alternativeLeaseTime
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
        alternativeLeaseTime
      );

      // Firewalla's ip as router for monitored hosts and new hosts. In case Firewalla's ip is changed, a thorough restart is required
      cmd = util.format("%s --dhcp-option=tag:%s,tag:!unmonitor,3,%s", cmd, monitoringInterface, sysManager.myDefaultWanIp());

      // gateway ip as router for unmonitored hosts
      cmd = util.format("%s --dhcp-option=tag:%s,tag:unmonitor,3,%s", cmd, monitoringInterface, alternativeRouterIp);

      cmd = util.format("%s --dhcp-option=tag:%s,6,%s", cmd, monitoringInterface, alternativeDnsServers);
    }

    return cmd;
  }

  async rawStop() {
    let cmd = null;
    // do not stop dnsmasq if it is managed by firerouter
    if (platform.isFireRouterManaged())
      return;

    cmd = `sudo systemctl stop ${SERVICE_NAME}`;

    log.info(`Command to stop ${SERVICE_NAME}: ${cmd}`);

    try {
      await execAsync(cmd);
    } catch (err) {
      log.error(`Failed to stop ${SERVICE_NAME}`, err);
    }
  }

  async start(skipIptablesUpdate) {
    await lock.acquire("LOCK_DNSMASQ_START", async () => {
      // 0. update resolv.conf
      // 1. update filter (by default only update filter once per configured interval, unless force is true)
      // 2. start dnsmasq service
      // 3. update iptables rule
      log.info("Starting DNSMASQ...");

      await this.updateResolvConf();
      try {
        await this.rawStart();
      } catch (err) {
        log.error('Error when raw start dnsmasq', err);
        return;
      }

      if (!skipIptablesUpdate) {
        try {
          await this._remove_all_iptables_rules();
          await this._add_all_iptables_rules();
          await this._update_dns_fallback_rules();
        } catch (err) {
          log.error('Error when add iptables rules', err);
          await this._remove_all_iptables_rules();
          log.error("Dnsmasq start is aborted due to failed to add iptables rules");
          return;
        }
      }

      log.info("DNSMASQ is started successfully");
    }).catch((err) => {
      log.error(`Failed to start dnsmasq`, err.message);
    });
  }

  async stop() {
    // 1. remove iptables rules
    // 2. stop service
    // optional to remove filter file

    log.info("Stopping DNSMASQ:");
    await this._remove_all_iptables_rules();
    await this.rawStop();
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
    const result = {};
    for (const monitoringInterface of sysManager.getMonitoringInterfaces()) {
      if (!monitoringInterface || !monitoringInterface.ip_address || !monitoringInterface.uuid)
        continue;
      const STATUS_CHECK_INTERFACE = monitoringInterface.ip_address;
      const uuid = monitoringInterface.uuid;
      let resolved = false;
      for (const domain of VERIFICATION_DOMAINS) {
        // if there are 3 verification domains and each takes at most 6 seconds to fail the test, it will take 18 seconds to fail the test on one network interface
        let cmd = `dig -4 A +short +time=3 +tries=2 -p ${MASQ_PORT} @${STATUS_CHECK_INTERFACE} ${domain}`;
        log.debug(`Verifying DNS resolution to ${domain} on ${STATUS_CHECK_INTERFACE} ...`);
        try {
          let { stdout, stderr } = await execAsync(cmd);
          if (!stdout || !stdout.trim().split('\n').some(line => new Address4(line).isValid())) {
            log.warn(`Error verifying dns resolution to ${domain} on ${STATUS_CHECK_INTERFACE}`, stderr, stdout);
          } else {
            log.debug(`DNS resolution succeeds to ${domain} on ${STATUS_CHECK_INTERFACE}`);
            resolved = true;
            break;
          }
        } catch (err) {
          // usually fall into catch clause if dns resolution is failed
          log.error(`Failed to resolve ${domain} on ${STATUS_CHECK_INTERFACE}`, err.stdout, err.stderr);
        }
      }
      if (!resolved)
        log.error(`Failed to resolve all domains on ${STATUS_CHECK_INTERFACE}.`);
      result[uuid] = resolved;
    }
    return result;
  }

  // check upstream dns connectivity, up status returns true, down returns false.
  async dnsUpstreamConnectivity(intf) {
    for (const domain of VERIFICATION_DOMAINS) {
      const resolver4 = sysManager.myResolver(intf.name);
      const resolver6 = sysManager.myResolver6(intf.name);
      let cmds = [];
      // check all dns servers, if any works normal, return up status
      for (const dnsServer of resolver4) {
        let cmd = `dig -4 A +short +time=3 +tries=2 @${dnsServer} ${domain}`;
        cmds.push({dnsServer, cmd});
      }
      for (const dnsServer of resolver6) {
        cmds.push({dnsServer:dnsServer, cmd:`dig -6 A +short +time=3 +tries=2 @${dnsServer} ${domain}`});
      }

      for (const {dnsServer, cmd} of cmds) {
        log.debug(`DNS upstream check, verifying DNS resolution to ${domain} on ${dnsServer} ...`);
        try {
          let { stdout, stderr } = await execAsync(cmd);
          if (!stdout || !stdout.trim().split('\n').some(line => new Address4(line).isValid())) {
            log.warn(`DNS upstream check, error verifying dns resolution to ${domain} on ${dnsServer}`, stderr, stdout);
          } else {
            // normal dns answer, quick return
            log.info(`DNS upstream check, succeeded to resolve ${domain} on ${dnsServer} to`, stdout);
            return true;
          }
        } catch (err) {
          // usually fall into catch clause if dns resolution is failed
          log.error(`DNS upstream check, failed to resolve ${domain} on ${dnsServer}`, err.message);
        }
      }
    }
    // no domain resolved, return upstream dns down
    return false;
  }


  async dnsStatusCheck() {
    log.debug("Keep-alive checking dnsmasq status")
    let checkResult = await this.verifyDNSConnectivity() || {};
    let needRestart = false;

    for (const uuid in checkResult) {
      // use lock to prevent concurrent changes to neworkFailCountMap and iptables operations on the same network
      await lock.acquire(`LOCK_DNS_CHECK_${uuid}`, async () => {
        const intf = sysManager.getInterfaceViaUUID(uuid);
        if (this.networkFailCountMap[uuid] === undefined || !intf) {
          log.warn(`Network uuid ${uuid} in dns status check result is not found`);
          return;
        }
        if (checkResult[uuid] === true) {
          if (this.networkFailCountMap[uuid] > 2) {
            log.info(`DNS of network ${intf.name} is restored, add back DNS redirect rules ...`);
            await this._manipulate_ipv4_iptables_rule(intf, '-A');
            await this._manipulate_ipv6_iptables_rule(intf, '-A');
          }
          this.networkFailCountMap[uuid] = 0;
        } else {
          // check upstream dns status, if down then DO NOT restart dnsmasq
          const upstreamDNSUP = await this.dnsUpstreamConnectivity(intf);
          if (!upstreamDNSUP){
            log.info(`Upstream DNS status down(status up=${upstreamDNSUP}). DO NOT remove redirect rules` );
            return;
          } else {
            log.warn(`Upstream DNS status up (status up=${upstreamDNSUP}). Remove redirect rules` );
          }

          this.networkFailCountMap[uuid]++;
          needRestart = true;
          if (this.networkFailCountMap[uuid] > 2) {
            log.info(`DNS of network ${intf.name} is unreachable, remove DNS redirect rules ...`);
            await this._manipulate_ipv4_iptables_rule(intf, '-D');
            await this._manipulate_ipv6_iptables_rule(intf, '-D');
          }
        }
      }).catch((err) => {
        log.error(`Failed to apply DNS redirect rules based on status check result on network ${uuid}`, err.message);
      });
    }

    if (needRestart) {
      this.scheduleRestartDNSService(true);
    }
  }

  async cleanUpLeftoverConfig() {
    try {
      await execAsync(`mkdir -p ${FILTER_DIR}`).catch((err) => {
        log.error(`Failed to create ${FILTER_DIR}`, err);
      });
      const dirs = [FILTER_DIR, LEGACY_FILTER_DIR, HOSTS_DIR];

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
      // remove legacy hosts folder/file
      if (platform.isFireRouterManaged()) {
        await fsp.rmdir(ROUTER_DHCP_PATH + '/hosts/', { recursive: true }).catch(err => {
          if (err.code == 'ENOENT') return
          else log.error(err)
        })
      } else {
        await fsp.unlink(f.getRuntimeInfoFolder() + "/dnsmasq-hosts").catch(err => {
          if (err.code == 'ENOENT') return
          else log.error(err)
        })
      }

      log.info("clean up cleanUpLeftoverConfig");
      await rclient.unlinkAsync('dnsmasq:conf');
      // always allow verification domains in case they are accidentally blocked and cause self check failure
      await fs.writeFileAsync(VERIFICATION_WHILELIST_PATH, VERIFICATION_DOMAINS.map(d => `server-high=/${d}/#`).join('\n'), {}).catch((err) => {
        log.error(`Failed to generate verification domains whitelist config`, err.message);
      });
      // add default wan tag on all devices, which is a necessary condition in dns features, i.e. unbound, doh, family-protect, it can be denied in vpn client routes
      await fs.writeFileAsync(`${FILTER_DIR}/default_wan.conf`, `mac-address-tag=%FF:FF:FF:FF:FF:FF$${Constants.DNS_DEFAULT_WAN_TAG}`).catch((err) => {});
    } catch (err) {
      log.error("Failed to clean up leftover config", err);
    }
  }

  async throttleUpdatingConf(filePath, data) {
    const cooldown = 5 * 1000;
    if (this.throttleTimer[filePath]) {
      clearTimeout(this.throttleTimer[filePath])
    }
    this.throttleTimer[filePath] = setTimeout(async () => {
      log.info(`Going to update ${filePath}`)
      await fs.writeFileAsync(filePath, data);
      this.scheduleRestartDNSService();
    }, cooldown)
  }

  async checkConfsChange(dnsmasqConfKey = "dnsmasq:conf", paths = [`${FILTER_DIR}*`, resolvFile, startScriptFile, configFile]) {
    try {
      let md5sumNow = '';
      for (const confs of paths) {
        const stdout = await execAsync(`find ${confs} -type f | (while read FILE; do (cat "\${FILE}"; echo); done;) | sort | md5sum | awk '{print $1}'`).then(r => r.stdout).catch((err) => null);
        md5sumNow = md5sumNow + (stdout ? stdout.split('\n').join('') : '');
      }
      const md5sumBefore = await rclient.getAsync(dnsmasqConfKey);
      if (md5sumNow != md5sumBefore) {
        log.info(`dnsmasq confs ${dnsmasqConfKey} md5sum, before: ${md5sumBefore} now: ${md5sumNow}`)
        await rclient.setAsync(dnsmasqConfKey, md5sumNow);
        return true;
      }
      return false;
    } catch (error) {
      log.info(`Get dnsmasq confs md5summ error`, error)
      return true;
    }
  }

  // ip could be a string of single IP or an array of IPs
  // return deleted lines
  async deleteLeaseRecord(mac, ip) {
    if (!mac && (!ip || !ip.length))
      return [];
    const leaseFile = platform.getDnsmasqLeaseFilePath();
    const regex = `^[0-9]+ ${mac ? mac.toLowerCase() : '[0-9a-f:]{17}'} ${ip ? Array.isArray(ip) ? `(${ip.join('\|')})` : ip : ''}`
    log.debug('lease file sed regex', regex)
    return await lock.acquire(LOCK_LEASE_FILE, async () => {
      // https://unix.stackexchange.com/questions/108335/printing-and-deleting-the-first-line-of-a-file-using-sed#comment1121396_442370
      // delete and write to stdout at the same time
      const result = await execAsync(`sudo sed -i -r -e '/${regex}/{w /dev/stdout' -e 'd}' ${leaseFile}`).catch(err => {
        log.error(`Failed to remove lease record of ${mac} from ${leaseFile}`, err.message);
      })
      return _.get(result, 'stdout', '').split('\n').filter(line => line.length).map(line => {
        const column = line.split(' ')
        return {
          ts: Number(column[0]),
          mac: column[1].toUpperCase(),
          ip: column[2],
          name: column.slice(3, -1).join(' ')
        }
      })
    })
  }

  async getCounterInfo() {
    return this.counter;
  }

  async searchDnsmasq(target) {
    let matchedDnsmasqs = [];
    const addrPort = target.split(":");
    const domain = addrPort[0];
    let waitSearch = [];
    const splited = domain.split(".");
    for (let i = splited.length; i--; i > 0) {
      waitSearch.push(splited.join("."));
      splited.shift();
    }
    const hashedDomains = flowUtil.hashHost(target, { keepOriginal: true });

    const dirs = [FILTER_DIR, LOCAL_FILTER_DIR];
    for (let dir of dirs) {
      const dirExists = await fs.accessAsync(dir, fs.constants.F_OK).then(() => true).catch(() => false);
      if (!dirExists)
        continue;

      const files = await fs.readdirAsync(dir);
      await Promise.all(files.map(async (filename) => {
        const filePath = `${dir}/${filename}`;
        try {
          const fileStat = await fs.statAsync(filePath);
          if (fileStat.isFile()) {
            let match = false;
            let content = await fs.readFileAsync(filePath, { encoding: 'utf8' });
            if (content.indexOf("hash-address=/") > -1) {
              for (const hdn of hashedDomains) {
                if (content.indexOf("hash-address=/" + hdn[2] + "/") > -1) {
                  match = true;
                  break;
                }
              }
            } else {
              for (const currentTxt of waitSearch) {
                if (content.indexOf("address=/" + currentTxt + "/") > -1) {
                  match = true;
                  break;
                }
              }
            }

            if (match) {
              let featureName = filename;
              if (filename.startsWith("adblock_")) {
                featureName = 'adblock';
              } else if (filename.startsWith("safe_search")) {
                featureName = 'safe_search';
              } else if (filename.startsWith("box_alias")) {
                featureName = 'box_alias';
              } else if (filename.startsWith("policy_")) {
                featureName = 'policy';
              } else if (filename.indexOf("_block.conf") > -1) {
                featureName = 'policy';
              }
              matchedDnsmasqs.push(featureName);
            }
          }
        } catch (err) {
          log.info(`File ${filePath} not exist`);
        }
      }));
    }

    return _.uniqWith(matchedDnsmasqs, _.isEqual);
  }

  // TODO: hosts files are built with host policies, see writeHostsFile()
  // this should be re-implemented without reading hosts files
  async getDhcpPoolUsage() {
    if (!platform.isFireRouterManaged())
      return null;
    const stats = {};
    // first extract dhcp range of networks that have dhcp enabled
    const FireRouter = require('../../net2/FireRouter.js');
    const routerConfig = await FireRouter.getConfig(false);
    const dhcpConfig = routerConfig && routerConfig.dhcp;
    if (_.isEmpty(dhcpConfig))
      return stats;
    for (const intf of sysManager.getMonitoringInterfaces()) {
      if (dhcpConfig[intf] && !_.isEmpty(dhcpConfig[intf].range))
        stats[intf] = {
          from: dhcpConfig[intf].range.from,
          to: dhcpConfig[intf].range.to,
          reservedIPsInRange: 0,
          reservedIPsOutOfRange: 0,
          dynamicIPs: 0
        };
    }
    // then extract reserved IPs, they cannot be dynamically allocated to other devices
    const files = await fsp.readdir(HOSTFILE_PATH).catch(err => {
      if (err.code == 'ENOENT') return
      else log.error('Error reading DHCP hosts folder:', err)
      return []
    })

    const reservedIPs = []
    for (const file of files) try {
      let lines = await fsp.readFile(HOSTFILE_PATH + file, {encoding: "utf8"})
      lines = lines.trim().split('\n')
      const ipSegments = lines.map(line => line.split(',')[2]).filter(ip => !_.isEmpty(ip));
      for (const reservedIP of ipSegments) {
        const addr4 = new Address4(reservedIP);
        if (addr4.isValid()) {
          reservedIPs.push(reservedIP)
          const iface = sysManager.getInterfaceViaIP4(reservedIP);
          if (iface && iface.name) {
            const intf = iface.name;
            if (!stats[intf]) {
              continue;
            }
            const addr4bn = addr4.bigInteger();
            const from = stats[intf].from;
            const to = stats[intf].to;
            if (addr4bn.compareTo(new Address4(from).bigInteger()) >= 0 && addr4bn.compareTo(new Address4(to).bigInteger()) <= 0)
              stats[intf].reservedIPsInRange++;
            else
              stats[intf].reservedIPsOutOfRange++;
          }
        }
      }
    } catch(err) {
      log.error(`Failed to read DHCP hosts file ${file}`, err.message);
    }
    // then extract dynamic IPs, and put them together with reserved IPs in stats
    const leaseFilePath = platform.getDnsmasqLeaseFilePath();

    const lines = await lock.acquire(LOCK_LEASE_FILE, async () => {
      return fsp.readFile(leaseFilePath, {encoding: "utf8"})
        .then(content => content.trim().split('\n'))
        .catch((err) => {
          log.error(`Failed to read DHCP lease file ${leaseFilePath}`, err.message);
          return []
        })
    })
    for (const line of lines) {
      const phrases = line.split(' ');
      if (!_.isEmpty(phrases)) {
        const ip4 = phrases[2];
        if (net.isIPv4(ip4)) {
          const iface = sysManager.getInterfaceViaIP4(ip4);
          if (iface && iface.name) {
            const intf = iface.name;
            if (!stats[intf]) {
              continue;
            }
            if (!reservedIPs.includes(ip4))
              stats[intf].dynamicIPs++;
          }
        }
      }
    }
    return stats;
  }
};
