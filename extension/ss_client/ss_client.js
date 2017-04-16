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

let f = require('../../net2/Firewalla.js');
let fHome = f.getFirewallaHome();

let SysManager = require('../../net2/SysManager');
let sysManager = new SysManager();

let userID = f.getUserID();

let extensionFolder = fHome + "/extension/ss_client";

// Files
let tunnelBinary = extensionFolder + "/fw_ss_tunnel";
let redirectionBinary = extensionFolder + "/fw_ss_redir";
let enableIptablesBinary = extensionFolder + "/add_iptables_template.sh";
let disableIptablesBinary = extensionFolder + "/remove_iptables_template.sh";
let chinaDNSBinary = extensionFolder + "/chinadns";

let chnrouteFile = extensionFolder + "/chnroute";
let chnrouteRestoreForIpset = extensionFolder + "/chnroute.ipset.save";

let ssConfigPath = f.getUserConfigFolder() + "/ss_client.config.json";
let ssConfig = jsonfile.readFileSync(ssConfigPath);

let localTunnelPort = 8855;
let localTunnelAddress = "127.0.0.1";
let localRedirectionPort = 8820;
let localRedirectionAddress = "0.0.0.0";
let chinaDNSPort = 8854;
let chinaDNSAddress = "127.0.0.1";
let tunnelPidPath = f.getRuntimeInfoFolder() + "/ss_client.tunnel.pid";
let redirectionPidPath = f.getRuntimeInfoFolder() + "/ss_client.redirection.pid";
let dnsServerWithPort = "8.8.8.8:53";



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

  _install((err) => {
    _enableIpset((err) => {
      if(err) {
        _disableIpset();
        callback(err);
        return;
      }

      _startTunnel((err) => {
        if(err) {
          callback(err);
          return;
        }

        _startRedirection((err) => {
          if(err) {
            callback(err);
            return;
          }

          _enableChinaDNS((err) => {
            if(err) {
              callback(err);
              return;
            }

            _enableIptablesRule((err) => {
              if(err) {
              } else {
                started = true;
              }
              callback(err);
            });
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

  p.exec("sudo which ipset &>/dev/null || sudo apt-get install -y ipset", callback);
}

function uninstall(callback) {
  // TODO
}

function setConfig(config) {
  ssConfig = config;
  jsonfile.writeFileSync(ssConfigPath, ssConfig, {spaces: 2});
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
      log.error("Fail to start tunnel");
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
      log.error("Failed to start redirection");
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
//  if(localDNSServers == null || localDNSServers.length == 0) {
    localDNSServers = ["114.114.114.114"];
//  }

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
  setConfig:setConfig,
  isStarted:isStarted,
  configExists:configExists,
  getChinaDNS:getChinaDNS
};
