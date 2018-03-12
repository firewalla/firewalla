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

let instance = null;
let log = require("../../net2/logger.js")(__filename, "info");

let started = false;

let fs = require('fs');
let util = require('util');
let jsonfile = require('jsonfile');
const p = require('child_process');
const _async = require('async');

const async = require('asyncawait/async');
const await = require('asyncawait/await');

const exec = require('child-process-promise').exec

const rclient = require('../../util/redis_manager.js').getRedisClient()

let f = require('../../net2/Firewalla.js');
const fc = require('../../net2/config.js')
let fHome = f.getFirewallaHome();

let SysManager = require('../../net2/SysManager');
let sysManager = new SysManager();

let userID = f.getUserID();

var extend = require('util')._extend;

let extensionFolder = fHome + "/extension/ss_client";

// Files
let redirectionBinary = extensionFolder + "/fw_ss_redir";
let chinaDNSBinary = extensionFolder + "/chinadns";
const dnsForwarderName = "dns_forwarder"
const dnsForwarderBinary = `${extensionFolder}/${dnsForwarderName}`

if(f.isDocker()) {
  redirectionBinary = extensionFolder + "/bin.x86_64/fw_ss_redir";
  chinaDNSBinary = extensionFolder + "/bin.x86_64/chinadns";
}

let enableIptablesBinary = extensionFolder + "/add_iptables_template.sh";
let disableIptablesBinary = extensionFolder + "/remove_iptables_template.sh";

let chnrouteFile = extensionFolder + "/chnroute";
let chnrouteRestoreForIpset = extensionFolder + "/chnroute.ipset.save";

let ssConfigKey = "scisurf.config";
let ssConfigPath = f.getUserConfigFolder() + "/ss_client.config.json";
var ssConfig = null;

let localRedirectionPort = 8820;
let localRedirectionAddress = "0.0.0.0";
let chinaDNSPort = 8854;
let chinaDNSAddress = "127.0.0.1";
let redirectionPidPath = f.getRuntimeInfoFolder() + "/ss_client.redirection.pid";

const localDNSForwarderPort = 8857
const remoteDNS = "8.8.8.8"
const remoteDNSPort = "53"


let statusCheckTimer = null

function loadConfig(callback) {
  callback = callback || function() {}
  
  rclient.get(ssConfigKey, (err, result) => {
    if(err) {
      log.error("Failed to load ssconfig from redis: " + err);
      callback(err);
      return;
    }
    try {
      if(result) {
        ssConfig = JSON.parse(result);
        callback(null, ssConfig);
      } else {
        callback(null, null); // by default, {} => config not initliazed
      }
    } catch (e) {
      log.error("Failed to parse json: " + e);
      callback(e);
    }
  });
}

function clearConfig(callback) {
  callback = callback || function() {}

  rclient.del(ssConfigKey, (err) => {
    if(err) {
      log.error("Failed to clear ssconfig: " + err);
      callback(err);
      return;
    }

    ssConfig = null;
    try {
      fs.unlinkSync(ssConfigPath);
    } catch(err) {
      log.error(`Failed to remove file: ${ssConfigPath}, error: ${err}`)
    }
    callback(null);
  });
}

/*
 * 1. install
 * 2. prepare ipset
 * 3. setup dns forwarder
 * 4. setup redirection
 * 5. setup chinadns
 * 6. setup iptables
 */

function start(callback) {
  callback = callback || function() {}

  loadConfig((err, config) => {
    if(err) {
      log.error("Failed to load config");
      callback(err);
      return;
    }

    if(!config) {
      callback(new Error("ss not configured"));
      return;
    }

    saveConfigToFile();
    
    // always stop before start

    stop((err) => {

      // ignore stop error
      
      _install((err) => {
        if(err) {
          log.error("Fail to install ipset");
          callback(err);
          stop(); // stop everything if anything wrong.
          return;
        }
        
        _enableIpset((err) => {
          if(err) {
            _disableIpset();
            callback(err);
            stop(); // stop everything if anything wrong.
            return;
          }

          _startDNSForwarder((err) => {
            if(err) {
              callback(err);
              stop(); // stop everything if anything wrong.
              return;
            }

            _startRedirection((err) => {
              if(err) {
                callback(err);
                stop(); // stop everything if anything wrong.
                return;
              }
              
              _enableChinaDNS((err) => {
                if(err) {
                  callback(err);
                  stop(); // stop everything if anything wrong.
                  return;
                }
                
                _enableIptablesRule((err) => {
                  if(err) {
                    stop(); // stop everything if anything wrong.
                  } else {
                    if(!statusCheckTimer) {
                      statusCheckTimer = setInterval(() => {
                        statusCheck()
                      }, 1000 * 60) // check status every minute
                      log.info("Status check timer installed")
                    }
                    started = true;
                  }
                  callback(err);
                });
              });
            });
          });  
        });
      });      
    });
  });
}

