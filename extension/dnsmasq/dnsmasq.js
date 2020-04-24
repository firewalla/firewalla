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

const _ = require('lodash');
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
const Message = require('../../net2/Message.js');
const fc = require('../../net2/config.js')
const { delay } = require('../../util/util.js');

const { Rule } = require('../../net2/Iptables.js');
const ipset = require('../../net2/Ipset.js');

const FILTER_DIR = f.getUserConfigFolder() + "/dnsmasq";
const LOCAL_FILTER_DIR = f.getUserConfigFolder() + "/dnsmasq_local";
const LEGACY_FILTER_DIR = f.getUserConfigFolder() + "/dns";
const LOCAL_DOMAIN_KEY = "local:device:domain"
const systemLevelMac = "FF:FF:FF:FF:FF:FF";

const UPSTREAM_SERVER_FILE = FILTER_DIR + "/upstream_server.conf";

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
const startScriptFile = __dirname + "/dnsmasq.sh";

const configFile = __dirname + "/dnsmasq.conf";

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
const VERIFICATION_DOMAINS = (fConfig.dns && fConfig.dns.verificationDomains) || ["firewalla.encipher.io"];
const RELOAD_INTERVAL = 3600 * 24 * 1000; // one day

const SERVICE_NAME = platform.getDNSServiceName();
const DHCP_SERVICE_NAME = platform.getDHCPServiceName();
const HOSTFILE_PATH = platform.isFireRouterManaged() ?
  f.getUserHome() + fConfig.firerouter.hiddenFolder + '/config/dhcp/hosts/hosts' :
  f.getRuntimeInfoFolder() + "/dnsmasq-hosts";
const MASQ_PORT = platform.isFireRouterManaged() ? 53 : 8853;
const HOSTS_DIR = f.getRuntimeInfoFolder() + "/hosts";

const flowUtil = require('../../net2/FlowUtil.js');

