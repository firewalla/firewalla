
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
let fs = Promise.promisifyAll(require("fs"))

let dnsFilterDir = f.getUserConfigFolder() + "/dns";

let adblockFilterFile = dnsFilterDir + "/adblock_filter.conf";
let adblockTmpFilterFile = dnsFilterDir + "/adblock_filter.conf.tmp";

let policyFilterFile = dnsFilterDir + "/policy_filter.conf";
let familyFilterFile = dnsFilterDir + "/family_filter.conf";

let SysManager = require('../../net2/SysManager');
let sysManager = new SysManager();

let fConfig = require('../../net2/config.js').getConfig();

let bone = require("../../lib/Bone.js");

const iptables = require('../../net2/Iptables');
const ip6tables = require('../../net2/Ip6tables.js')

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let networkTool = require('../../net2/NetworkTool')();

let dnsmasqBinary = __dirname + "/dnsmasq";
let dnsmasqPIDFile = f.getRuntimeInfoFolder() + "/dnsmasq.pid";
let dnsmasqConfigFile = __dirname + "/dnsmasq.conf";

let dnsmasqResolvFile = f.getRuntimeInfoFolder() + "/dnsmasq.resolv.conf";

let defaultNameServers = {};
let upstreamDNS = null;

let dhcpFeature = false;

let FILTER_EXPIRE_TIME = 86400 * 1000;

let BLACK_HOLE_IP="198.51.100.99";

let DEFAULT_DNS_SERVER = (fConfig.dns && fConfig.dns.defaultDNSServer) || "8.8.8.8";

module.exports = class DNSMASQ {
  constructor(loglevel) {
    if (instance == null) {
      log = require("../../net2/logger.js")("dnsmasq", loglevel);

      instance = this;
      this.minReloadTime = new Date() / 1000;
      this.deleteInProgress = false;
      this.shouldStart = false;

      process.on('exit', () => {
        this.shouldStart = false;
        this.stop();
      });
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
    fs.writeFileSync(dnsmasqResolvFile, config);
    callback(null);
  }

  updateAdblockFilter(force, callback) {
    callback = callback || function() {}

    this.updateAdblockTmpFilter(force, (err, result) => {
      if(err) {
        callback(err);
        return;
      }

      if(result) {
        // need update
        log.debug("Adblock filter file is ", adblockFilterFile);
        log.debug("Adblock tmp filter file is ", adblockTmpFilterFile);
        fs.rename(adblockTmpFilterFile, adblockFilterFile, callback);
      } else {
        // no need to update
        callback(null);
      }
    });
  }

  cleanUpFilter(file) {
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

  cleanUpAdblockFilter() {
    return this.cleanUpFilter(adblockFilterFile);
  }

  cleanUpFamilyFilter() {
    return this.cleanUpFilter(familyFilterFile);
  }

  cleanUpPolicyFilter() {
    return this.cleanUpFilter(policyFilterFile);
  }

  addPolicyFilterEntry(domain) {
    let entry = util.format("address=/%s/%s\n", domain, BLACK_HOLE_IP)
    
    return async(() => {
      if(this.workingInProgress) {
        await (this.delay(1000))  // try again later
        return this.addPolicyFilterEntry(domain);
      }

      this.workingInProgress = true
      await (fs.appendFileAsync(policyFilterFile, entry))
      this.workingInProgress = false
    })().catch((err) => {
      this.workingInProgress = false
    })
  }

  removePolicyFilterEntry(domain) {
    let entry = util.format("address=/%s/%s", domain, BLACK_HOLE_IP);

    if(this.workingInProgress) {
        return this.delay(1000)  // try again later
          .then(() => {
            return this.removePolicyFilterEntry(domain);
          })
    }

    this.workingInProgress = true;

    return fs.readFileAsync(policyFilterFile, 'utf8')
      .then((data) => {

      let newData = data.split("\n")
        .filter((line) => line !== entry)
        .join("\n");

        return fs.writeFileAsync(policyFilterFile, newData)
          .then(() => {
            this.workingInProgress = false;
          }).catch((err) => {
            log.error("Failed to write policy data file:", err, {});
            this.workingInProgress = false; // make sure the flag is reset back
          });
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
    return new Promise(((resolve, reject) => {
      this.start(false, (err) => {
        if (err) {
          reject(err);
        }
        resolve();
      });
    }).bind(this)).catch((err) => {
      log.error("Got error when reloading dnsmasq:", err, {})
    });
  }

  updateAdblockTmpFilter(force, callback) {
    callback = callback || function() {}

    let mkdirp = require('mkdirp');
    mkdirp(dnsFilterDir, (err) => {

      if(err) {
        callback(err);
        return;
      }

      // Check if the filter file is older enough that needs to refresh
      fs.stat(adblockFilterFile, (err, stats) => {
        if (!err) { // already exists
          if(force == true ||
             (new Date() - stats.mtime) > FILTER_EXPIRE_TIME) {

            fs.stat(adblockTmpFilterFile, (err, stats) => {
              if(!err) {
                fs.unlinkSync(adblockTmpFilterFile);
              } else if(err.code !== "ENOENT") {
                // unexpected err
                callback(err);
                return;
              }

              this.loadFilterFromBone((err, hashes) => {
                if(err) {
                  callback(err);
                  return;
                }
                this.writeHashFilterFile(hashes, adblockTmpFilterFile, (err) => {
                  if(err) {
                    callback(err);
                  } else {
                    callback(null, 1);
                  }
                });
              });
            });
          } else {
            // nothing to update if tmp file is already updated recently
            callback(null, 0);
          }
        } else { // no such file, need to crate one
          this.loadFilterFromBone((err, hashes) => {
            if(err) {
              callback(err);
              return;
            }
            this.writeHashFilterFile(hashes, adblockTmpFilterFile, (err) => {
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

  loadFilterFromBone(callback) {
    callback = callback || function() {}

    bone.hashset("ads",(err,data)=>{
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

      await (require('../../control/Block.js').block(BLACK_HOLE_IP));
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

  writeHashFilterFile(hashes, file, callback) {
    callback = callback || function() {}


    let writer = fs.createWriteStream(file);

    hashes.forEach((hash) => {
      let line = util.format("hash-address=/%s/%s\n", hash.replace(/\//g, '.'), BLACK_HOLE_IP);
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

  rawStart(callback) {
    callback = callback || function() {}

    // use restart to ensure the latest configuration is loaded
    let cmd = `sudo ${dnsmasqBinary}.${f.getPlatform()} -k -x ${dnsmasqPIDFile} -u ${userID} -C ${dnsmasqConfigFile} -r ${dnsmasqResolvFile} --local-service`;

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
      }

      callback(err);
    })
  }

  rawRestart(callback) {
    callback = callback || function() {}

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

};
