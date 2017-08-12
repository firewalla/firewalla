/**
 * Created by Melvin Tu on 04/01/2017.
 */

'use strict';

let instance = null;
let log = null;

let util = require('util');
let key = require('../common/key.js');
let jsonfile = require('jsonfile');

let f = require('../../net2/Firewalla.js');
let fHome = f.getFirewallaHome();

let userID = f.getUserID();

let Promise = require('bluebird');
let fs = Promise.promisifyAll(require("fs"))

let dnsFilterDir = f.getUserConfigFolder() + "/dns";
let filterFile = dnsFilterDir + "/hash_filter.conf";
let tmpFilterFile = dnsFilterDir + "/hash_filter.conf.tmp";

let policyFilterFile = dnsFilterDir + "/policy_filter.conf";
let adBlockFilterFile = dnsFilterDir + "/adblock_filter.conf";
let familyFilterFile = dnsFilterDir + "/family_filter.conf";

let SysManager = require('../../net2/SysManager');
let sysManager = new SysManager();

let fConfig = require('../../net2/config.js').getConfig();

let bone = require("../../lib/Bone.js");

let dnsmasqBinary = __dirname + "/dnsmasq";
let dnsmasqPIDFile = f.getRuntimeInfoFolder() + "/dnsmasq.pid";
let dnsmasqConfigFile = __dirname + "/dnsmasq.conf";

let dnsmasqResolvFile = f.getRuntimeInfoFolder() + "/dnsmasq.resolv.conf";

