
/**
 * Created by Melvin Tu on 04/01/2017.
 */

'use strict';

let instance = null;
let log = null;

let util = require('util');
let key = require('../common/key.js');
let jsonfile = require('jsonfile');

const spawn = require('child_process').spawn

let f = require('../../net2/Firewalla.js');
let fHome = f.getFirewallaHome();

let userID = f.getUserID();

let Promise = require('bluebird');

const rclient = require('../../util/redis_manager.js').getRedisClient()

let fs = Promise.promisifyAll(require("fs"))

const FILTER_DIR = f.getUserConfigFolder() + "/dns";

const FILTER_FILE = {
  adblock: FILTER_DIR + "/adblock_filter.conf",
  adblockTmp: FILTER_DIR + "/adblock_filter.conf.tmp",

  family: FILTER_DIR + "/family_filter.conf",
  familyTmp: FILTER_DIR + "/family_filter.conf.tmp",

  policy: FILTER_DIR + "/policy_filter.conf"
}

let policyFilterFile = FILTER_DIR + "/policy_filter.conf";
let familyFilterFile = FILTER_DIR + "/family_filter.conf";

let SysManager = require('../../net2/SysManager');
let sysManager = new SysManager();

let fConfig = require('../../net2/config.js').getConfig();

const bone = require("../../lib/Bone.js");

const iptables = require('../../net2/Iptables');
const ip6tables = require('../../net2/Ip6tables.js')

const exec = require('child-process-promise').exec
const async = require('asyncawait/async')
const await = require('asyncawait/await')

let networkTool = require('../../net2/NetworkTool')();

let dnsmasqBinary = __dirname + "/dnsmasq";
let dnsmasqPIDFile = f.getRuntimeInfoFolder() + "/dnsmasq.pid";
let dnsmasqConfigFile = __dirname + "/dnsmasq.conf";

let dnsmasqResolvFile = f.getRuntimeInfoFolder() + "/dnsmasq.resolv.conf"

let defaultNameServers = {};
let upstreamDNS = null;

let dhcpFeature = false;

let FILTER_EXPIRE_TIME = 86400 * 1000;

const BLACK_HOLE_IP = "198.51.100.99"
const BLUE_HOLE_IP = "198.51.100.100"

let DEFAULT_DNS_SERVER = (fConfig.dns && fConfig.dns.defaultDNSServer) || "8.8.8.8";

let RELOAD_INTERVAL = 3600 * 24 * 1000; // one day

let statusCheckTimer = null

