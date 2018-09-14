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
require('events').EventEmitter.prototype._maxListeners = 100;

let log = require("./logger.js")(__filename);

let sem = require('../sensor/SensorEventManager.js').getInstance();

log.info("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");
log.info("Main Starting ");
log.info("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");

const async = require('asyncawait/async');
const await = require('asyncawait/await');

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

let bone = require("../lib/Bone.js");

let firewalla = require("./Firewalla.js");

let ModeManager = require('./ModeManager.js')

let mode = require('./Mode.js')

// api/main/monitor all depends on sysManager configuration
var SysManager = require('./SysManager.js');
var sysManager = new SysManager('info');
var config = JSON.parse(fs.readFileSync(`${__dirname}/config.json`, 'utf8'));

let BoneSensor = require('../sensor/BoneSensor');
let boneSensor = new BoneSensor();

const fc = require('./config.js')
const cp = require('child_process')

if(!bone.isAppConnected()) {
  log.info("Waiting for cloud token created by kickstart job...");
}

resetModeInInitStage()

run0();

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
  bone.log("error",{version:config.version,type:'FIREWALLA.MAIN.exception',msg:err.message,stack:err.stack},null);
  setTimeout(()=>{
    try {
      require('child_process').execSync("touch /home/pi/.firewalla/managed_reboot")
    } catch(e) {
    }
    process.exit(1);
  },1000*5);
});

process.on('unhandledRejection', (reason, p)=>{
  let msg = "Possibly Unhandled Rejection at: Promise " + p + " reason: "+ reason;
  log.warn('###### Unhandled Rejection',msg,reason.stack,{});
  bone.log("error",{version:config.version,type:'FIREWALLA.MAIN.unhandledRejection',msg:msg,stack:reason.stack},null);
  // setTimeout(()=>{
  //   require('child_process').execSync("touch /home/pi/.firewalla/managed_reboot")
  //   process.exit(1);
  // },1000*5);
});

let hl = null;
let sl = null;

function resetModeInInitStage() {
  // this needs to be execute early!!
  return async(() => {
    let bootingComplete = await (firewalla.isBootingComplete())
    let firstBindDone = await (firewalla.isFirstBindDone())
    
    // always reset to none mode if
    //        bootingComplete flag is off
    //    AND
    //        firstBinding is complete (old version doesn't have this flag )
    // this is to ensure a safe launch
    // in case something wrong with the spoof, firemain will not
    // start spoofing again when restarting

    if(!bootingComplete && firstBindDone) {
      await (mode.noneModeOn())
    }
  })()  
}

function enableFireBlue() {
  // start firemain process only in v2 mode
  cp.exec("sudo systemctl restart firehttpd", (err, stdout, stderr) => {
    if(err) {
        log.error("Failed to start firehttpd:", err, {})
    }
  })
}

function disableFireBlue() {
  // stop firehttpd in v1
  cp.exec("sudo systemctl stop firehttpd", (err, stdout, stderr) => {
    if(err) {
        log.error("Failed to stop firehttpd:", err, {})
    }
  })
}

