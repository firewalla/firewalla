/**
 * Created by Melvin Tu on 04/01/2017.
 */

'use strict';

let instance = null;
let log = null;

let fs = require('fs');
let util = require('util');
let key = require('../common/key.js');
let jsonfile = require('jsonfile');

let f = require('../../net2/Firewalla.js');
let fHome = f.getFirewallaHome();

let userID = f.getUserID();

let dnsFilterDir = f.getUserConfigFolder() + "/dns";
let filterFile = dnsFilterDir + "/hash_filter.conf";
let tmpFilterFile = dnsFilterDir + "/hash_filter.conf.tmp";

let SysManager = require('../../net2/SysManager');
let sysManager = new SysManager();

let bone = require("../../lib/Bone.js");

let dnsmasqBinary = __dirname + "/dnsmasq";
let dnsmasqPIDFile = f.getRuntimeInfoFolder() + "/dnsmasq.pid";
let dnsmasqConfigFile = __dirname + "/dnsmasq.conf";

let dnsmasqResolvFile = f.getRuntimeInfoFolder() + "/dnsmasq.resolv.conf";

let defaultNameServers = null;

let FILTER_EXPIRE_TIME = 86400 * 1000;

module.exports = class {
  constructor(loglevel) {
    if (instance == null) {
      log = require("../../net2/logger.js")("dnsmasq", loglevel);

      instance = this;
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

  updateResolvConf(callback) {
    callback = callback || function() {}
    
    var nameservers = defaultNameServers;
    if(!nameservers) {
      nameservers = sysManager.myDNS();
    }

    if(!nameservers) {
      nameservers = ["8.8.8.8"];  // use google dns by default, should not reach this code
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
        console.log("filterFile is ", filterFile);
        console.log("tmpFilterFile is ", tmpFilterFile);
        fs.rename(tmpFilterFile, filterFile, callback);      
      } else {
        // no need to update
        callback(null);
      }
    });
  }

  setDefaultNameServers(nameservers) {
    defaultNameServers = nameservers;
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

    log.info("Command to start dnsmasq: ", cmd);

    require('child_process').exec(cmd, (err, out, code) => {
      if (err) {
        log.error("DNSMASQ:START:Error", "Failed to start dnsmasq: " + err);
      } else {
        log.info("DNSMASQ:START:SUCCESS");
      }

      callback(err);
    })
  }

  rawStop(callback) {
    callback = callback || function() {}

    let cmd = util.format("cat %s | sudo xargs kill", dnsmasqPIDFile);
    log.info("Command to stop dnsmasq: ", cmd);

    require('child_process').exec(cmd, (err, out, code) => {
      if (err) {
        log.error("DNSMASQ:START:Error", "Failed to stop dnsmasq: " + err);
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
    // 1. update filter
    // 2. start dnsmasq service
    // 3. update iptables rule

    this.updateResolvConf((err) => {
      if(err) {
        callback(err);
        return;
      }
      
      this.updateFilter(force, (err) => {
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
              }
              callback(err);
            });
          });
        });
                     
      });
      
    });
  }

  stop(callback) {
    // 1. remove iptables rules
    // 2. stop service
    // optional to remove filter file

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

};
