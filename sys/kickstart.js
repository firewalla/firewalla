#!/usr/bin/env node
'use strict';
/*    Copyright 2016-2020 Firewalla Inc.
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

log.forceInfo("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");
log.forceInfo("FireKick Starting ");
log.forceInfo("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");

const fireRouter = require('../net2/FireRouter.js')

const fs = require('fs');
const cp = require('child_process');
const exec = require('child-process-promise').exec;
const cloud = require('../encipher');
const program = require('commander');
const storage = require('node-persist');
const mathuuid = require('../lib/Math.uuid.js');
const rclient = require('../util/redis_manager.js').getRedisClient()
const pclient = require('../util/redis_manager.js').getPublishClient()
const SSH = require('../extension/ssh/ssh.js');
const ssh = new SSH('info');

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const util = require('util');
const writeFileAsync = util.promisify(fs.writeFile);

const f = require('../net2/Firewalla.js');

const fConfig = require('../net2/config.js');

const bone = require("../lib/Bone.js");

const sysManager = require('../net2/SysManager.js');

const InterfaceDiscoverSensor = require('../sensor/InterfaceDiscoverSensor');
const interfaceDiscoverSensor = new InterfaceDiscoverSensor();

const EptCloudExtension = require('../extension/ept/eptcloud.js');

const fwDiag = require('../extension/install/diag.js');

const FWInvitation = require('./invitation.js');

const Diag = require('../extension/diag/app.js');
const diag = new Diag()

let terminated = false;

const license = require('../util/license.js');

const Message = require('./../net2/Message')


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
const eptcloud = new cloud(eptname, null);


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

storage.initSync({
  'dir': dbPath
});

(async() => {
  await fireRouter.waitTillReady();
  await sysManager.waitTillInitialized();
  await rclient.delAsync("firekick:pairing:message");
  if (!platform.isFireRouterManaged()) {
    await interfaceDiscoverSensor.run()
  }

  // start a diagnostic page for people to access during first binding process
  await diag.start()

  await eptcloud.loadKeys()
  await login()
})();

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

async function initializeGroup() {
  let groupId = storage.getItemSync('groupId');
  if (groupId != null) {
    log.info("Found stored group x", groupId);
    return groupId;
  }

  log.info("Using identity:", eptcloud.eid);
  log.info("Creating new group ", config.service, config.endpoint_name);
  let meta = JSON.stringify({
    'type': config.serviceType,
    'member': config.memberType,
    'model': platform.getName()
  });
  const result = await eptcloud.eptCreateGroup(config.service, meta, config.endpoint_name)
  log.info(result);
  if (result !== null) {
    storage.setItemSync('groupId', result);
  }
  return result
}


async function postAppLinked(count) {

  await platform.ledPaired();
  
  if(platform.hasDefaultSSHPassword()) { // main purpose of post action is to randomize SSH password
    return;
  }
  if (count > 1) // not initial pairing, no need to randomize SSH password
    return;

  // When app is linked, to secure device, ssh password will be
  // automatically reset when boot up every time

  // only do this in production and always do after 15 seconds ...
  // the 15 seconds wait is for the process to wake up
  return new Promise((resolve, reject) => {
    if (f.isProductionOrBetaOrAlpha() &&
      // resetPassword by default unless resetPassword flag is explictly set to false
      (typeof fConfig.resetPassword === 'undefined' ||
        fConfig.resetPassword === true)) {
      setTimeout(() => {
        ssh.resetRandomPassword().then((obj) => {
          log.info("A new random SSH password is used!");
        }).catch((err) => {
          log.error("Failed to reset random ssh password", err);
        }).finally(() => {
          resolve();
        });
      }, 15000);
    } else {
      resolve();
    }
  });
}

async function syncLicense() {
  const licenseJSON = await license.getLicenseAsync();
  const licenseString = licenseJSON && licenseJSON.DATA && licenseJSON.DATA.UUID;
  const tempLicense = await rclient.getAsync("firereset:license");
  if (licenseString && licenseString !== tempLicense) {
    log.info("Syncing license info to redis...")
    await rclient.setAsync("firereset:license", licenseString);
  }
}

async function inviteAdmin(gid) {
  await sysManager.updateAsync()
  log.forceInfo("Initializing first admin:", gid);

  const gidPrefix = gid.substring(0, 8);

  const findResult = await eptcloud.groupFind(gid)

  if (!findResult) {
    return false;
  }

  // number of key sym keys equals to number of members in this group
  // set this number to redis so that other js processes get this info
  let count = findResult.group.symmetricKeys.length;

  await rclient.hsetAsync("sys:ept", "group_member_cnt", count);

  const eptCloudExtension = new EptCloudExtension(eptcloud, gid);
  await eptCloudExtension.recordAllRegisteredClients(gid).catch((err) => {
    log.error("Failed to record registered clients, err:", err);
  });

  // new group without any apps bound;
  await platform.ledReadyForPairing();

  let fwInvitation = new FWInvitation(eptcloud, gid, symmetrickey);
  fwInvitation.diag = diag

  if (count > 1) {
    log.forceInfo(`Found existing group ${gid} with ${count} members`);
    fwInvitation.totalTimeout = 60 * 10; // 10 mins only for additional binding
    
    if (f.isDevelopmentVersion()) {
      fwInvitation.totalTimeout = 60 * 60; // set back to one hour for dev
    }
    fwInvitation.recordFirstBinding = false // don't record for additional binding

    // broadcast message should already be updated, a new encryption message should be used instead of default one
    if(symmetrickey.userkey === "cybersecuritymadesimple") {
      log.warn("Encryption key should NOT be default after app linked");
    }

    await syncLicense();
  }

  const expireDate = Math.floor(new Date() / 1000) + fwInvitation.totalTimeout;
  diag.expireDate = expireDate;

  await fwDiag.submitInfo({
    event: "PAIRSTART",
    msg:"Pairing Ready",
    firstTime: count <= 1,
    expire: expireDate,
    gidPrefix: gidPrefix
  }).catch((err) => {
    log.error("Failed to submit diag info", err);
  });

  const result = await fwInvitation.broadcast()

  if (result.status == 'success') {
    log.forceInfo("EXIT KICKSTART AFTER JOIN");
    log.info("some license stuff on device:", result.payload);

    await postAppLinked(count)

    if (count > 1) {
      const eptCloudExtension = new EptCloudExtension(eptcloud, gid);
      await eptCloudExtension.job().catch((err) => {
        log.error("Failed to update group info, err:", err);
      });
    }

    await rclient.hsetAsync("sys:ept", "group_member_cnt", count + 1)

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

    await postAppLinked(count)

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
  
  /* bro is taken care of in FireMain now
  // don't start bro until app is linked
  await exec("sudo systemctl is-active brofish").catch(() => {
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
  */

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

