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

// config.discovery.networkInterface

process.title = "FireMain";

const log = require("./logger.js")(__filename);

log.info("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");
log.info("Main Starting ");
log.info("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");

require('events').EventEmitter.prototype._maxListeners = 100;

const sem = require('../sensor/SensorEventManager.js').getInstance();

const fs = require('fs');


const platform = require('../platform/PlatformLoader.js').getPlatform();

function updateTouchFile() {
  const mainTouchFile = "/dev/shm/main.touch";

  fs.open(mainTouchFile, 'w', (err, fd) => {
    if(!err) {
      fs.close(fd, (err2) => {

      })
    }
  })
}

const bone = require("../lib/Bone.js");

const firewalla = require("./Firewalla.js");

const ModeManager = require('./ModeManager.js')
const mode = require('./Mode.js')
const WifiInterface = require('./WifiInterface.js');

// api/main/monitor all depends on sysManager configuration
const SysManager = require('./SysManager.js');
const sysManager = new SysManager('info');
const config = JSON.parse(fs.readFileSync(`${__dirname}/config.json`, 'utf8'));

const BoneSensor = require('../sensor/BoneSensor');
const boneSensor = new BoneSensor();

const fc = require('./config.js')
const cp = require('child_process');

const pclient = require('../util/redis_manager.js').getPublishClient()

if(!bone.isAppConnected()) {
  log.info("Waiting for cloud token created by kickstart job...");
}

resetModeInInitStage()
run0()

