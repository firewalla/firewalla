/*    Copyright 2016-2021 Firewalla Inc.
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

process.title = "FireMain";

const log = require("./logger.js")(__filename);

log.info("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");
log.info("Main Starting ");
log.info("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");

require('events').EventEmitter.prototype._maxListeners = 100;

const fc = require('./config.js')

const sem = require('../sensor/SensorEventManager.js').getInstance();

const fs = require('fs');

const platform = require('../platform/PlatformLoader.js').getPlatform();

function updateTouchFile() {
  const mainTouchFile = "/dev/shm/main.touch";

  fs.open(mainTouchFile, 'w', (err, fd) => {
    if(!err) {
      fs.close(fd, () => { })
    }
  })
}

const rclient = require('../util/redis_manager.js').getRedisClient()
rclient.del('sys:bone:url') // always try configured server for 1st checkin

const bone = require("../lib/Bone.js");

const firewalla = require("./Firewalla.js");

const mode = require('./Mode.js')

const fireRouter = require('./FireRouter.js')

// api/main/monitor all depends on sysManager configuration
const sysManager = require('./SysManager.js');

const sensorLoader = require('../sensor/SensorLoader.js');

const cp = require('child_process');

let interfaceDetected = false;

if(!bone.isAppConnected()) {
  log.info("Waiting for cloud token created by kickstart job...");
}

detectInterface()
resetModeInInitStage()
run0()

async function detectInterface() {
  await fireRouter.waitTillReady()
  interfaceDetected = true;
}


async function run0() {
  const isModeConfigured = await mode.isModeConfigured();
  await sysManager.waitTillInitialized();

  if (platform.isFireRouterManaged()) {
    const fwReleaseType = firewalla.getReleaseType();
    const frReleaseType = await fireRouter.getReleaseType();
    log.info(`Current firerouter release type: ${frReleaseType}. Current firewalla release type: ${fwReleaseType}`);
    if (fwReleaseType && fwReleaseType !== "unknown" && fwReleaseType !== frReleaseType) {
      log.info(`firerouter release type will be switched to ${fwReleaseType}`);
      await fireRouter.switchBranch(fwReleaseType);
    }
  }


  if (interfaceDetected && bone.cloudready()==true &&
      bone.isAppConnected() &&
      isModeConfigured &&
      sysManager.isConfigInitialized()
  ) {
    // do not touch any sensor until everything is ready, otherwise the sensor may require a chain of other objects, which needs to be executed after sysManager is initialized
    fireRouter.waitTillReady().then(async () => {
      const NetworkStatsSensor = await sensorLoader.initSingleSensor('NetworkStatsSensor');
      NetworkStatsSensor.run()
    });

    const boneSensor = await sensorLoader.initSingleSensor('BoneSensor');
    await boneSensor.checkIn().catch((err) => {
      log.error("Got error when checkin, err", err);
      // running firewalla in non-license mode if checkin failed, do not return, continue run()
    })

    await run();
  } else {
    if (!interfaceDetected) {
      log.info("Awaiting interface detection...");
    } else if(!bone.cloudready()) {
      log.info("Connecting to Firewalla Cloud...");
    } else if(!bone.isAppConnected()) {
      log.forceInfo("Waiting for first app to connect...");
    } else if(!sysManager.isConfigInitialized()) {
      log.info("Waiting for configuration setup...");
    } else if(!isModeConfigured) {
      log.info("Waiting for mode setup...");
    }

    setTimeout(()=>{
      sysManager.update(null);
      run0();
    },3000);
  }
}


process.on('uncaughtException',(err)=>{
  log.warn("################### CRASH #############");
  log.warn("+-+-+-",err.message,err.stack);
  if (err && err.message && err.message.includes("Redis connection")) {
    return;
  }
  bone.logAsync("error", {
    type: 'FIREWALLA.MAIN.exception',
    msg: err.message,
    stack: err.stack,
    err: err
  });
  setTimeout(()=>{
    try {
      cp.execSync("touch /home/pi/.firewalla/managed_reboot")
    } catch(e) {
    }
    process.exit(1);
  }, 1000*5);
});

process.on('unhandledRejection', (reason, p)=>{
  let msg = "Possibly Unhandled Rejection at: Promise " + p + " reason: "+ reason;
  log.warn('###### Unhandled Rejection',msg,reason.stack);
  if (msg.includes("Redis connection"))
    return;
  bone.logAsync("error", {
    type: 'FIREWALLA.MAIN.unhandledRejection',
    msg: msg,
    stack: reason.stack,
    err: reason
  });
});

async function resetModeInInitStage() {
  // this needs to be execute early!!
  const bootingComplete = await firewalla.isBootingComplete()
  const firstBindDone = await firewalla.isFirstBindDone()

  // always reset to none mode if
  //        bootingComplete flag is off
  //    AND
  //        firstBinding is complete (old version doesn't have this flag )
  // this is to ensure a safe launch
  // in case something wrong with the spoof, firemain will not
  // start spoofing again when restarting

  // Do not fallback to none on router/DHCP mode
  const isSpoofOn = await mode.isSpoofModeOn();
  const isDHCPSpoofOn = await mode.isDHCPSpoofModeOn();

  if(!bootingComplete && firstBindDone && (isSpoofOn || isDHCPSpoofOn)) {
    if (platform.isFireRouterManaged()) {
      log.warn("Reverting to router mode");
      await mode.routerModeOn();
    } else {
      log.warn("Reverting to limited mode");
      await mode.noneModeOn()
    }
  }
}

function enableFireBlue() {
  // start firemain process only in v2 mode
  cp.exec("sudo systemctl restart firehttpd", (err, stdout, stderr) => {
    if(err) {
        log.error("Failed to start firehttpd:", err);
    }
  })
}

function disableFireBlue() {
  // stop firehttpd in v1
  cp.exec("sudo systemctl stop firehttpd", (err, stdout, stderr) => {
    if(err) {
        log.error("Failed to stop firehttpd:", err);
    }
  })
}

async function run() {

  // periodically update cpu usage, so that latest info can be pulled at any time
  const si = require('../extension/sysinfo/SysInfo.js');
  si.startUpdating();

  sysManager.syncVersionUpdate();


  const HostManager = require('./HostManager.js');
  const hostManager = new HostManager();

  const hl = require('../hook/HookLoader.js');
  hl.initHooks();
  hl.run();

  await sensorLoader.initSensors();
  sensorLoader.run();

  var VpnManager = require('../vpn/VpnManager.js');

  var Discovery = require("./Discovery.js");
  let d = new Discovery("nmap", fc.getConfig(), "info");

  sysManager.update(null) // if new interface is found, update sysManager

  let c = require('./MessageBus.js');
  let publisher = new c('debug');

  publisher.publish("DiscoveryEvent","DiscoveryStart","0",{});

  // require just to initialize the object
  require('./NetworkProfileManager.js');
  const TagManager = require('./TagManager.js');
  await TagManager.refreshTags(); // ensure tags data has been loaded before IPTABLES_READY, so that tags in device will not be auto-removed
  require('./IdentityManager.js');
  require('./VirtWanGroupManager.js');

  let DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
  let dnsmasq = new DNSMASQ();
  dnsmasq.cleanUpFilter('policy').then(() => {}).catch(()=>{});
  dnsmasq.cleanUpLeftoverConfig();

  // Launch PortManager

  let PortForward = require("../extension/portforward/portforward.js");
  let portforward = new PortForward();

  setTimeout(async ()=> {
    const policyManager = require('./PolicyManager.js');

    try {
      await policyManager.flush(fc.getConfig())
    } catch(err) {
      log.error("Failed to setup iptables basic rules, skipping applying existing policy rules");
      return;
    }

    await mode.reloadSetupMode() // make sure get latest mode from redis

    const ModeManager = require('./ModeManager.js')
    await ModeManager.apply()

    // when mode is changed by anyone else, reapply automatically
    ModeManager.listenOnChange();
    await portforward.start();

    // initialize VPN after Iptables is flushed
    const vpnManager = new VpnManager();
    const data = await hostManager.loadPolicyAsync().catch(err =>
      log.error("Failed to load system policy for VPN", err)
    )

    var vpnConfig = {state: false}; // default value
    if(data && data["vpn"]) {
      vpnConfig = JSON.parse(data["vpn"]);
    }

    try {
      await vpnManager.installAsync("server")
    } catch(err) {
      log.info("Unable to install vpn server instance: server", err);
      await hostManager.setPolicyAsync("vpnAvaliable",false);
    }

    const conf = await vpnManager.configure(vpnConfig);
    if (conf == null) {
      log.error("Failed to configure VPN manager");
      vpnConfig.state = false;
      await hostManager.setPolicyAsync("vpn", vpnConfig);
    } else {
      await hostManager.setPolicyAsync("vpnAvaliable", true); // old typo, DO NOT fix it for backward compatibility.
      vpnConfig = Object.assign({}, vpnConfig, conf);
      await hostManager.setPolicyAsync("vpn", vpnConfig);
    }

    // ensure getHosts is called after Iptables is flushed
    await hostManager.getHostsAsync()

    let PolicyManager2 = require('../alarm/PolicyManager2.js');
    let pm2 = new PolicyManager2();
    await pm2.setupPolicyQueue()
    pm2.registerPolicyEnforcementListener()

    try {
      await pm2.cleanupPolicyData()
      //await pm2.enforceAllPolicies()
      await pm2.checkRunPolicies(true)
      log.info("========= All existing policy rules are applied =========");
    } catch (err) {
      log.error("Failed to apply some policy rules: ", err);
    }
    require('./UpgradeManager').finishUpgrade();

  },1000*2);

  updateTouchFile();

  setInterval(()=>{
    let memoryUsage = Math.floor(process.memoryUsage().rss / 1000000);
    try {
      if (global.gc) {
        global.gc();
        log.info("GC executed ",memoryUsage," RSS is now:", Math.floor(process.memoryUsage().rss / 1000000), "MB");
      }
    } catch(e) {
    }

    updateTouchFile();

  },1000*60*5);

  setInterval(()=>{
    let memoryUsage = Math.floor(process.memoryUsage().rss / 1000000);
    if (memoryUsage>= platform.getGCMemoryForMain()) {
        try {
          if (global.gc) {
            global.gc();
            log.info("GC executed Protect ",memoryUsage," RSS is now ", Math.floor(process.memoryUsage().rss / 1000000), "MB");
          }
        } catch(e) {
        }
    }
  },1000*60);


  // finally need to check if firehttpd should be started

  if(fc.isFeatureOn("redirect_httpd")) {
    enableFireBlue()
  } else {
    disableFireBlue()
  }

  fc.onFeature("redirect_httpd", (feature, status) => {
    if(feature !== "redirect_httpd") {
      return
    }

    if(status) {
      enableFireBlue()
    } else {
      disableFireBlue()
    }
  })

  process.on('SIGUSR1', () => {
    log.info('Received SIGUSR1. Trigger check.');
    const dnsmasqCount = dnsmasq.getCounterInfo();
    log.warn(dnsmasqCount);
  });
}

sem.on("ChangeLogLevel", (event) => {
  if(event.name && event.level) {
    if(event.name === "*") {
      require('./LoggerManager.js').setGlobalLogLevel(event.level);
    } else {
      require('./LoggerManager.js').setLogLevel(event.name, event.level);
    }
  }
});
