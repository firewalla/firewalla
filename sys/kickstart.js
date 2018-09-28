#!/usr/bin/env node
'use strict';
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

/*
* Kickstart()
*
* Create default endpoints
* Create default group
*
* Launch camera app
*
* bonjour endpoint information
*
* name: 'Encipher:'+eptname
* type: 'http'
* port: '80'
* txt: {
  *         'gid':'group id',
  *         'er':'encrypted rendezvous key',
  *         'keyhint':'Please enter the CPU id of your device pasted on a sticker'.
  *      }
  *
  * setup redenzvous at rndezvous key
  * query every x min until group is none empty, or first invite
  */
  
  process.title = "FireKick";
  require('events').EventEmitter.prototype._maxListeners = 100;

  let log = require("../net2/logger.js")(__filename);
  
  let fs = require('fs');
  let cloud = require('../encipher');
  let program = require('commander');
  let storage = require('node-persist');
  let mathuuid = require('../lib/Math.uuid.js');
  let utils = require('../lib/utils.js');
  let uuid = require("uuid");
  let forever = require('forever-monitor');
  const rclient = require('../util/redis_manager.js').getRedisClient()
  let SSH = require('../extension/ssh/ssh.js');
  let ssh = new SSH('info');

  const platformLoader = require('../platform/PlatformLoader.js');
  const platform = platformLoader.getPlatform();

  let util = require('util');
  
  let f = require('../net2/Firewalla.js');
  
  let fConfig = require('../net2/config.js');
  
  let Promise = require('bluebird');
  
  const bone = require("../lib/Bone.js");

  let SysManager = require('../net2/SysManager.js');
  let sysManager = new SysManager();
  let firewallaConfig = require('../net2/config.js').getConfig();
  
  let InterfaceDiscoverSensor = require('../sensor/InterfaceDiscoverSensor');
  let interfaceDiscoverSensor = new InterfaceDiscoverSensor();

  const EptCloudExtension = require('../extension/ept/eptcloud.js');

  const fwDiag = require('../extension/install/diag.js');
  
  // let NmapSensor = require('../sensor/NmapSensor');
  // let nmapSensor = new NmapSensor();
  // nmapSensor.suppressAlarm = true;
  
  let FWInvitation = require('./invitation.js');

  const Diag = require('../extension/diag/app.js');