function stop(callback) {
  callback = callback || function() {}

  log.info("Stopping everything on ss_client");

  if(statusCheckTimer) {
    clearInterval(statusCheckTimer)
    statusCheckTimer = null
    log.info("status check timer is stopped")
  }
  
  _async.applyEachSeries([ _disableIptablesRule,
                          _disableChinaDNS,
                          _stopRedirection,
                          _stopDNSForwarder,
                          _disableIpset],
                        (err) => {
                          if(err) {
                            log.error("Got error when stop: " + err);
                          }
                          started=false;
                          callback(err);
                        });
}

function _install(callback) {
  callback = callback || function() {}

  p.exec("bash -c 'sudo which ipset &>/dev/null || sudo apt-get install -y ipset'", callback);
}

function uninstall(callback) {
  // TODO
}

function saveConfigToFile() {
  if(!ssConfig.server_port)
    ssConfig.server_port = ssConfig.port
  
  if(!ssConfig.method) {
    ssConfig.method = "aes-256-cfb";
  }
  
  jsonfile.writeFileSync(ssConfigPath, ssConfig, {spaces: 2});
}

function saveConfig(config, callback) {
  rclient.set(ssConfigKey, JSON.stringify(config), (err) => {
    if(err) {
      callback(err);
      return;
    }
    
    ssConfig = config;
    saveConfigToFile();
    callback(null);
  });
}

function validateConfig(config) {
  // TODO
}

function _startDNSForwarder(callback) {
  callback = callback || function() {}

  let cmd = `${dnsForwarderBinary} -b 127.0.0.1 -p ${localDNSForwarderPort} -s ${remoteDNS}:${remoteDNSPort}`

  log.info("dns forwarder cmd:", cmd, {})

  let process = p.spawn(cmd, {shell: true})

  process.on('exit', (code, signal) => {
    if(code != 0) {
      log.error("dns forwarder exited with error:", code, signal, {})
    } else {
      log.info("dns forwarder exited successfully!")
    }
  })
  
  callback(null)  
}

function _stopDNSForwarder(callback) {
  callback = callback || function() {}

  let cmd = `pkill ${dnsForwarderName}`;

  p.exec(cmd, (err, stdout, stderr) => {
    if(err) {
      log.debug("Failed to kill dns forwarder:", err, {})
    } else {
      log.info("DNS Forwarder killed")
    }
    callback(err)
  })
}

function _startRedirection(callback) {
  callback = callback || function() {}

  let cmd = util.format("%s -c %s -l %d -f %s -b %s",
                        redirectionBinary,
                        ssConfigPath,
                        localRedirectionPort,
                        redirectionPidPath,
                        localRedirectionAddress);

  log.info("Running cmd:", cmd);
  // ss_redirection will put itself to background mode
  p.exec(cmd, (err, stdout, stderr) => {
    if(err) {
      log.error("Failed to start redirection: " + err);
    } else {
      log.info("Redirection is started successfully");
    }
    callback(err);
  });
}

function _stopRedirection(callback) {
  callback = callback || function() {}

  let cmd = "pkill fw_ss_redir";
  log.info("Running cmd:", cmd);
  p.exec(cmd, (err, stdout, stderr) => {
    if(err) {      
      log.error("Failed to stop redirection: " + stderr);
    } else {
      log.info("redirection is stopped successfully");
    }
  });
  callback(null);
}

