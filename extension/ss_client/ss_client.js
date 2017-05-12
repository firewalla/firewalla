/**
 * Created by Melvin Tu on 14/03/2017.
 * To manage shadowsocks client
 */

'use strict';

let instance = null;
let log = require("../../net2/logger.js")(__filename, "info");

let started = false;

let fs = require('fs');
let util = require('util');
let jsonfile = require('jsonfile');
let p = require('child_process');
let async = require('async');

let r = require('redis');
let rclient = r.createClient();

let f = require('../../net2/Firewalla.js');
let fHome = f.getFirewallaHome();

let SysManager = require('../../net2/SysManager');
let sysManager = new SysManager();

let userID = f.getUserID();

var extend = require('util')._extend;

let extensionFolder = fHome + "/extension/ss_client";

// Files
let tunnelBinary = extensionFolder + "/fw_ss_tunnel";
let redirectionBinary = extensionFolder + "/fw_ss_redir";
let enableIptablesBinary = extensionFolder + "/add_iptables_template.sh";
let disableIptablesBinary = extensionFolder + "/remove_iptables_template.sh";
let chinaDNSBinary = extensionFolder + "/chinadns";
let kcpBinary = extensionFolder + "/kcp_client";

let chnrouteFile = extensionFolder + "/chnroute";
let chnrouteRestoreForIpset = extensionFolder + "/chnroute.ipset.save";

let ssConfigKey = "scisurf.config";
let ssConfigPath = f.getUserConfigFolder() + "/ss_client.config.json";
let ssForKCPConfigPath = f.getUserConfigFolder() + "/ss_client.kcp.config.json";
var ssConfig = null;

let localKCPTunnelPort = 8856;
let localKCPTunnelAddress = "127.0.0.1";
let kcpParameters = "-mtu 1400 -sndwnd 256 -rcvwnd 2048 -mode fast2 -dscp 46";
let localTunnelPort = 8855;
let localTunnelAddress = "127.0.0.1";
let localRedirectionPort = 8820;
let localRedirectionAddress = "0.0.0.0";
let chinaDNSPort = 8854;
let chinaDNSAddress = "127.0.0.1";
let tunnelPidPath = f.getRuntimeInfoFolder() + "/ss_client.tunnel.pid";
let redirectionPidPath = f.getRuntimeInfoFolder() + "/ss_client.redirection.pid";
let dnsServerWithPort = "8.8.8.8:53";

let kcpLog = f.getLogFolder() + "/kcp.log";

function isKCPEnabled() {
  return ssConfig && ssConfig.kcp_enabled != null;
}

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
        callback(null, {}); // by default, {} => config not initliazed
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
    fs.unlinkSync(ssConfigPath);
    callback(null);
  });
}

/*
 * 1. install
 * 2. prepare ipset
 * 3. setup tunnel
 * 4. setup redirection
 * 5. setup chinadns
 * 6. setup iptables
 */

function start(callback) {
  callback = callback || function() {}

  loadConfig((err, config) => {
    if(err) {
      log.error("Failed to load config or config does NOT exist");
      callback(err);
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

          _startTunnel((err) => {
            if(err) {
              callback(err);
              stop(); // stop everything if anything wrong.
              return;
            }

            if(isKCPEnabled()) {
              _startKCP((err) => {
                if(err) {
                  callback(err);
                  stop(); // stop everything if anything wrong
                  return;
                }                
                _startRedirectionForKCP((err) => {
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
                        started = true;
                      }
                      callback(err);
                    });
                  });
                });
              });
            } else {
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
                      started = true;
                    }
                    callback(err);
                  });
                });
              });
            }  
          });
        });
      });      
    });
  });
}