let defaultNameServers = null;
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
    
    var nameservers = defaultNameServers;
    if(!nameservers) {
      nameservers = sysManager.myDNS();
    }

    if(!nameservers || nameservers.length === 0) {
      nameservers = [DEFAULT_DNS_SERVER];  // use google dns by default, should not reach this code
    }
    
    let entries = nameservers.map((nameserver) => "nameserver " + nameserver);
    let config = entries.join('\n');
    fs.writeFileSync(dnsmasqResolvFile, config);
    callback(null);
  }
  
  updateFilter(force, callback) {
    callback = callback || function() {}

    this.updateTmpFilter(force, (err, result) => {
      if(err) {
        callback(err);
        return;
      }

      if(result) {
        // need update
        log.debug("filterFile is ", filterFile);
        log.debug("tmpFilterFile is ", tmpFilterFile);
        fs.rename(tmpFilterFile, filterFile, callback);      
      } else {
        // no need to update
        callback(null);
      }
    });
  }
  
  cleanUpADBlockFilter() {
    return fs.unlinkAsync(adBlockFilterFile);
  }
  
  cleanUpFamilyFilter() {
    return fs.unlinkAsync(familyFilterFile);
  }
  
  cleanUpPolicyFilter() {
    return fs.unlinkAsync(policyFilterFile);
  }
  
  addPolicyFilterEntry(domain) {
    let entry = util.format("address=/%s/%s\n", domain, BLACK_HOLE_IP);
    
    return fs.appendFileAsync(policyFilterFile, entry);
  }
  
  removePolicyFilterEntry(domain) {
    let entry = util.format("address=/%s/%s", domain, BLACK_HOLE_IP);
    
    if(this.deleteInProgress) {
        return this.delay(1000)  // try again later
          .then(() => {
            return this.removePolicyFilterEntry(domain);
          })
    }
    
    this.deleteInProgress = true;
    
    return fs.readFileAsync(policyFilterFile, 'utf8')
      .then((data) => {
      
      let newData = data.split("\n")
        .filter((line) => line !== entry)
        .join("\n");

        return fs.writeFileAsync(policyFilterFile, newData)
          .then(() => {
            this.deleteInProgress = false;
          }).catch((err) => {
            log.error("Failed to write policy data file:", err, {});
            this.deleteInProgress = false; // make sure the flag is reset back
          });
      })
  }
  
  addPolicyFilterEntries(domains) {
    let entries = domains.map((domain) => util.format("address=/%s/%s\n", domain, BLACK_HOLE_IP));
    let data = entries.join("");
    return fs.appendFileAsync(policyFilterFile, data);
  }

  setDefaultNameServers(nameservers) {
    defaultNameServers = nameservers;
  }

  delay(t) {
    return new Promise(function(resolve) {
      setTimeout(resolve, t)
    });
  }
  
  reload() {
    return new Promise((resolve, reject) => {
      this.start(false, (err) => {
        if (err)
          reject(err);
        resolve();
      });
    }).bind(this);
  }
  
  updateTmpFilter(force, callback) {
    callback = callback || function() {}

    let mkdirp = require('mkdirp');
    mkdirp(dnsFilterDir, (err) => {
      
      if(err) {
        callback(err);
        return;
      }      

      // Check if the filter file is older enough that needs to refresh
      fs.stat(filterFile, (err, stats) => {
        if (!err) { // already exists
          if(force == true ||
             (new Date() - stats.mtime) > FILTER_EXPIRE_TIME) {

            fs.stat(tmpFilterFile, (err, stats) => {
              if(!err) {
                fs.unlinkSync(tmpFilterFile);
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
                this.writeHashFilterFile(hashes, tmpFilterFile, (err) => {
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
            this.writeHashFilterFile(hashes, tmpFilterFile, (err) => {
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

    bone.hashset("ad_cn",(err,data)=>{
      if(err) {
        callback(err);
      } else {
        let d = JSON.parse(data)
        callback(null, d);
      }
    });
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
      let line = util.format("hash-address=/%s/198.51.100.99\n", hash.replace(/\//g, '.'));
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
    let cmd = util.format("sudo %s.$(uname -m) -x %s -u %s -C %s -r %s --local-service", dnsmasqBinary, dnsmasqPIDFile, userID, dnsmasqConfigFile, dnsmasqResolvFile);

    if(upstreamDNS) {
      log.info("upstream server", upstreamDNS, "is specified");
      cmd = util.format("%s --server=%s", cmd, upstreamDNS);
    }

    if(dhcpFeature && (!sysManager.secondaryIpnet ||
      !sysManager.secondaryMask)) {
      log.warn("DHCPFeature is enabled but secondary network interface is not setup");
    }
    if(dhcpFeature &&
       sysManager.secondaryIpnet &&
       sysManager.secondaryMask) {
      log.info("DHCP feature is enabled");

      let rangeBegin = util.format("%s.10", sysManager.secondaryIpnet);
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

    require('child_process').exec(cmd, (err, out, code) => {
      if (err) {
        log.error("DNSMASQ:START:Error", "Failed to start dnsmasq: " + err, {});
      } else {
        log.info("DNSMASQ:START:SUCCESS", {});
      }

      callback(err);
    })
  }

  rawStop(callback) {
    callback = callback || function() {}

    let cmd = util.format("(file %s &>/dev/null && (cat %s | sudo xargs kill)) || true", dnsmasqPIDFile, dnsmasqPIDFile);
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

    let cmd = "sudo systemctl restart dnsmasq";

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
    // 0. update resolv.conf
    // 1. update filter (by default only update filter once per configured interval, unless force is true)
    // 2. start dnsmasq service
    // 3. update iptables rule
    log.info("Starting DNSMASQ...", {});

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

          this.add_iptables_rules((err) => {
            if(err) {
              this.rawStop();
              this.remove_iptables_rules();
            } else {
              log.info("DNSMASQ is started successfully");
            }
            callback(err);
          });
        });
      });
    });
  }

  stop(callback) {
    // 1. remove iptables rules
    // 2. stop service
    // optional to remove filter file

    log.info("Stopping DNSMASQ:", {});
    this.remove_iptables_rules((err) => {
      this.rawStop((err) => {
        callback(err);
        }
      );
    })
  }

  restart(callback) {
    require('child_process').exec("sudo systemctl restart dnsmasq", (err, out, code) => {
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
