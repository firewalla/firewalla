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

const log = require("../net2/logger.js")(__filename);

const fs = require('fs');
const cp = require('child_process');
const exec = require('child-process-promise').exec;
const cloud = require('../encipher');
const program = require('commander');
const storage = require('node-persist');
const mathuuid = require('../lib/Math.uuid.js');
const rclient = require('../util/redis_manager.js').getRedisClient()
const SSH = require('../extension/ssh/ssh.js');
const ssh = new SSH('info');

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const util = require('util');
const writeFileAsync = util.promisify(fs.writeFile);

const f = require('../net2/Firewalla.js');

const fConfig = require('../net2/config.js');

const bone = require("../lib/Bone.js");

const SysManager = require('../net2/SysManager.js');
const sysManager = new SysManager();
const firewallaConfig = require('../net2/config.js').getConfig();

const InterfaceDiscoverSensor = require('../sensor/InterfaceDiscoverSensor');
const interfaceDiscoverSensor = new InterfaceDiscoverSensor();

const EptCloudExtension = require('../extension/ept/eptcloud.js');

const fwDiag = require('../extension/install/diag.js');

const FWInvitation = require('./invitation.js');

const Diag = require('../extension/diag/app.js');

let terminated = false;

log.forceInfo("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");
log.forceInfo("FireKick Starting ");
log.forceInfo("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");

(async() => {
  await rclient.delAsync("firekick:pairing:message");
  await sysManager.setConfig(firewallaConfig)
  await interfaceDiscoverSensor.run()
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
diag.iptablesRedirection()

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

async function inviteFirstAdmin(gid) {
  log.forceInfo("Initializing first admin:", gid);

  const gidPrefix = gid.substring(0, 8);

  process.on('SIGTERM', exitHandler.bind(null, {
    terminated: true, cleanup: true, gid: gid, exit: true
  }));

  const group = await eptcloud.groupFindAsync(gid)

  if (!group || !group.symmetricKeys) {
    return false;
  }

  // number of key sym keys equals to number of members in this group
  // set this number to redis so that other js processes get this info
  let count = group.symmetricKeys.length;

  await rclient.hsetAsync("sys:ept", "group_member_cnt", count);

  const eptCloudExtension = new EptCloudExtension(eptcloud, gid);
  await eptCloudExtension.recordAllRegisteredClients(gid).catch((err) => {
    log.error("Failed to record registered clients, err:", err);
  });

  // new group without any apps bound;
  await platform.turnOnPowerLED();

  let fwInvitation = new FWInvitation(eptcloud, gid, symmetrickey);
  fwInvitation.diag = diag

  if (count > 1) {
    log.forceInfo(`Found existing group ${gid} with ${count} members`);
    fwInvitation.totalTimeout = 60 * 10; // 10 mins only for additional binding
    fwInvitation.recordFirstBinding = false // don't record for additional binding

    // broadcast message should already be updated, a new encryption message should be used instead of default one
    if(symmetrickey.userkey === "cybersecuritymadesimple") {
      log.warn("Encryption key should NOT be default after app linked");
    }
  }

  const expireDate = Math.floor(new Date() / 1000) + 600;
  diag.expireDate = expireDate;

  await fwDiag.submitInfo({
    event: "PAIRSTART",
    msg:"Pairing Ready",
    expire: expireDate,
    gidPrefix: gidPrefix
  }).catch((err) => {
    log.error("Failed to submit diag info", err);
  });

  const result = await fwInvitation.broadcast()

  if (result.status == 'success') {
    log.forceInfo("EXIT KICKSTART AFTER JOIN");
    log.info("some license stuff on device:", result.payload);

    postAppLinked()

    if (count > 1) {
      const eptCloudExtension = new EptCloudExtension(eptcloud, gid);
      await eptCloudExtension.job().catch((err) => {
        log.error("Failed to update group info, err:", err);
      });
    }

    await rclient.hsetAsync("sys:ept", "group_member_cnt", count + 1)

    await platform.turnOffPowerLED();

    await fwDiag.submitInfo({
      event: "PAIREND",
      msg: "Pairing Ended",
      gidPrefix: gidPrefix
    }).catch((err) => {
      log.error("Failed to submit diag info", err);
    });

    await launchService2(gid);
  } else {
    log.forceInfo("EXIT KICKSTART AFTER TIMEOUT");

    if (count > 1) postAppLinked()

    await fwDiag.submitInfo({
      event: "PAIREND_TIMEOUT",
      msg: "Pairing Ended",
      gidPrefix: gidPrefix
    }).catch((err) => {
      log.error("Failed to submit diag info", err);
    });
  }
}


async function launchService2(gid) {
  await writeFileAsync('/home/pi/.firewalla/ui.conf', JSON.stringify({gid:gid}), 'utf8');

  // don't start bro until app is linked
  await exec("sudo systemctl is-active brofish").catch((err) => {
    // need to restart brofish
    log.info("Restart brofish.service ...");
    return exec("sudo systemctl restart brofish").catch((err) => { // use restart instead. use 'start' may be trapped due to 'TimeoutStartSec' in brofish.service
      log.error("Failed to restart brofish", err);
    });
  }).then(() => {
    log.info("Enable brofish.service ...");
    return exec("sudo systemctl enable brofish").catch((err) => { // even auto-start for future reboots
      log.error("Failed to enable brofish", err);
    });
  })

  // // start fire api
  // if (require('fs').existsSync("/tmp/FWPRODUCTION")) {
  //   cp.exec("sudo systemctl start fireapi");
  // } else {
  //   if (fs.existsSync("/.dockerenv")) {
  //     cp.exec("cd api; forever start -a --uid api bin/www");
  //   } else {
  //     cp.exec("sudo systemctl start fireapi");
  //   }
  // }
}

function login() {
  log.info("Logging in cloud");
  eptcloud.eptlogin(config.appId, config.appSecret, null, config.endpoint_name, function (err, result) {
    if (err == null) {
      log.info("Cloud Logged In")

      diag.connected = true

      initializeGroup(async function (err, gid) {
        if (gid) {
          // NOTE: This should be the only code to update sys:ept to avoid race condition
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
            log.info("Set sys:ept", err, data, eptcloud.eid, eptcloud.token, gid);
          });

          await inviteFirstAdmin(gid)

          await platform.turnOffPowerLED();
          exec("sleep 2; sudo systemctl stop firekick").catch((err) => {
            // this command will kill the program itself, catch this error silently
          }) 

        } else {
          log.error("Invalid gid");
          process.exit();
        }
      });
    } else {
      log.error("Unable to login", err);
      process.exit();
    }
  });
}