log.forceInfo("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");
log.forceInfo("FireKick Starting ");
log.forceInfo("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");
  
  function delay(t) {
    return new Promise(function(resolve) {
      setTimeout(resolve, t)
    });
  }
  
  (async() => {
    await sysManager.setConfig(firewallaConfig)
    await interfaceDiscoverSensor.run()
    // await (nmapSensor.checkAndRunOnce(true));
    // nmapSensor = null;
  })();
  
  const license = require('../util/license.js');
  
  program.version('0.0.2')
  .option('--config [config]', 'configuration file, default to ./config/default.config')
  .option('--admin_invite_timeout [admin_invite_timeout]', 'admin invite timeout');
  
  program.parse(process.argv);
  
  if (program.config == null) {
    log.info("config file is required");
    process.exit(1);
  }
  
  let _license = license.getLicenseSync();
  
  let configfile = fs.readFileSync(program.config, 'utf8');
  if (configfile == null) {
    log.info("Unable to read config file");
  }
  let config = JSON.parse(configfile);
  if (!config) {
    log.info("Error processing configuration information");
  }
  if (!config.controllers) {
    log.info("Controller missing from configuration file");
    process.exit(1);
  }
  
  let eptname = config.endpoint_name;
  if (config.endpoint_name != null) {
    eptname = config.endpoint_name;
  } else if (program.endpoint_name != null) {
    eptname = program.endpoint_name;
  }
  
  function getUserHome() {
    return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
  }
  
  let dbPath = getUserHome() + "/.encipher/db";
  let configPath = getUserHome() + "/.encipher";
  
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(configPath);
  }
  if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath);
  }
  
  let symmetrickey = generateEncryptionKey(_license);
  
  // start a diagnostic page for people to access during first binding process
  const diag = new Diag()
  diag.start()

  let eptcloud = new cloud(eptname, null);
  eptcloud.debug(false);
  let service = null;
  
  storage.initSync({
    'dir': dbPath
  });
  
  function pad(value, length) {
    return (value.toString().length < length) ? pad("0" + value, length) : value;
  }
  
  function generateEncryptionKey(license) {
    // when there is no local license file, use default one
    let userKey = (license != null ? (license.SUUID || license.DATA.SUUID) : "cybersecuritymadesimple");
    //  log.info(`User Key is: ${userKey}`);
    let seed = mathuuid.uuidshort(32 - userKey.length);
    
    return {
      'key': userKey + seed,
      'seed': seed,
      'userkey': userKey,
      'noLicenseMode': license == null,
      'license': license != null && license.UUID
    };
  }
  
  function initializeGroup(callback) {    
    let groupId = storage.getItemSync('groupId');
    if (groupId != null) {
      log.info("Found stored group x", groupId);
      callback(null, groupId);
      return;
    }
    
    log.info("Using identity:", eptcloud.eid);
    log.info("Creating new group ", config.service, config.endpoint_name);
    let meta = JSON.stringify({
      'type': config.serviceType,
      'member': config.memberType,
      'model': platform.getName()
    });
    eptcloud.eptcreateGroup(config.service, meta, config.endpoint_name, function (e, r) {
      log.info(r);
      if (e == null && r != null) {
        storage.setItemSync('groupId', r);
      }
      callback(e, r);
    });
  }
  
  
  function postAppLinked() {
    // When app is linked, to secure device, ssh password will be
    // automatically reset when boot up every time
    
    // only do this in production and always do after 15 seconds ...
    // the 15 seconds wait is for the process to wake up
    
    if(f.isProductionOrBeta() &&
    // resetPassword by default unless resetPassword flag is explictly set to false
    (typeof fConfig.resetPassword === 'undefined' ||
    fConfig.resetPassword === true)) {
      setTimeout(()=> {
        ssh.resetRandomPassword((err,password) => {
          if(err) {
            log.info("Failed to reset ssh password");
          } else {
            log.info("A new random SSH password is used!");
            sysManager.setSSHPassword(password);
          }
        });
      }, 15000);
    }
  }

  async function recordAllRegisteredClients(gid) {
    const groupInfo = eptcloud.groupCache[gid] && eptcloud.groupCache[gid].group

    if(!groupInfo) {
      return
    }

    const deviceEID = groupInfo.eid

    const clients = groupInfo.symmetricKeys.filter((client) => client.eid != deviceEID)

    const clientInfos = clients.map((client) => {
      return JSON.stringify({name: client.displayName, eid: client.eid})
    })

    const keyName = "sys:ept:members"

    let cmd = [keyName]

    cmd.push.apply(cmd, clientInfos)

    await rclient.delAsync(keyName)
    
    if(clientInfos.length > 0) {
      await rclient.saddAsync(cmd)  
    }
  }

  function inviteFirstAdmin(gid, callback) {
    log.forceInfo("Initializing first admin:", gid);

    eptcloud.groupFind(gid, (err, group)=> {
      if (err) {
        log.info("Error looking up group", err, err.stack, {});
        callback(err, false);
        return;
      }
      
      if (group == null) {
        callback("404", false);
        return;
      }
      
      if (group.symmetricKeys) {
        // number of key sym keys equals to number of members in this group
        // set this number to redis so that other js processes get this info
        let count = group.symmetricKeys.length;
        
        rclient.hset("sys:ept", "group_member_cnt", count);

        const eptCloudExtension = new EptCloudExtension(eptcloud, gid);
        eptCloudExtension.recordAllRegisteredClients(gid).catch((err) => {
          log.error("Failed to record registered clients, err:", err, {})
        });
        
        // new group without any apps bound;
        platform.turnOnPowerLED();

        fwDiag.submitInfo({
          event: "PAIRSTART",
          msg:"Pairing Ready"
        });

        if (count === 1) {
          let fwInvitation = new FWInvitation(eptcloud, gid, symmetrickey);
          fwInvitation.diag = diag
          
          let onSuccess = function(payload) {
            return (async() => {
              log.info("some license stuff on device:", payload, {});
              await rclient.hsetAsync("sys:ept", "group_member_cnt", count + 1)
              
              postAppLinked(); // app linked, do any post-link tasks
              callback(null, true);
              
              log.forceInfo("EXIT KICKSTART AFTER JOIN");
              platform.turnOffPowerLED();

              fwDiag.submitInfo({
                event: "PAIREND",
                msg: "Pairing Ended"
              });

              setTimeout(()=> {
                require('child_process').exec("sudo systemctl stop firekick"  , (err, out, code) => {
                });
              },20000);
            })();
          }
          
          let onTimeout = function() {
            callback("404", false);
            
            platform.turnOffPowerLED();

            fwDiag.submitInfo({
              event: "PAIREND",
              msg: "Pairing Ended"
            });

            log.forceInfo("EXIT KICKSTART AFTER TIMEOUT");
            require('child_process').exec("sleep 2; sudo systemctl stop firekick"  , (err, out, code) => {
            });
          }
          
          diag.expireDate = new Date() / 1000 + 3600
          fwInvitation.broadcast(onSuccess, onTimeout);
          
        } else {
          log.forceInfo(`Found existing group ${gid} with ${count} members`);
          
          postAppLinked(); // already linked
          
          // broadcast message should already be updated, a new encryption message should be used instead of default one
          if(symmetrickey.userkey === "cybersecuritymadesimple") {
            log.warn("Encryption key should NOT be default after app linked");
          }
          
          let fwInvitation = new FWInvitation(eptcloud, gid, symmetrickey);
          fwInvitation.diag = diag
          fwInvitation.totalTimeout = 60 * 10; // 10 mins only for additional binding
          fwInvitation.recordFirstBinding = false // don't record for additional binding
          
          let onSuccess = function(payload) {
            return (async() => {
              
              const eptCloudExtension = new EptCloudExtension(eptcloud, gid);
              await eptCloudExtension.job().catch((err) => {
                log.error("Failed to update group info, err:", err, {})
              });;

              await rclient.hsetAsync("sys:ept", "group_member_cnt", count + 1)
              
              log.forceInfo("EXIT KICKSTART AFTER JOIN");
              platform.turnOffPowerLED();

              fwDiag.submitInfo({
                event: "PAIREND",
                msg: "Pairing Ended"
              });

              require('child_process').exec("sudo systemctl stop firekick"  , (err, out, code) => {
              });
            })();
          }
          
          let onTimeout = function() {
            log.forceInfo("EXIT KICKSTART AFTER TIMEOUT");
            platform.turnOffPowerLED();

            fwDiag.submitInfo({
              event: "PAIREND",
              msg: "Pairing Ended"
            });

            require('child_process').exec("sleep 2; sudo systemctl stop firekick"  , (err, out, code) => {
            });
          }
          
          diag.expireDate = new Date() / 1000 + 600
          fwInvitation.broadcast(onSuccess, onTimeout);
          
          callback(null, true);
        }
      }
    });
  }


  function launchService2(gid,callback) {
    fs.writeFileSync('/home/pi/.firewalla/ui.conf',JSON.stringify({gid:gid}),'utf-8');
    
    // don't start bro until app is linked
    require('child_process').exec("sudo systemctl start brofish");
    require('child_process').exec("sudo systemctl enable brofish"); // even auto-start for future reboots
    
    // // start fire api
    // if (require('fs').existsSync("/tmp/FWPRODUCTION")) {
    //   require('child_process').exec("sudo systemctl start fireapi");
    // } else {
    //   if (fs.existsSync("/.dockerenv")) {
    //     require('child_process').exec("cd api; forever start -a --uid api bin/www");
    //   } else {
    //     require('child_process').exec("sudo systemctl start fireapi");
    //   }
    // }
  }
  
  function login() {
    eptcloud.eptlogin(config.appId, config.appSecret, null, config.endpoint_name, function (err, result) {
      if (err == null) {
        log.info("Cloud Logged In")

        diag.connected = true

        initializeGroup(function (err, gid) {
          let groupid = gid;
          if (gid) {
            // TODO: This should be the only code to update sys:ept to avoid race condition
            log.info("Storing Firewalla Cloud Token info to redis");
            // log.info("EID:", eptcloud.eid);
            // log.info("GID:", gid);
            // log.info("TOKEN:", eptcloud.token);
            rclient.hmset("sys:ept", {
              eid: eptcloud.eid,
              token: eptcloud.token,
              gid: gid
            }, (err, data) => {
              if (err) {
              }
              log.info("Set SYS:EPT", err, data, eptcloud.eid, eptcloud.token, gid);
            });
            
            inviteFirstAdmin(gid, function (err, status) {
              if (status) {
                launchService2(groupid, null);
              }
            });
          } else {
            process.exit();
          }
        });
      } else {
        log.info("Unable to login", err);
        process.exit();
      }
    });
  }
  
  eptcloud.loadKeys()
  .then(() => {
    log.info("Logging in cloud");
    login();
  })
  
  process.stdin.resume();
  
  function exitHandler(options, err) {
    if (err) log.info(err.stack);
    if (options.exit) process.exit();
  }
  
  //do something when app is closing
  process.on('exit', exitHandler.bind(null, {
    cleanup: true
  }));
  
  //catches ctrl+c event
  process.on('SIGINT', exitHandler.bind(null, {
    exit: true
}));

process.on('uncaughtException',(err)=>{
  log.info("################### CRASH #############");
  log.info("+-+-+-",err.message,err.stack);
  if (err && err.message && err.message.includes("Redis connection")) {
    return;
  }
  bone.log("error",{version:config.version,type:'FIREWALLA.KICKSTART.exception',msg:err.message,stack:err.stack},null);
  setTimeout(()=>{
    require('child_process').execSync("touch /home/pi/.firewalla/managed_reboot")
    process.exit(1);
  },1000*2);
});

process.on('unhandledRejection', (reason, p)=>{
  let msg = "Possibly Unhandled Rejection at: Promise " + p + " reason: "+ reason;
  log.warn('###### Unhandled Rejection',msg,reason.stack,{});
  bone.log("error",{version:config.version,type:'FIREWALLA.KICKSTART.unhandledRejection',msg:msg,stack:reason.stack},null);
  // setTimeout(()=>{
  //   require('child_process').execSync("touch /home/pi/.firewalla/managed_reboot")
  //   process.exit(1);
  // },1000*2);
});