function _enableIpset(callback) {
  callback = callback || function() {}
  
  let cmd = "sudo ipset -! restore -file " + chnrouteRestoreForIpset;
  log.info("Running cmd:", cmd);
  p.exec(cmd, (err, stdout, stderr) => {
    if(err) {
      log.error("Failed to restore ipset data for chnroute: " + stderr);
    } else {
      log.info("ipset data is restored successfully");
    }
    callback(err);
  });
}

function _disableIpset(callback) {
  callback = callback || function() {}

  let cmd = "sudo ipset destroy chnroute";
  log.info("Running cmd:", cmd);
  p.exec(cmd, (err, stdout, stderr) => {
    if(err) {
      log.error("Failed to remove ipset data for chnroute: " + stderr);
    } else {
      log.info("ipset data is removed successfully");
    }
    callback(null);
  });
}

function _enableIptablesRule(callback) {
  callback = callback || function() {}

  let cmd = util.format("FW_SS_SERVER=%s FW_SS_LOCAL_PORT=%s FW_REMOTE_DNS=%s FW_REMOTE_DNS_PORT=%s %s",
                        ssConfig.server,
                        localRedirectionPort,
                        remoteDNS,
                        remoteDNSPort,
                        enableIptablesBinary);

  log.info("Running cmd:", cmd);
  p.exec(cmd, (err, stdout, stderr) => {
    if(err) {
      log.error("Failed to enable iptables rules: " + stderr);
    } else {
      log.info("iptables rules are updated successfully");
    }
    callback(err);
  });
}

function _disableIptablesRule(callback) {
  callback = callback || function() {}

  let cmd = disableIptablesBinary;

  log.info("Running cmd:", cmd);
  p.exec(cmd, (err, stdout, stderr) => {
    if(err) {
      log.error("Failed to disable iptables rules: " + stderr);
    } else {
      log.info("iptables rules are removed successfully");
    }
    callback(null);
  });
}

function _enableChinaDNS(callback) {
  callback = callback || function() {}


  let localDNSServers = sysManager.myDNS();
  if(localDNSServers == null || localDNSServers.length == 0) {
    // only use 114 dns server if local dns server is not available (NOT LIKELY)
    localDNSServers = ["114.114.114.114"];
  }

  let dnsConfig = util.format("%s,%s:%d",
                              localDNSServers[0],
                              "127.0.0.1",
                              localDNSForwarderPort
                             )
  
  let args = util.format("-m -c %s -p %d -s %s", chnrouteFile, chinaDNSPort, dnsConfig);

  log.info("Running cmd:", chinaDNSBinary, args);

  let chinadns = p.spawn(chinaDNSBinary, args.split(" "), {detached:true});

  chinadns.on('close', (code) => {
    log.info("chinadns exited with code", code);
  });
  
  callback(null);
}

function _disableChinaDNS(callback) {
  callback = callback || function() {}

  let cmd = util.format("pkill chinadns");

  p.exec(cmd, (err, stdout, stderr) => {
    if(err) {
      log.error("Failed to disable chinadns");
    } else {
      log.info("chinadns is stopped successfully");
    }
    callback(null);
  });
}

function isStarted() {
  return started;
}

function readConfig() {
  try {
    let config = jsonfile.readFileSync(ssConfigPath);
    return config;
  } catch (err) {
    return null;
  }
}

function configExists() {
  return readConfig() !== null;
}

function getChinaDNS() {
  return chinaDNSAddress + "#" + chinaDNSPort;
}

function statusCheck() {
  return async(() => {
    let checkResult = await (verifyDNSConnectivity()) ||
      await (verifyDNSConnectivity()) ||
      await (verifyDNSConnectivity())
            
    if(!checkResult) {
      let psResult = await (exec("ps aux | grep ss"))
      let stdout = psResult.stdout
      log.info("ss client running status: \n", stdout, {})

      // restart this service, something is wrong
      start((err) => {
        if(err) {
          log.error("Failed to restart ss_client:", err, {})
        }
      })
    }
  })()
}

function verifyDNSConnectivity() {
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

module.exports = {
  start:start,
  stop:stop,
  saveConfig:saveConfig,
  isStarted:isStarted,
  configExists:configExists,
  getChinaDNS:getChinaDNS,
  loadConfig:loadConfig,
  clearConfig:clearConfig
};