eptcloud.loadKeys()
  .then(login)

process.stdin.resume();

async function sendTerminatedInfoToDiagServer(gid) {
  if (terminated)
    return;
  const gidPrefix = gid.substring(0, 8);
  log.forceInfo("EXIT KICKSTART DUE TO PROCESS TERMINATION");
  terminated = true;
  await fwDiag.submitInfo({
    event: "FIREKICK_TERMINATED",
    msg: "Firekick Terminated",
    gidPrefix: gidPrefix
  }).catch((err) => {
    log.error("failed to submit diag info on termination", err);
  });
}

async function exitHandler(options, err) {
  if (err) log.info(err.stack);
  if (options.cleanup) {
    await platform.turnOffPowerLED();
    await diag.iptablesRedirection(false);
  }
  if (options.terminated) await sendTerminatedInfoToDiagServer(options.gid);
  if (options.exit) {
    process.exit();
  }
}

//do something when app is closing
process.on('beforeExit', exitHandler.bind(null, {
  cleanup: true, exit: true
}));

//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, {
  cleanup: true, exit: true
}));

process.on('uncaughtException',(err)=>{
  log.info("################### CRASH #############");
  log.info("+-+-+-",err.message,err.stack);
  if (err && err.message && err.message.includes("Redis connection")) {
    return;
  }
  bone.logAsync("error", {
    type: 'FIREWALLA.KICKSTART.exception',
    msg: err.message,
    stack: err.stack,
    err: JSON.stringify(err)
  });
  setTimeout(()=>{
    cp.execSync("touch /home/pi/.firewalla/managed_reboot")
    process.exit(1);
  },1000*2);
});

process.on('unhandledRejection', (reason, p)=>{
  let msg = "Possibly Unhandled Rejection at: Promise " + p + " reason: "+ reason;
  log.warn('###### Unhandled Rejection',msg,reason.stack);
  bone.logAsync("error", {
    type: 'FIREWALLA.KICKSTART.unhandledRejection',
    msg: msg,
    stack: reason.stack,
    err: JSON.stringify(reason)
  });
});