module.exports = class DNSMASQ {
  constructor(loglevel) {
    if (instance == null) {
      log = require("../../net2/logger.js")("dnsmasq", loglevel);

      instance = this;
      this.minReloadTime = new Date() / 1000;
      this.deleteInProgress = false;
      this.shouldStart = false;
      this.needRestart = null
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

      process.on('exit', () => {
        this.shouldStart = false;
        this.stop();
      });

      setInterval(() => {
        this.checkIfRestartNeeded()
      }, 10 * 1000) // every 10 seconds
    }
    return instance;
  }

  install(callback) {
    callback = callback || function() {}

    let install_cmd = util.format('cd %s; bash ./install.sh', __dirname);
    require('child_process').exec(install_cmd, (err, out, code) => {
      if (err) {
        log.error("DNSMASQ:INSTALL:Error", "Failed to execute script install.sh", err);
      } else {
        log.info("DNSMASQ:INSTALL:Success", "Dnsmasq is installed successfully");
      }

      callback(err, null);
    });
  }

  uninstall(callback) {
    // TODO
  }

  // in format 127.0.0.1#5353
  setUpstreamDNS(dns) {
    if(dns === upstreamDNS) {
      log.info("upstreamdns is same as dns, ignored. (" + dns + ")");
      return;
    }

    log.info("upstream dns is set to", dns);
    upstreamDNS = dns;

    this.checkStatus((enabled) => {
      if(enabled) {
        this.start(false, (err) => {
          if(err) {
            log.error("Failed to restart dnsmasq to apply new upstream dns");
          } else {
            log.info("dnsmasq is restarted to apply new upstream dns");
          }
        });
      } else {
        // do nothing if it is not enabled
      }
    });
  }

  updateResolvConf(callback) {
    callback = callback || function() {}

    let nameservers = this.getAllDefaultNameServers()
    if(!nameservers || nameservers.length === 0) {
      nameservers = sysManager.myDNS();
    }

    if(!nameservers || nameservers.length === 0) {
      nameservers = [DEFAULT_DNS_SERVER];  // use google dns by default, should not reach this code
    }

    let entries = nameservers.map((nameserver) => "nameserver " + nameserver);
    let config = entries.join('\n');
    config += "\n";

    async(() => {
      await (fs.writeFileAsync(dnsmasqResolvFile, config))
      await (exec("pkill -SIGHUP dnsmasq").catch((err) => {
        // ignore error if dnsmasq not exists
      }))
      callback(null)
    })().catch((err) => {
      log.error("Got error when writing dnsmasq resolve file", err, {})
      callback(err)
    })    
  }

  updateFilter(type, force, callback) {
    callback = callback || function() {}

    this._updateTmpFilter(type, force, (err, result) => {
      if (err) {
        callback(err);
        return;
      }

      const filter = FILTER_FILE[type];
      const filterTmp = FILTER_FILE[type + 'Tmp'];

      if (result) {
        // need update
        log.debug(`${type} filter file is `, filter);
        log.debug(`${type} tmp filter file is `, filterTmp);
        fs.rename(filterTmp, filter, callback);
      } else {
        // no need to update
        callback(null);
      }
    });
  }

  _scheduleNextReload(type, oldNextState, curNextState) {
    if (oldNextState === curNextState) {
      // no need immediate reload when next state not changed during reloading
      this.nextReloadFilter[type].forEach(t => clearTimeout(t));
      this.nextReloadFilter[type].length = 0;
      log.info(`schedule next reload for ${type} in ${RELOAD_INTERVAL/1000}s`);
      this.nextReloadFilter[type].push(setTimeout(this._reloadFilter.bind(this), RELOAD_INTERVAL, type));
    } else {
      log.warn(`${type}'s next state changed from ${oldNextState} to ${curNextState} during reload, will reload again immediately`);
      setImmediate(this._reloadFilter.bind(this), type);
    }
  }
  _reloadFilter(type) {
    let preState = this.state[type];
    let nextState = this.nextState[type];
    this.state[type] = nextState;

    log.info(`in reloadFilter(${type}): preState: ${preState}, nextState: ${this.state[type]}, this.reloadCount: ${this.reloadCount[type]++}`);

    if (nextState === true) {
      log.info(`Start to update ${type} filters.`);
      this.updateFilter(type, true, (err) => {
        if (err) {
          log.error(`Update ${type} filters Failed!`, err, {});
        } else {
          log.info(`Update ${type} filters successful.`);
        }

        this.reload().finally(() => this._scheduleNextReload(type, nextState, this.nextState[type]));
      });
      
      
      
    } else {
      if (preState === false && nextState === false) {
        // disabled, no need do anything
        this._scheduleNextReload(type, nextState, this.nextState[type]);
        return;
      }

      log.info(`Start to clean up ${type} filters.`);
      this.cleanUpFilter(type)
        .catch(err => log.error(`Error when clean up ${type} filters`, err, {}))
        .then(() => this.reload().finally(() => this._scheduleNextReload(type, nextState, this.nextState[type])));
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
    setImmediate(this._reloadFilter.bind(this), type);
  }

  cleanUpFilter(type) {
    const file = FILTER_FILE[type];

    log.info("Clean up filter file:", file);
    return fs.unlinkAsync(file)
      .catch(err => {
        if (err) {
          if (err.code === 'ENOENT') {
            // ignore
            log.info(`Filter file '${file}' not exist, ignore`);
          } else {
            log.error(`Failed to remove filter file: '${file}'`, err, {})
          }
        }
      });
  }

  addPolicyFilterEntry(domain, options) {
    options = options || {}

    let entry = null
    
    if(options.use_blue_hole) {
      entry = util.format("address=/%s/%s\n", domain, BLUE_HOLE_IP)
    } else {
      entry = util.format("address=/%s/%s\n", domain, BLACK_HOLE_IP)
    }
    
    return async(() => {
      if(this.workingInProgress) {
        log.info("deferred due to dnsmasq is working in progress")
        await (this.delay(1000))  // try again later
        return this.addPolicyFilterEntry(domain);
      }

      this.workingInProgress = true
      await (fs.appendFileAsync(policyFilterFile, entry))
    })().catch((err) => {
      log.error("Failed to add policy filter entry", err, {})
    }).finally(() => {
      this.workingInProgress = false
    })
  }

  removePolicyFilterEntry(domain) {
    let entry = util.format("address=/%s/%s", domain, BLACK_HOLE_IP);

    return async(() => {
      if(this.workingInProgress) {
        log.info("deferred due to dnsmasq is working in progress")
        await(this.delay(1000))
        return this.removePolicyFilterEntry(domain);
      }

      this.workingInProgress = true;

      const data = await (fs.readFileAsync(policyFilterFile, 'utf8'))

      let newData = data.split("\n")
        .filter((line) => line !== entry)
        .join("\n")

      await (fs.writeFileAsync(policyFilterFile, newData))      

    })().catch((err) => {
      log.error("Failed to remove policy filter entry", err, {})
    }).finally(() => {
      this.workingInProgress = false
    })
  }

  addPolicyFilterEntries(domains) {
    let entries = domains.map((domain) => util.format("address=/%s/%s\n", domain, BLACK_HOLE_IP));
    let data = entries.join("");
    return fs.appendFileAsync(policyFilterFile, data);
  }

  setDefaultNameServers(key, nameservers) {
    defaultNameServers[key] = nameservers;
  }

  unsetDefaultNameServers(key) {
    delete defaultNameServers[key]
  }

  getAllDefaultNameServers() {
    let list = []
    for(let key in defaultNameServers) {
      let l = defaultNameServers[key]
      if(l.constructor.name === 'Array') {
        list.push.apply(list, l)
      }
    }

    return list
  }

  delay(t) {
    return new Promise(function(resolve) {
      setTimeout(resolve, t)
    });
  }

  reload() {
    log.info("Dnsmasq reloading.");
    let self = this
    return new Promise((resolve, reject) => {
      self.start(false, (err) => {
        if (err) {
          reject(err);
        }
        resolve();
      });
    }).then(() => {
      log.info("Dnsmasq reload complete.");
    }).catch((err) => {
      log.error("Got error when reloading dnsmasq:", err, {})
    });
  }
  
  _updateTmpFilter(type, force, callback) {
    callback = callback || function() {}

    let mkdirp = require('mkdirp');
    mkdirp(FILTER_DIR, (err) => {

      if(err) {
        callback(err);
        return;
      }

      const filterFile = FILTER_FILE[type];
      const filterFileTmp = FILTER_FILE[type + 'Tmp'];

      // Check if the filter file is older enough that needs to refresh
      fs.stat(filterFile, (err, stats) => {
        if (!err) { // already exists
          if(force === true ||
             (new Date() - stats.mtime) > FILTER_EXPIRE_TIME) {

            fs.stat(filterFileTmp, (err, stats) => {
              if(!err) {
                fs.unlinkSync(filterFileTmp);
              } else if(err.code !== "ENOENT") {
                // unexpected err
                callback(err);
                return;
              }

              this._loadFilterFromBone(type, (err, hashes) => {
                if(err) {
                  callback(err);
                  return;
                }

                this._writeHashFilterFile(type, hashes, filterFileTmp, (err) => {
                  if (err) {
                    callback(err);
                    return;
                  }
                  
                  this._writeHashIntoRedis(type, hashes)
                    .then(() => callback(null, 1))
                    .catch(err => {
                      log.error("Error when writing hashes into redis", err, {});
                      callback(err);
                    });
                });
              });
            });
          } else {
            // nothing to update if tmp file is already updated recently
            callback(null, 0);
          }
        } else { // no such file, need to crate one
          this._loadFilterFromBone(type, (err, hashes) => {
            if(err) {
              callback(err);
              return;
            }
            this._writeHashFilterFile(type, hashes, filterFileTmp, (err) => {
              if(err) {
                callback(err);
              } else {
                callback(null, 1);
              }
            });
          });
        }
      });
    });
  }

  _loadFilterFromBone(type, callback) {
    callback = callback || function() {}

    const name = f.isProduction() ? this.hashTypes[type] : this.hashTypes[type] + '-dev';

    log.info(`Load data set from bone: ${name}`);

    bone.hashset(name, (err,data) => {
      if(err) {
        callback(err);
      } else {
        let d = JSON.parse(data)
        callback(null, d);
      }
    });
  }

  _add_all_iptables_rules() {
    return async(() => {
      await (this._add_iptables_rules())
      await (this._add_ip6tables_rules())
    })()
  }
  
  _add_iptables_rules() {
    return async(() => {
      let subnets = await (networkTool.getLocalNetworkSubnets());
      let localIP = sysManager.myIp();
      let dns = `${localIP}:8853`;

      subnets.forEach(subnet => {
        await (iptables.dnsChangeAsync(subnet, dns, true));
      })
    })();
  }

  _add_ip6tables_rules() {
    return async(() => {
      let ipv6s = sysManager.myIp6();

      for(let index in ipv6s) {
        let ip6 = ipv6s[index]
        if(ip6.startsWith("fe80::")) {
          // use local link ipv6 for port forwarding, both ipv4 and v6 dns traffic should go through dnsmasq
          await (ip6tables.dnsRedirectAsync(ip6, 8853))
        }
      }
    })();
  }

  _remove_ip6tables_rules() {
    return async(() => {
      let ipv6s = sysManager.myIp6();

      for(let index in ipv6s) {
        let ip6 = ipv6s[index]
        if(ip6.startsWith("fe80:")) {
          // use local link ipv6 for port forwarding, both ipv4 and v6 dns traffic should go through dnsmasq
          await (ip6tables.dnsUnredirectAsync(ip6, 8853))
        }
      }
    })();
  }    

  add_iptables_rules(callback) {
    callback = callback || function() {}

    let dnses = sysManager.myDNS();
    let dnsString = dnses.join(" ");
    let localIP = sysManager.myIp();

    let rule = util.format("DNS_IPS=\"%s\" LOCAL_IP=%s bash %s", dnsString, localIP, require('path').resolve(__dirname, "add_iptables.template.sh"));
    log.info("Command to add iptables rules: ", rule);

    require('child_process').exec(rule, (err, out, code) => {
      if(err) {
        log.error("DNSMASQ:IPTABLES:Error", "Failed to add iptables rules: " + err);
        callback(err);
      } else {
        log.info("DNSMASQ:IPTABLES", "Iptables rules are added successfully");
        callback();
      }
    });
  }

  _remove_all_iptables_rules() {
    return async(() => {
      await (this._remove_iptables_rules())
      await (this._remove_ip6tables_rules())
    })()
  }
  
  _remove_iptables_rules() {
    return async(() => {
      let subnets = await (networkTool.getLocalNetworkSubnets());
      let localIP = sysManager.myIp();
      let dns = `${localIP}:8853`;

      subnets.forEach(subnet => {
        await (iptables.dnsChangeAsync(subnet, dns, false, true));
      })

      await (require('../../control/Block.js').unblock(BLACK_HOLE_IP));
    })();
  }

  remove_iptables_rules(callback) {
    callback = callback || function() {}

    let dnses = sysManager.myDNS();
    let dnsString = dnses.join(" ");
    let localIP = sysManager.myIp();

    let rule = util.format("DNS_IPS=\"%s\" LOCAL_IP=%s bash %s", dnsString, localIP, require('path').resolve(__dirname, "remove_iptables.template.sh"));

    require('child_process').exec(rule, (err, out, code) => {
      if(err) {
        log.error("DNSMASQ:IPTABLES:Error", "Failed to remove iptables rules: " + err);
        callback(err);
      } else {
        log.info("DNSMASQ:IPTABLES", "Iptables rules are removed successfully");
        callback();
      }
    });
  }
  
  _writeHashIntoRedis(type, hashes) {
    return async(() => {
      log.info(`Writing hash into redis for type: ${type}`);
      let key = `dns:hashset:${type}`;
      let jobs = hashes.map(hash => rclient.saddAsync(key, hash));
      await(Promise.all(jobs));
      let count = await(rclient.scardAsync(key));
      log.info(`Finished writing hash into redis for type: ${type}, count: ${count}`);
    })();
  }

  _writeHashFilterFile(type, hashes, file, callback) {
    callback = callback || function() {}
    
    let writer = fs.createWriteStream(file);

    let targetIP = BLACK_HOLE_IP

    if(type === "family") {
      targetIP = BLUE_HOLE_IP
    }

    hashes.forEach((hash) => {
      let line = util.format("hash-address=/%s/%s\n", hash.replace(/\//g, '.'), targetIP)
      writer.write(line);
    });

    writer.end((err) => {
      callback(err);
    });
  }


  checkStatus(callback) {
    callback = callback || function() {}

    let cmd = util.format("ps aux | grep %s | grep -v grep", dnsmasqBinary);
    log.info("Command to check dnsmasq: ", cmd);

    require('child_process').exec(cmd, (err, stdout, stderr) => {
      if(stdout !== "") {
        callback(true);
      } else {
        callback(false);
      }
    });
  }

  checkIfRestartNeeded() {
    const MINI_RESTART_INTERVAL = 10 // 10 seconds
    if(this.needRestart)
      log.info("need restart is", this.needRestart, {})
    if(this.shouldStart && this.needRestart && (new Date() / 1000 - this.needRestart) > MINI_RESTART_INTERVAL) {
      this.needRestart = null
      this.rawRestart((err) => {        
        if(err) {
          log.error("Failed to restart dnsmasq")
        } else {
          log.info("dnsmasq restarted")
        }
      }) // just restart to have new policy filters take effect
    }
  }

  rawStart(callback) {
    callback = callback || function() {}

    // use restart to ensure the latest configuration is loaded
    let cmd = `sudo ${dnsmasqBinary}.${f.getPlatform()} -k --clear-on-reload -x ${dnsmasqPIDFile} -u ${userID} -C ${dnsmasqConfigFile} -r ${dnsmasqResolvFile} --local-service`;

    if(upstreamDNS) {
      log.info("upstream server", upstreamDNS, "is specified");
      cmd = util.format("%s --server=%s --no-resolv", cmd, upstreamDNS);
    }

    if(dhcpFeature && (!sysManager.secondaryIpnet ||
      !sysManager.secondaryMask)) {
      log.warn("DHCPFeature is enabled but secondary network interface is not setup");
    }
    if(dhcpFeature &&
       sysManager.secondaryIpnet &&
       sysManager.secondaryMask) {
      log.info("DHCP feature is enabled");

      let rangeBegin = util.format("%s.50", sysManager.secondaryIpnet);
      let rangeEnd = util.format("%s.250", sysManager.secondaryIpnet);
      let routerIP = util.format("%s.1", sysManager.secondaryIpnet);

      cmd = util.format("%s --dhcp-range=%s,%s,%s,%s",
        cmd,
        rangeBegin,
        rangeEnd,
        sysManager.secondaryMask,
        fConfig.dhcp && fConfig.dhcp.leaseTime || "24h" // default 24 hours lease time
      );

      // By default, dnsmasq sends some standard options to DHCP clients,
      // the netmask and broadcast address are set to the same as the host running dnsmasq
      // and the DNS server and default route are set to the address of the machine running dnsmasq.
      cmd = util.format("%s --dhcp-option=3,%s", cmd, routerIP);

      sysManager.myDNS().forEach((dns) => {
        cmd = util.format("%s --dhcp-option=6,%s", cmd, dns);
      });
    }

    log.debug("Command to start dnsmasq: ", cmd);

    require('child_process').execSync("echo '"+cmd +" ' > /home/pi/firewalla/extension/dnsmasq/dnsmasq.sh");

    if(f.isDocker()) {

      try {
        require('child_process').execSync("sudo pkill dnsmasq")
      } catch(err) {
        // do nothing
      }
      
      const p = spawn('/bin/bash', ['-c', cmd])

      p.stdout.on('data', (data) => {
        log.info("DNSMASQ STDOUT:", data.toString(), {})
      })

      p.stderr.on('data', (data) => {
        log.info("DNSMASQ STDERR:", data.toString(), {})
      })

      // p.on('exit', (code, signal) => {
      //   if(code === 0) {
      //     log.info(`DNSMASQ exited with code ${code}, signal ${signal}`)
      //   } else {
      //     log.error(`DNSMASQ exited with code ${code}, signal ${signal}`)
      //   }

      //   if(this.shouldStart) {
      //     log.info("Restarting dnsmasq...")
      //     this.rawStart() // auto restart if failed unexpectedly
      //   }
      // })

      setTimeout(() => {
        callback(null)
      }, 1000)
    } else {
      try {
        require('child_process').execSync("sudo systemctl restart firemasq");
        if(!statusCheckTimer) {
          statusCheckTimer = setInterval(() => {
            this.statusCheck()
          }, 1000 * 60 * 1) // check status every minute
          log.info("Status check timer installed")
        }
      } catch(err) {
        log.error("Got error when restarting firemasq:", err, {})
      }
      callback(null)
    }


  }

  rawStop(callback) {
    callback = callback || function() {}

    let cmd = null;
    if(f.isDocker()) {
      cmd = util.format("(file %s &>/dev/null && (cat %s | sudo xargs kill)) || true", dnsmasqPIDFile, dnsmasqPIDFile);
    } else {
      cmd = "sudo service firemasq stop";
    }

    log.debug("Command to stop dnsmasq: ", cmd);

    require('child_process').exec(cmd, (err, out, code) => {
      if (err) {
        log.error("DNSMASQ:START:Error", "Failed to stop dnsmasq, error code: " + err);
      } else {
        if(statusCheckTimer) {
          clearInterval(statusCheckTimer)
          statusCheckTimer = null
          log.info("status check timer is stopped")
        }
      }

      callback(err);
    })
  }

  rawRestart(callback) {
    callback = callback || function() {}

    log.info("Restarting dnsmasq...")

    let cmd = "sudo systemctl restart firemasq";

    if(require('fs').existsSync("/.dockerenv")) {
      cmd = "sudo service dnsmasq restart";
    }

    require('child_process').exec(cmd, (err, out, code) => {
      if (err) {
        log.error("DNSMASQ:START:Error", "Failed to restart dnsmasq: " + err);
      }

      callback(err);
    })
  }

  start(force, callback) {
    callback = callback || function() {}

    // 0. update resolv.conf
    // 1. update filter (by default only update filter once per configured interval, unless force is true)
    // 2. start dnsmasq service
    // 3. update iptables rule
    log.info("Starting DNSMASQ...", {});

    this.shouldStart = false

    this.updateResolvConf((err) => {
      if(err) {
        callback(err);
        return;
      }

      this.rawStop((err) => {
        this.rawStart((err) => {
          if(err) {
            this.rawStop();
            callback(err);
            return;
          }

          this._add_all_iptables_rules()
          .then(() => {
            log.info("DNSMASQ is started successfully");
            this.shouldStart = true
            callback();
          }).catch((err) => {
            this.rawStop();
            this._remove_all_iptables_rules()
            .then(() => {
              callback(err);
            }).catch(() => {
              callback(err);
            })
          })
        });
      });
    });
  }

  stop(callback) {
    callback = callback || function() {}

    // 1. remove iptables rules
    // 2. stop service
    // optional to remove filter file

    this.shouldStart = false;

    log.info("Stopping DNSMASQ:", {});
    this._remove_all_iptables_rules()
    .then(() => {
      this.rawStop((err) => {
        callback(err);
      });
    })
  }

  restart(callback) {
    require('child_process').exec("sudo systemctl restart firemasq", (err, out, code) => {
      if(err) {
        log.error("DNSMASQ:RESTART:Error", "Failed to restart dnsmasq: " + err);
      }
      callback(err);
    });
  }

  enableDHCP() {
    dhcpFeature = true;
    return new Promise((resolve, reject) => {
      this.start(false, (err) => {
        log.info("Started DHCP")
        if(err) {
          log.error("Failed to restart dnsmasq when enabling DHCP: " + err);
          reject(err);
          return;
        }

        resolve();
      });
    });
  }

  disableDHCP() {
    dhcpFeature = false;
    return new Promise((resolve, reject) => {
      this.start(false, (err) => {
        if(err) {
          log.error("Failed to restart dnsmasq when enabling DHCP: " + err);
          reject(err);
          return;
        }

        resolve();
      });
    });
  }

  dhcp() {
    return dhcpFeature;
  }

  setDHCPFlag(flag) {
    dhcpFeature = flag;
  }

  verifyDNSConnectivity() {
    let cmd = `dig -4 +short -p 8853 @localhost www.google.com`
    log.info("Verifying DNS connectivity...")
    
    return async(() => {
      try {
        let result = await (exec(cmd))
        if(result.stdout === "") {
          log.error("Got empty dns result when verifying dns connectivity:", {})
          return false
        } else if(result.stderr !== "") {
          log.error("Got error output when verifying dns connectivity:", result.stderr, {})
          return false
        } else {
          log.info("DNS connectivity looks good")
          return true
        }
      } catch(err) {
        log.error("Got error when verifying dns connectivity:", err, {})
        return false
      }
    })()    
  }

  statusCheck() {
    return async(() => {
      log.info("Keep-alive checking dnsmasq status")
      let checkResult = await (this.verifyDNSConnectivity()) ||
        await (this.verifyDNSConnectivity()) ||
        await (this.verifyDNSConnectivity())
              
      if(!checkResult) {
        this.failCount++
        if(this.failCount > 5) {
          this.stop() // make sure iptables rules are also stopped..
          bone.log("error",{
            version: sysManager.version(),
            type:'DNSMASQ CRASH',
            msg:"dnsmasq failed to restart after 5 retries",
          },null);
        } else {
          let psResult = await (exec("ps aux | grep dns[m]asq"))
          let stdout = psResult.stdout
          log.info("dnsmasq running status: \n", stdout, {})
    
          // restart this service, something is wrong
          this.rawRestart((err) => {
            if(err) {
              log.error("Failed to restart dnsmasq:", err, {})
            }
          })
        }        
      } else {
        this.failCount = 0 // reset
      }
    })()
  }
};
