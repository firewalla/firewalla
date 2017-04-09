/*    Copyright 2016 Rottiesoft LLC 
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
let log = require("./logger.js")(__filename);

log.info("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");
log.info("Main Starting ");
log.info("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");

let bone = require("../lib/Bone.js");

// api/main/monitor all depends on sysManager configuration
var SysManager = require('./SysManager.js');
var sysManager = new SysManager('info');

if(!bone.isAppConnected()) {
  log.info("Waiting for cloud token created by kickstart job...");
}

run0();

function run0() {
  if (bone.cloudready()==true &&
      bone.isAppConnected() &&
      sysManager.isConfigInitialized()) {
    run();
  } else {
    setTimeout(()=>{
      sysManager.update(null);
      run0();
    },1000);
  }
}

var fs = require('fs');
var config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));


process.on('uncaughtException',(err)=>{
  log.warn("################### CRASH #############");
  log.warn("+-+-+-",err.message,err.stack);
  if (err && err.message && err.message.includes("Redis connection")) {
    return; 
  }
  bone.log("error",{version:config.version,type:'FIREWALLA.MAIN.exception',msg:err.message,stack:err.stack},null);
  setTimeout(()=>{
    process.exit(1);
  },1000*5);
});

function run() {


  var VpnManager = require('../vpn/VpnManager.js');

  var BroDetector = require("./BroDetect.js");
  let bd = new BroDetector("bro_detector", config, "info");

  var Discovery = require("./Discovery.js");
  let d = new Discovery("nmap", config, "info");

  let SSH = require('../extension/ssh/ssh.js');
  let ssh = new SSH('debug');


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

  console.log("LANCHING NETBOT SERVER");

  var Spoofer = require('./Spoofer.js');
  let spoofer = new Spoofer(config.monitoringInterface,{},true,true);

  setTimeout(()=> {
    var PolicyManager = require('./PolicyManager.js');
    var policyManager = new PolicyManager('info');

    policyManager.flush(config);
    //policyManager.defaults(config);
    //TODO need to write something install automatic rules

    // for each new host  ... need to apply policy
    var AlarmManager = require("./AlarmManager.js");
    var alarmManager = new AlarmManager('debug');
    //alarmManager.alarm("0.0.0.0", "message", 'major','50',{msg:"Fishbone core is starting"},null);
  },1000*2);

  setTimeout(()=>{
    sysManager.checkIn((err,data)=>{
    });
  },5000);

  setInterval(()=>{
    sysManager.checkIn((err,data)=>{
    });
  },1000*60*60*1);


  setInterval(()=>{
    try {
      if (global.gc) {
        global.gc();
      }
    } catch(e) {
    }
  },1000*60);


/*
  Bug: when two firewalla's are on the same network, this will change the upnp
  setting.  Need to fix this later.
  
  this will kick off vpnManager, and later policy manager should stop the VpnManager if needed
*/
  setTimeout(()=>{
    var vpnManager = new VpnManager('info');
    vpnManager.install((err)=>{
      if (err!=null) {
        console.log("VpnManager:Unable to start vpn");
        hostManager.setPolicy("vpnAvaliable",false);
      } else {
        vpnManager.start((err)=>{ 
          if (err!=null) {
            console.log("VpnManager:Unable to start vpn");
            hostManager.setPolicy("vpnAvaliable",false);
          } else {
            hostManager.setPolicy("vpnAvaliable",true);
          }
        });
      }
    });
  },10000);

  setTimeout(()=>{
    hostManager.getHosts((err,result)=>{
      let listip = [];
      for (let i in result) {
        console.log(result[i].toShortString());
        result[i].on("Notice:Detected",(type,ip,obj)=>{
          console.log("=================================");
          console.log("Notice :", type,ip,obj);
          console.log("=================================");
        });
        result[i].on("Intel:Detected",(type,ip,obj)=>{
          console.log("=================================");
          console.log("Notice :", type,ip,obj);
          console.log("=================================");
        });
	//            result[i].spoof(true);
      }
    });

  },30000);


}