async function login() {
  log.info("Logging in cloud");

  try {
    await eptcloud.eptLogin(config.appId, config.appSecret, null, config.endpoint_name)
  } catch(err) {
    log.error("Unable to login", err);
    process.exit();
  }

  log.info("Cloud Logged In")

  diag.connected = true

  const gid = await initializeGroup()
  if (!gid) {
    log.error("Invalid gid");
    process.exit();
  }

  // NOTE: This should be the only code to update sys:ept to avoid race condition
  log.info("Storing Firewalla Cloud Token info to redis");
  // log.info("EID:", eptcloud.eid);
  // log.info("GID:", gid);
  // log.info("TOKEN:", eptcloud.token);
  await rclient.hmsetAsync("sys:ept", {
    eid: eptcloud.eid,
    token: eptcloud.token,
    gid: gid
  })
  log.info("Set sys:ept", eptcloud.eid, eptcloud.token, gid);

  process.on('SIGTERM', exitHandler.bind(null, {
    terminated: true, cleanup: true, gid: gid, exit: true, event: "SIGTERM"
  }));

  await inviteAdmin(gid)

  await exitHandler({terminated: true, cleanup: true, gid: gid, exit: false, event: "NormalEnd"})

  process.removeAllListeners('SIGTERM')

  exec("sudo systemctl stop firekick").catch(() => {
    // this command will kill the program itself, catch this error silently
  })

}

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
  if (err) log.info("Exiting", options.event, err.message, err.stack);
  if (options.cleanup) {
    await diag.stop();
    await platform.ledPaired();
  }
  if (options.terminated) await sendTerminatedInfoToDiagServer(options.gid);
  if (options.exit) {
    process.exit();
  }
}

//do something when app is closing
process.on('beforeExit', exitHandler.bind(null, {
  cleanup: true, exit: true, event: "beforeExit"
}));

//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, {
  cleanup: true, exit: true, event: "SIGINT"
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
    err: err
  });
  setTimeout(()=>{
    cp.execSync("touch /home/pi/.firewalla/managed_reboot")
    process.exit(1);
  },1000*2);
});

process.on('unhandledRejection', (reason, p)=>{
  let msg = "Possibly Unhandled Rejection at: Promise " + p + " reason: "+ reason;
  log.warn('###### Unhandled Rejection',msg,reason.stack);
  if (msg.includes("Redis connection"))
    return;
  bone.logAsync("error", {
    type: 'FIREWALLA.KICKSTART.unhandledRejection',
    msg: msg,
    stack: reason.stack,
    err: reason
  });
});