function run() {

  const firewallaConfig = require('../net2/config.js').getConfig();
  sysManager.setConfig(firewallaConfig) // update sys config when start
  
  hl = require('../hook/HookLoader.js');
  hl.initHooks();
  hl.run();

  sl = require('../sensor/SensorLoader.js');
  sl.initSensors();
  sl.run();

  var VpnManager = require('../vpn/VpnManager.js');

  var BroDetector = require("./BroDetect.js");
  let bd = new BroDetector("bro_detector", config, "info");
  //bd.enableRecordHitsTimer()

  var Discovery = require("./Discovery.js");
  let d = new Discovery("nmap", config, "info");

  let SSH = require('../extension/ssh/ssh.js');
  let ssh = new SSH('debug');

  // make sure there is at least one usable enternet
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
      log.error("Failed to find any alive ethernets, taking down the entire main.js")
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

  async(() => {
    // always create the secondary interface
    await (ModeManager.enableSecondaryInterface())
    d.discoverInterfaces((err, list) => {
      if(!err && list && list.length >= 2) {
        sysManager.update(null) // if new interface is found, update sysManager

        // recreate port direct after secondary interface is created
        // require('child-process-promise').exec(`${firewalla.getFirewallaHome()}/scripts/prep/05_install_diag_port_redirect.sh`).catch((err) => undefined)
      }
    })
  })()

  let DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
  let dnsmasq = new DNSMASQ();
  dnsmasq.cleanUpFilter('policy').then(() => {}).catch(()=>{});

  if (process.env.FWPRODUCTION) {
    /*
      ssh.resetRandomPassword((err,password) => {
      if(err) {
      log.error("Failed to reset ssh password");
      } else {
      log.info("A new random SSH password is used!");
      sysManager.sshPassword = password;
      }
      })
    */
  }

  // Launch PortManager

  let PortForward = require("../extension/portforward/portforward.js");
  let portforward = new PortForward();

  setTimeout(()=> {
    var PolicyManager = require('./PolicyManager.js');
    var policyManager = new PolicyManager('info');

    policyManager.flush(config, (err) => {

      //policyManager.defaults(config);

      if(err) {
        log.error("Failed to setup iptables basic rules, skipping applying existing policy rules");
        return;
      }

      sem.emitEvent({
        type: 'IPTABLES_READY'
      });


      async(() => {
        await (mode.reloadSetupMode()) // make sure get latest mode from redis
        await (ModeManager.apply())
        
        // when mode is changed by anyone else, reapply automatically
        ModeManager.listenOnChange();        
        await (portforward.start());
      })()     

      let PolicyManager2 = require('../alarm/PolicyManager2.js');
      let pm2 = new PolicyManager2();
      pm2.setupPolicyQueue()
      pm2.registerPolicyEnforcementListener()

      setTimeout(() => {
        async(() => {
          await (pm2.cleanupPolicyData())
          await (pm2.enforceAllPolicies())
          log.info("========= All existing policy rules are applied =========");
        })().catch((err) => {
          log.error("Failed to apply some policy rules: ", err, {});
        });          
      }, 1000 * 10); // delay for 10 seconds
      require('./UpgradeManager').finishUpgrade();
    });

  },1000*2);

  updateTouchFile();
  
  setInterval(()=>{
    let memoryUsage = Math.floor(process.memoryUsage().rss / 1000000);
    try {
      if (global.gc) {
        global.gc();
        log.info("GC executed ",memoryUsage," RSS is now:", Math.floor(process.memoryUsage().rss / 1000000), "MB", {});
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
            log.info("GC executed Protect ",memoryUsage," RSS is now ", Math.floor(process.memoryUsage().rss / 1000000), "MB", {});
          }
        } catch(e) {
        }
    }
  },1000*60);

/*
  Bug: when two firewalla's are on the same network, this will change the upnp
  setting.  Need to fix this later.

  this will kick off vpnManager, and later policy manager should stop the VpnManager if needed
*/
  setTimeout(()=>{
    var vpnManager = new VpnManager('info');
    hostManager.loadPolicy((err, data) => {
      if (err != null) {
        log.error("Failed to load system policy for VPN", err);
      } else {
        var vpnConfig = {};
        if(data && data["vpn"]) {
          vpnConfig = JSON.parse(data["vpn"]);
        }
        vpnManager.install("server", (err)=>{
          if (err!=null) {
            log.info("Unable to install vpn server instance: server", err);
            hostManager.setPolicy("vpnAvaliable",false);
          } else {
            vpnManager.configure(vpnConfig, (err) => {
              if (err != null) {
                log.error("Failed to configure VPN manager", err);
                vpnConfig.state = false;
                hostManager.setPolicy("vpn", vpnConfig);
              } else {
                hostManager.setPolicy("vpnAvaliable", true);
              }
            });
          }
        });
      }
    });
  },10000);

  setTimeout(()=>{
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

  },20 * 1000);


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