function stop(callback) {
  callback = callback || function() {}

  async.applyEachSeries([ _disableIptablesRule,
                          _disableChinaDNS,
                          _stopRedirection,
                          _stopKCP,
                          _stopTunnel,
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
  jsonfile.writeFileSync(ssConfigPath, ssConfig, {spaces: 2});
  
  if(ssConfig.kcp_server && ssConfig.kcp_server_port) {
    let ssKCPConfig = extend({}, ssConfig);
    ssKCPConfig.server = localKCPTunnelAddress;
    ssKCPConfig.server_port = localKCPTunnelPort;
    jsonfile.writeFileSync(ssForKCPConfigPath, ssKCPConfig, {spaces: 2});
  }   
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

function _startTunnel(callback) {
  callback = callback || function() {}

  let cmd = util.format("%s -c %s -u -l %d -f %s -L %s -b %s",
                        tunnelBinary,
                        ssConfigPath,
                        localTunnelPort,
                        tunnelPidPath,
                        dnsServerWithPort,
                        localTunnelAddress);

  log.info("Running cmd:", cmd);
  // ss_tunnel will put itself to background mode
  p.exec(cmd, (err, stdout, stderr) => {
    if(err) {
      log.error("Fail to start tunnel: " + err);
    } else {
      log.info("tunnel is started successfully");
    }
    callback(err);
  });
}

function _stopTunnel(callback) {
  callback = callback || function() {}

  let cmd = util.format("pkill fw_ss_tunnel");

  log.info("Running cmd:", cmd);
  p.exec(cmd, (err, stdout, stderr) => {
    if(err) {
      log.error("Got error to stop tunnel: " + stderr);
    } else {
      log.info("tunnel is stopped successfully");
    }
  });

  callback(null);
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

function _startRedirectionForKCP(callback) {
  callback = callback || function() {}

  let cmd = util.format("%s -c %s -l %d -f %s -b %s",
                        redirectionBinary,
                        ssForKCPConfigPath,
                        localRedirectionPort,
                        redirectionPidPath,
                        localRedirectionAddress);

  log.info("Running cmd:", cmd);
  // ss_redirection will put itself to background mode
  p.exec(cmd, (err, stdout, stderr) => {
    if(err) {
      log.error("Failed to start redirection for kcp: " + err);
    } else {
      log.info("Redirection for kcp is started successfully");
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

function _startKCP(callback) {
  callback = callback || function() {}

  let remoteKCPServer = ssConfig.kcp_server;
  let remoteKCPPort = ssConfig.kcp_server_port;

  if(!remoteKCPServer || !remoteKCPPort) {
    callback(new Error("KCP server and port configuration is required"));
    return;
  }

  let args = util.format("%s --remoteaddr %s:%d --localaddr %s:%d --log %s",
                         kcpParameters,
                         remoteKCPServer,
                         remoteKCPPort,
                         localKCPTunnelAddress,
                         localKCPTunnelPort,
                         kcpLog
                        );
  
  log.info("Running cmd:", kcpBinary, args);

  let kcp = p.spawn(kcpBinary, args.split(" "), {detached: true});

  let callbacked = false;
  
  kcp.on('close', (code) => {
    if(!callbacked && code !== 0) {
      callback(new Error("kcp exited with code " + code));
      callbacked = true;
    }
    log.info("kcp exited with code", code);
  });

  setTimeout(() => {
    if(!callbacked) {
      callback(null);
      callbacked = true;
    }
  }, 1000);
}

function _stopKCP(callback) {
  callback = callback || function() {}

  let cmd = "pkill kcp_client";
  log.info("Running cmd:", cmd);

  p.exec(cmd, (err, stdout, stderr) => {
    if(err) {
      log.error("Failed to stop KCP");
    } else {
      log.info("KCP is stopped successfully");
    }
    callback(null);
  });

}

function _enableIpset(callback) {
  callback = callback || function() {}
  
  let cmd = "sudo ipset restore -file " + chnrouteRestoreForIpset;
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

  let cmd = util.format("FW_SS_SERVER=%s FW_SS_LOCAL_PORT=%s %s",
                        ssConfig.server,
                        localRedirectionPort,
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

  let cmd = util.format("FW_SS_SERVER=%s FW_SS_LOCAL_PORT=%s %s",
                        ssConfig.server,
                        localRedirectionPort,
                        disableIptablesBinary);

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
                              localTunnelAddress,
                              localTunnelPort);

  
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