function run0() {
  if (bone.cloudready()==true &&
      bone.isAppConnected() &&
      sysManager.isConfigInitialized()) {
    boneSensor.checkIn()
      .then(() => {
        run() // start running after bone checkin successfully
      }).catch((err) => {
        run() // running firewalla in non-license mode if checkin failed
      });
  } else {
    if(!bone.cloudready()) {
      log.info("Connecting to Firewalla Cloud...");
    } else if(!bone.isAppConnected()) {
      log.forceInfo("Waiting for first app to connect...");
    } else if(!sysManager.isConfigInitialized()) {
      log.info("Waiting for configuration setup...");
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
    err: JSON.stringify(err)
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
  bone.logAsync("error", {
    type: 'FIREWALLA.MAIN.unhandledRejection',
    msg: msg,
    stack: reason.stack,
    err: JSON.stringify(reason)
  });
});

async function resetModeInInitStage() {
  // this needs to be execute early!!
  let bootingComplete = await firewalla.isBootingComplete()
  let firstBindDone = await firewalla.isFirstBindDone()

  // always reset to none mode if
  //        bootingComplete flag is off
  //    AND
  //        firstBinding is complete (old version doesn't have this flag )
  // this is to ensure a safe launch
  // in case something wrong with the spoof, firemain will not
  // start spoofing again when restarting

  if(!bootingComplete && firstBindDone) {
    await mode.noneModeOn()
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

  const firewallaConfig = require('../net2/config.js').getConfig();
  sysManager.setConfig(firewallaConfig) // update sys config when start

  const hl = require('../hook/HookLoader.js');
  hl.initHooks();
  hl.run();

  const sl = require('../sensor/SensorLoader.js');
  sl.initSensors();
  sl.run();

  var VpnManager = require('../vpn/VpnManager.js');

  var BroDetector = require("./BroDetect.js");
  let bd = new BroDetector("bro_detector", config, "info");
  //bd.enableRecordHitsTimer()

  var Discovery = require("./Discovery.js");
  let d = new Discovery("nmap", config, "info");

  // make sure there is at least one usable ethernet
  d.discoverInterfaces(function(err, list) {
    var failure = 1;
    if (list.length > 0) {
      for(var i in list) {
        var interf = list[i];
        log.info("Active ethernet is found: " + interf.name + " (" + interf.ip_address + ")");
        failure = 0;
      }
    }

    if(failure) {
      log.error("Failed to find any alive ethernet, taking down the entire main.js")
      process.exit(1);
    }
  });

  let c = require('./MessageBus.js');
  let publisher = new c('debug');

  publisher.publish("DiscoveryEvent","DiscoveryStart","0",{});

  d.start();
  bd.start();



  var HostManager = require('./HostManager.js');
  var hostManager= new HostManager("cli",'server','debug');
  var os = require('os');

  // always create the secondary interface
  await ModeManager.enableSecondaryInterface()
  d.discoverInterfaces((err, list) => {
    if(!err && list && list.length >= 2) {
      sysManager.update(null) // if new interface is found, update sysManager
      pclient.publishAsync("System:IPChange", "");
      // recreate port direct after secondary interface is created
      // require('child-process-promise').exec(`${firewalla.getFirewallaHome()}/scripts/prep/05_install_diag_port_redirect.sh`).catch((err) => undefined)
    }
  })

  let DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
  let dnsmasq = new DNSMASQ();
  dnsmasq.cleanUpFilter('policy').then(() => {}).catch(()=>{});
  dnsmasq.cleanUpLeftoverConfig()

  // Launch PortManager

  let PortForward = require("../extension/portforward/portforward.js");
  let portforward = new PortForward();

  setTimeout(async ()=> {
    var PolicyManager = require('./PolicyManager.js');
    var policyManager = new PolicyManager();

    try {
      await policyManager.flush(config)
    } catch(err) {
      log.error("Failed to setup iptables basic rules, skipping applying existing policy rules");
      return;
    }

    await mode.reloadSetupMode() // make sure get latest mode from redis
    await ModeManager.apply()

    WifiInterface.listenOnChange();

    // when mode is changed by anyone else, reapply automatically
    ModeManager.listenOnChange();
    await portforward.start();

    // initialize VPN after Iptables is flushed
    const vpnManager = new VpnManager();
    hostManager.loadPolicy((err, data) => {
      if (err != null) {
        log.error("Failed to load system policy for VPN", err);
      } else {
        var vpnConfig = {state: false}; // default value
        if(data && data["vpn"]) {
          vpnConfig = JSON.parse(data["vpn"]);
        }
        vpnManager.install("server", (err)=>{
          if (err!=null) {
            log.info("Unable to install vpn server instance: server", err);
            hostManager.setPolicy("vpnAvaliable",false);
          } else {
            (async () => {
              const conf = await vpnManager.configure(vpnConfig);
              if (conf == null) {
                log.error("Failed to configure VPN manager");
                vpnConfig.state = false;
                hostManager.setPolicy("vpn", vpnConfig);
              } else {
                hostManager.setPolicy("vpnAvaliable", true, (err) => { // old typo, DO NOT fix it for backward compatibility.
                  vpnConfig = Object.assign({}, vpnConfig, conf);
                  hostManager.setPolicy("vpn", vpnConfig);
                });
              }
            })();
          }
        });
      }
    });

    // ensure getHosts is called after Iptables is flushed
    hostManager.getHosts((err,result)=>{
      let listip = [];
      for (let i in result) {
//        log.info(result[i].toShortString());
        result[i].on("Notice:Detected",(type,ip,obj)=>{
          log.info("=================================");
          log.info("Notice :", type,ip,obj);
          log.info("=================================");
        });
        result[i].on("Intel:Detected",(type,ip,obj)=>{
          log.info("=================================");
          log.info("Notice :", type,ip,obj);
          log.info("=================================");
        });
	//            result[i].spoof(true);
      }
    });

    let PolicyManager2 = require('../alarm/PolicyManager2.js');
    let pm2 = new PolicyManager2();
    await pm2.setupPolicyQueue()
    pm2.registerPolicyEnforcementListener()

    try {
      await pm2.cleanupPolicyData()
      await pm2.enforceAllPolicies()
      log.info("========= All existing policy rules are applied =========");
    } catch (err) {
      log.error("Failed to apply some policy rules: ", err);
    };
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