module.exports = class DNSMASQ {
  constructor() {
    if (instance == null) {
      log = require("../../net2/logger.js")(__filename);

      instance = this;

      this.mode = null;
      this.minReloadTime = new Date() / 1000;
      this.deleteInProgress = false;
      this.updatingLocalDomain = false;
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

          sclient.on("message", (channel, message) => {
            switch (channel) {
              case Message.MSG_SYS_NETWORK_INFO_RELOADED:
                (async () => {
                  const started = await this.isDNSServiceActive();
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

          sclient.subscribe(Message.MSG_SYS_NETWORK_INFO_RELOADED);
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

  _scheduleWriteHostsFile() {
    if (this.writeHostsFileTask)
      clearTimeout(this.writeHostsFileTask);
    this.writeHostsFileTask = setTimeout(async () => {
      const reload = await this.writeHostsFile().catch((err) => {
        log.error("Failed to write hosts file", err.message);
        return false;
      });
      if (reload) {
        this.scheduleRestartDHCPService();
      }
    }, 5000);
  }

  scheduleRestartDNSService(ignoreFileCheck = false) {
    if (this.restartDNSTask)
      clearTimeout(this.restartDNSTask);
    this.restartDNSTask = setTimeout(async () => {
      if (!ignoreFileCheck) {
        const confChanged = await this.checkConfsChange();
        if (!confChanged)
          return;
      }
      await execAsync(`sudo systemctl stop ${SERVICE_NAME}`).catch((err) => { });
      this.counter.restart++;
      log.info(`Restarting ${SERVICE_NAME}`, this.counter.restart);
      const cmd = `sudo systemctl restart ${SERVICE_NAME}`;
      await execAsync(cmd).then(() => {
        log.info(`${SERVICE_NAME} has been restarted`, this.counter.restart);
      }).catch((err) => {
        log.error(`Failed to restart ${SERVICE_NAME} service`, err.message);
      });
    }, 5000);
  }

  scheduleReloadDNSService() {
    if (this.reloadDNSTask)
      clearTimeout(this.reloadDNSTask);
    this.reloadDNSTask = setTimeout(async () => {
      this.counter.reloadDnsmasq++;
      log.info(`Reloading ${SERVICE_NAME}`, this.counter.reloadDnsmasq);
      await execAsync(`sudo systemctl reload ${SERVICE_NAME}`).then(() => {
        log.info(`${SERVICE_NAME} has been reloaded`, this.counter.reloadDnsmasq);
      }).catch((err) => {
        log.error(`Failed to reload ${SERVICE_NAME} service`, err.message);
      });
    }, 5000);
  }

  scheduleRestartDHCPService(ignoreFileCheck = false) {
    if (this.restartDHCPTask)
      clearTimeout(this.restartDHCPTask);
    this.restartDHCPTask = setTimeout(async () => {
      if (!ignoreFileCheck) {
        const confChanged = await this.checkConfsChange();
        if (!confChanged)
          return;
      }
      await execAsync(`sudo systemctl stop ${DHCP_SERVICE_NAME}`).catch((err) => { });
      this.counter.restartDHCP++;
      log.info(`Restarting ${DHCP_SERVICE_NAME}`, this.counter.restartDHCP);
      await execAsync(`sudo systemctl restart ${DHCP_SERVICE_NAME}`).then(() => {
        log.info(`${DHCP_SERVICE_NAME} has been restarted`, this.counter.restartDHCP);
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
      await fs.unlinkAsync(UPSTREAM_SERVER_FILE).catch((err) => {});
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
          this.scheduleRestartDNSService();
          this._scheduleNextReload(type, nextState, this.nextState[type]);
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
        .then(() => {
          this.scheduleRestartDNSService();
          this._scheduleNextReload(type, nextState, this.nextState[type]);
        });
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
    try {
      for (const domain of domains) {
        if (!_.isEmpty(options.scope) || !_.isEmpty(options.intfs) || !_.isEmpty(options.tags)) {
          if (!_.isEmpty(options.scope)) {
            // use single config file for all devices configuration
            const entries = [];
            for (const mac of options.scope) {
              entries.push(`mac-address-tag=%${mac}$policy_${options.pid}`);
              if (options.action === "block")
                entries.push(`address=/${domain}/${BLACK_HOLE_IP}$policy_${options.pid}`);
              else
                entries.push(`server=/${domain}/#$policy_${options.pid}`);
            }
            const filePath = `${FILTER_DIR}/policy_${options.pid}.conf`;
            await fs.writeFileAsync(filePath, entries.join('\n'));
          }
          
          if (!_.isEmpty(options.intfs)) {
            const NetworkProfile = require('../../net2/NetworkProfile.js');
            // use separate config file for each network configuration
            for (const intf of options.intfs) {
              const entries = [`mac-address-tag=%00:00:00:00:00:00$policy_${options.pid}`];
              if (options.action === "block")
                entries.push(`address=/${domain}/${BLACK_HOLE_IP}$policy_${options.pid}`);
              else
                entries.push(`server=/${domain}/#$policy_${options.pid}`);
              const filePath = `${NetworkProfile.getDnsmasqConfigDirectory(intf)}/policy_${options.pid}.conf`; 
              await fs.writeFileAsync(filePath, entries.join('\n'));
            }
          } 
          
          if (!_.isEmpty(options.tags)) {
            // use separate config file for each tag configuration
            for (const tag of options.tags) {
              const entries = [`group-tag=@${tag}$policy_${options.pid}`];
              if (options.action === "block")
                entries.push(`address=/${domain}/${BLACK_HOLE_IP}$policy_${options.pid}`);
              else
                entries.push(`server=/${domain}/#$policy_${options.pid}`);
              const filePath = `${FILTER_DIR}/tag_${tag}_policy_${options.pid}.conf`;
              await fs.writeFileAsync(filePath, entries.join('\n'));
            }
          }
        } else {
          // global effective policy
          const entries = [];
          if (options.action === "block")
            entries.push(`address=/${domain}/${BLACK_HOLE_IP}`);
          else
            entries.push(`server=/${domain}/#`);
          const filePath = `${FILTER_DIR}/policy_${options.pid}.conf`;
          await fs.writeFileAsync(filePath, entries.join('\n'));
        }
      }
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
    const categoryAllowDomainsFile = FILTER_DIR + `/${category}_allow.conf`;
    const blockEntries = [];
    const allowEntries = [];
    try {
      for (const domain of domains) {
        blockEntries.push(`address=/${domain}/${BLACK_HOLE_IP}$${category}_block`);
        allowEntries.push(`server=/${domain}/#$${category}_allow`);
      }
      await fs.writeFileAsync(categoryBlockDomainsFile, blockEntries.join('\n'));
      await fs.writeFileAsync(categoryAllowDomainsFile, allowEntries.join('\n'));

      if (!_.isEmpty(options.scope) || !_.isEmpty(options.intfs) || !_.isEmpty(options.tags)) {
        if (options.scope && options.scope.length > 0) {
          // use single config for all devices configuration
          const entries = [];
          for (const mac of options.scope) {
            if (options.action === "block")
              entries.push(`mac-address-tag=%${mac}$${category}_block`);
            else
              entries.push(`mac-address-tag=%${mac}$${category}_allow`);
          }
          const filePath = `${FILTER_DIR}/policy_${options.pid}.conf`;
          await fs.writeFileAsync(filePath, entries.join('\n'));
        } 
        
        if (!_.isEmpty(options.intfs)) {
          const NetworkProfile = require('../../net2/NetworkProfile.js');
          // use separate config file for each network configuration
          for (const intf of options.intfs) {
            const entries = [];
            if (options.action === "block")
              entries.push(`mac-address-tag=%00:00:00:00:00:00$${category}_block`);
            else
              entries.push(`mac-address-tag=%00:00:00:00:00:00$${category}_allow`);
            const filePath = `${NetworkProfile.getDnsmasqConfigDirectory(intf)}/policy_${options.pid}.conf`;
            await fs.writeFileAsync(filePath, entries.join('\n'));
          }
        } 
        
        if (!_.isEmpty(options.tags)) {
          // use separate config file for each tag configuration
          for (const tag of options.tags) {
            const entries = [];
            if (options.action === "block")
              entries.push(`group-tag=@${tag}$${category}_block`);
            else
              entries.push(`group-tag=@${tag}$${category}_allow`);
            const filePath = `${FILTER_DIR}/tag_${tag}_policy_${options.pid}.conf`;
            await fs.writeFileAsync(filePath, entries.join('\n'));
          }
        }
      } else {
        // global effective policy
        const entries = [];
        if (options.action === "block")
          entries.push(`mac-address-tag=%${systemLevelMac}$${category}_block`);
        else
          entries.push(`mac-address-tag=%${systemLevelMac}$${category}_allow`);
        const filePath = `${FILTER_DIR}/policy_${options.pid}.conf`;
        await fs.writeFileAsync(filePath, entries.join('\n'));
      }
    } catch (err) {
      log.error("Failed to add category mac set entry into file:", err);
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
    try {
      options = options || {};
    
      if (!_.isEmpty(options.scope) || !_.isEmpty(options.intfs) || !_.isEmpty(options.tags)) {
        if (options.scope && options.scope.length > 0) {
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
      } else {
        const filePath = `${FILTER_DIR}/policy_${options.pid}.conf`;
        await fs.unlinkAsync(filePath).catch((err) => {
          log.error(`Failed to remove policy config file for ${options.pid}`, err.message);
        });
      }
    } catch (err) {
      log.error("Failed to remove policy config file:", err);
    } finally {
      this.workingInProgress = false;
    }
  }

  async updatePolicyCategoryFilterEntry(domains, options) {
    log.debug("updatePolicyCategoryFilterEntry", domains, options);
    options = options || {};
    const category = options.category;
    const categoryBlockDomainsFile = FILTER_DIR + `/${category}_block.conf`;
    const categoryAllowDomainsFile = FILTER_DIR + `/${category}_allow.conf`;
    const blockEntries = [];
    const allowEntries = [];
    while (this.workingInProgress) {
      log.info("deferred due to dnsmasq is working in progress")
      await delay(1000);  // try again later
    }
    this.workingInProgress = true;
    for (const domain of domains) {
      blockEntries.push(`address=/${domain}/${BLACK_HOLE_IP}$${category}_block`);
      allowEntries.push(`server=/${domain}/#$${category}_allow`);
    }
    try {
      await fs.writeFileAsync(categoryBlockDomainsFile, blockEntries.join('\n'));
      await fs.writeFileAsync(categoryAllowDomainsFile, allowEntries.join('\n'));
    } catch (err) {
      log.error("Failed to update category entry into file:", err);
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
    try {
      if (!_.isEmpty(options.scope) || !_.isEmpty(options.intfs) || !_.isEmpty(options.tags)) {
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
      } else {
        const filePath = `${FILTER_DIR}/policy_${options.pid}.conf`;
        await fs.unlinkAsync(filePath).catch((err) => {
          log.error(`Failed to remove policy config file for ${options.pid}`, err.message);
        });

      }
    } catch (err) {
      log.error("Failed to remove policy config file:", err);
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

  async _add_all_iptables_rules() {
    if (this.vpnSubnet) {
      await this.updateVpnIptablesRules(this.vpnSubnet, true);
    }
    await this._add_iptables_rules();
    await this._add_ip6tables_rules();
  }

  async _add_iptables_rules() {
    const interfaces = sysManager.getMonitoringInterfaces();
    const NetworkProfile = require('../../net2/NetworkProfile.js');
    for (const intf of interfaces) {
      const uuid = intf.uuid;
      if (!uuid) {
        log.error(`uuid is not defined for ${intf.name}`);
        continue;
      }
      if (!intf.ip_address) {
        log.error(`No ipv4 address is found on ${intf.name}`);
        continue;
      }
      await NetworkProfile.ensureCreateEnforcementEnv(uuid);
      const netSet = NetworkProfile.getNetIpsetName(uuid);
      const redirectTCP = new Rule('nat').chn('FW_PREROUTING_DNS_DEFAULT').pro('tcp')
        .mdl("set", `--match-set ${netSet} src,src`)
        .mdl("set", `! --match-set ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} src,src`)
        .mth(53, null, 'dport')
        .jmp(`DNAT --to-destination ${intf.ip_address}:${MASQ_PORT}`)
      const redirectUDP = redirectTCP.clone().pro('udp')
      await execAsync(redirectTCP.toCmd('-A'))
      await execAsync(redirectUDP.toCmd('-A'))
    }
  }

  async _add_ip6tables_rules() {
    const interfaces = sysManager.getMonitoringInterfaces();
    const NetworkProfile = require('../../net2/NetworkProfile.js');
    for (const intf of interfaces) {
      const uuid = intf.uuid;
      if (!uuid) {
        log.error(`uuid is not defined for ${intf.name}`);
        continue;
      }
      const ip6Addrs = intf.ip6_addresses;
      if (!ip6Addrs || ip6Addrs.length == 0) {
        log.info(`No ipv6 address is found on ${intf.name}`);
        continue;
      }
      await NetworkProfile.ensureCreateEnforcementEnv(uuid);
      const netSet = NetworkProfile.getNetIpsetName(uuid, 6);
      const ip6 = ip6Addrs.find(i => i.startsWith("fe80")) || ip6Addrs[0]; // prefer to use link local address as DNAT address
      const redirectTCP = new Rule('nat').fam(6).chn('FW_PREROUTING_DNS_DEFAULT').pro('tcp')
        .mdl("set", `--match-set ${netSet} src,src`)
        .mdl("set", `! --match-set ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} src,src`)
        .mth(53, null, 'dport')
        .jmp(`DNAT --to-destination [${ip6}]:${MASQ_PORT}`);
      const redirectUDP = redirectTCP.clone().pro('udp');
      await execAsync(redirectTCP.toCmd('-A'));
      await execAsync(redirectUDP.toCmd('-A'));
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

  onDHCPReservationChanged() {
    if (this.mode === Mode.MODE_DHCP ||
        this.mode === Mode.MODE_DHCP_SPOOF ||
        this.mode === Mode.MODE_ROUTER
    ) {
      this._scheduleWriteHostsFile();
      log.debug("DHCP reservation changed, set needWriteHostsFile file to true");
    }
  }

  onSpoofChanged() {
    if (this.mode === Mode.MODE_DHCP || this.mode === Mode.MODE_DHCP_SPOOF) {
      this._scheduleWriteHostsFile();
      log.debug("Spoof status changed, set needWriteHostsFile to true");
    }
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

    let hostsList = []

    for (const h of hosts) {
      const monitor = h.spoofing === 'true' ? 'monitor' : 'unmonitor';
      let reserved = false;
      for (const intf of sysManager.getMonitoringInterfaces()) {
        let reservedIp = null;
        if (h.intfIp && h.intfIp[intf.uuid]) {
          reservedIp = h.intfIp[intf.uuid].ipv4
        } else if (h.staticAltIp && (!monitor || this.mode == Mode.MODE_DHCP_SPOOF)) {
          reservedIp = h.staticAltIp
        } else if (h.staticSecIp && monitor && this.mode == Mode.MODE_DHCP) {
          reservedIp = h.staticSecIp
        }

        reservedIp = reservedIp ? reservedIp + ',' : ''
        if (reservedIp !== "") {
          hostsList.push(
            `${h.mac},set:${monitor},${reservedIp}${lease_time}`
          );
          reserved = true;
        }
      }
      if (!reserved) {
        hostsList.push(`${h.mac},set:${monitor},${lease_time}`);
      }
    }
    // remove duplicate items
    hostsList = hostsList.filter((v, i, a) => a.indexOf(v) === i);

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

    await fs.writeFileAsync(HOSTFILE_PATH, _hosts);
    log.info("Hosts file has been updated:", this.counter.writeHostsFile)

    return true;
  }

  async rawStart() {
    // use restart to ensure the latest configuration is loaded
    let cmd = `${dnsmasqBinary}.${f.getPlatform()} -k --clear-on-reload -u ${userID} -C ${configFile} -r ${resolvFile}`;

    cmd = await this.prepareDnsmasqCmd(cmd);

    this.writeStartScript(cmd);

    await this.writeHostsFile();

    this.scheduleRestartDNSService(true);
    if (DHCP_SERVICE_NAME !== SERVICE_NAME)
      this.scheduleRestartDHCPService(true);
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
      } catch (err) {
        log.error('Error when add iptables rules', err);
        await this._remove_all_iptables_rules();
        log.error("Dnsmasq start is aborted due to failed to add iptables rules");
        return;
      }
    }

    log.info("DNSMASQ is started successfully");
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
    for (const monitoringInterface of sysManager.getMonitoringInterfaces()) {
      if (!monitoringInterface || !monitoringInterface.ip_address)
        continue;
      const STATUS_CHECK_INTERFACE = monitoringInterface.ip_address;
      let resolved = false;
      for (const domain of VERIFICATION_DOMAINS) {
        // if there are 3 verification domains and each takes at most 6 seconds to fail the test, it will take 18 seconds to fail the test on one network interface
        let cmd = `dig -4 +short +time=3 +tries=2 -p ${MASQ_PORT} @${STATUS_CHECK_INTERFACE} ${domain}`;
        log.debug(`Verifying DNS resolution to ${domain} on ${STATUS_CHECK_INTERFACE} ...`);
        try {
          let { stdout, stderr } = await execAsync(cmd);
          if (stderr !== "" || stdout === "") {
            log.error(`Error verifying dns resolution to ${domain} on ${STATUS_CHECK_INTERFACE}`, stderr, stdout);
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
      if (resolved)
        continue;
      log.error(`Failed to resolve all domains on ${STATUS_CHECK_INTERFACE}.`);
      return false;
    }
    return true;
  }

  async dnsStatusCheck() {
    log.debug("Keep-alive checking dnsmasq status")
    let checkResult = await this.verifyDNSConnectivity();

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
      // simply removes dns redirect rules, no need to stop dns service
      await this._remove_all_iptables_rules();
      bone.logAsync("error", {
        type: 'DNSMASQ CRASH',
        msg: `dnsmasq failed to restart after ${this.failCount} retries`,
      });
    }
    this.scheduleRestartDNSService(true);
  }

  async cleanUpLeftoverConfig() {
    try {
      await fs.mkdirAsync(FILTER_DIR, { recursive: true, mode: 0o755 }).catch((err) => {
        if (err.code !== "EEXIST")
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
      log.info("clean up cleanUpLeftoverConfig");
      await rclient.delAsync('dnsmasq:conf');
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

  async checkConfsChange() {
    try {
      const dnsmasqConfKey = "dnsmasq:conf";
      let md5sumNow = '';
      for (const confs of [`${FILTER_DIR}*`, resolvFile, startScriptFile, configFile, HOSTFILE_PATH]) {
        const { stdout } = await execAsync(`find ${confs} -type f | sort | xargs cat | md5sum | awk '{print $1}'`);
        md5sumNow = md5sumNow + (stdout ? stdout.split('\n').join('') : '');
      }
      const md5sumBefore = await rclient.getAsync(dnsmasqConfKey);
      log.info(`dnsmasq confs md5sum, before: ${md5sumBefore} now: ${md5sumNow}`)
      if (md5sumNow != md5sumBefore) {
        await rclient.setAsync(dnsmasqConfKey, md5sumNow);
        return true;
      }
      return false;
    } catch (error) {
      log.info(`Get dnsmasq confs md5summ error`, error)
      return true;
    }
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
    for (const currentTxt of splited) {
      waitSearch.push(splited.join("."));
      splited.shift();
    }
    waitSearch.push(splited.join("."));
    const hashedDomains = flowUtil.hashHost(target, {keepOriginal: true});

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
            let content = await fs.readFileAsync(filePath, {encoding: 'utf8'});
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
};
