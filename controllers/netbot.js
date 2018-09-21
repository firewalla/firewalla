#!/usr/bin/env node
/*    Copyright 2016 Firewalla LLC / Firewalla LLC
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

'use strict'

process.title = "FireApi";
let log = require('../net2/logger.js')(__filename, "info");

const util = require('util');
let fs = require('fs');

const ControllerBot = require('../lib/ControllerBot.js');

const sem = require('../sensor/SensorEventManager.js').getInstance();

const fc = require('../net2/config.js')
const URL = require("url");
const bone = require("../lib/Bone");
const dhcp = require("../extension/dhcp/dhcp.js");

const EptCloudExtension = require('../extension/ept/eptcloud.js');


let HostManager = require('../net2/HostManager.js');
let SysManager = require('../net2/SysManager.js');
let FlowManager = require('../net2/FlowManager.js');
let flowManager = new FlowManager('info');
let AlarmManager = require('../net2/AlarmManager.js');
let alarmManager = new AlarmManager('info');
let sysManager = new SysManager();
let VpnManager = require("../vpn/VpnManager.js");
let vpnManager = new VpnManager('info');
let IntelManager = require('../net2/IntelManager.js');
let intelManager = new IntelManager('debug');

const CategoryUpdater = require('../control/CategoryUpdater.js')
const categoryUpdater = new CategoryUpdater()

let DeviceMgmtTool = require('../util/DeviceMgmtTool');

const Promise = require('bluebird');

const timeSeries = require('../util/TimeSeries.js').getTimeSeries()
const getHitsAsync = Promise.promisify(timeSeries.getHits)

const SysTool = require('../net2/SysTool.js')
const sysTool = new SysTool()

const flowUtil = require('../net2/FlowUtil');

const iptool = require('ip')

const rclient = require('../util/redis_manager.js').getRedisClient()
const sclient = require('../util/redis_manager.js').getSubscriptionClient()

const exec = require('child-process-promise').exec

let AM2 = require('../alarm/AlarmManager2.js');
let am2 = new AM2();

let EM = require('../alarm/ExceptionManager.js');
let em = new EM();

let PM2 = require('../alarm/PolicyManager2.js');
let pm2 = new PM2();

let SSH = require('../extension/ssh/ssh.js');
let ssh = new SSH('info');

let country = require('../extension/country/country.js');

let builder = require('botbuilder');
let uuid = require('uuid');

let async2 = require('async');

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let NM = require('../ui/NotifyManager.js');
let nm = new NM();

const FRPManager = require('../extension/frp/FRPManager.js')
const fm = new FRPManager()
const frp = fm.getSupportFRP()

let f = require('../net2/Firewalla.js');

let flowTool = require('../net2/FlowTool')();

let i18n = require('../util/i18n');

let NetBotTool = require('../net2/NetBotTool');
let netBotTool = new NetBotTool();

let HostTool = require('../net2/HostTool');
let hostTool = new HostTool();

let appTool = require('../net2/AppTool')();

let spooferManager = require('../net2/SpooferManager.js')

const extMgr = require('../sensor/ExtensionManager.js')

const PolicyManager = require('../net2/PolicyManager.js');
const policyManager = new PolicyManager();

const proServer = require('../api/bin/pro');
const tokenManager = require('../api/middlewares/TokenManager').getInstance();

const migration = require('../migration/migration.js');

class netBot extends ControllerBot {

  _block2(ip, dst, cron, timezone, duration, callback) {
    let value = {
      id: "0",
      cron: cron,
      dst: dst,
      timezone: timezone,
      duration: duration
    }
    this._block(ip, 'block', value, callback);
  }

  _ignore(ip, reason, callback) {
    this.hostManager.ignoreIP(ip, reason, callback);
  }

  _unignore(ip, callback) {
    this.hostManager.unignoreIP(ip, callback);
  }

  _devicePresence(ip, value, callback) {
    log.info("_devicePresence", ip, value);
    if (ip === "0.0.0.0") {
      this.hostManager.loadPolicy((err, data) => {
        this.hostManager.setPolicy('devicePresence', value, (err, data) => {
          if (err == null) {
            if (callback != null) {
              callback(null, "Success");
            }
          } else {
            if (callback != null) {
              callback(err, "Unable to change presence config to ip " + ip);
            }
          }
        });
      })
    } else {
      this.hostManager.getHost(ip, (err, host) => {
        if (host != null) {
          host.loadPolicy((err, data) => {
            if (err == null) {
              host.setPolicy('devicePresence', value, (err, data) => {
                if (err == null) {
                  if (callback != null)
                    callback(null, "Success:" + ip);
                } else {
                  if (callback != null)
                    callback(err, "Unable to change presence config to ip " + ip)

                }
              });
            } else {
              if (callback != null)
                callback("error", "Unable to change presence config to ip " + ip);
            }
          });
        } else {
          if (callback != null)
            callback("error", "Host not found");
        }
      });
    }
  }

  _block(ip, blocktype, value, callback) {
    log.info("_block", ip, blocktype, value);
    if (ip === "0.0.0.0") {
      this.hostManager.loadPolicy((err, data) => {
        this.hostManager.setPolicy(blocktype, value, (err, data) => {
          if (err == null) {
            if (callback != null)
              callback(null, "Success");
          } else {
            if (callback != null)
              callback(err, "Unable to block ip " + ip);
          }
        });
      });
    } else {
      this.hostManager.getHost(ip, (err, host) => {
        if (host != null) {
          host.loadPolicy((err, data) => {
            if (err == null) {
              host.setPolicy(blocktype, value, (err, data) => {
                if (err == null) {
                  if (callback != null)
                  //   this.tx(this.primarygid, "Success:"+ip,"hosts summary");
                    callback(null, "Success:" + ip);
                } else {
                  if (callback != null)
                  // this.tx(this.primarygid, "Unable to block ip "+ip,"hosts summary");
                    callback(err, "Unable to block ip " + ip)

                }
              });
            } else {
              if (callback != null)
              //this.tx(this.primarygid, "Unable to block ip "+ip,"hosts summary");
                callback("error", "Unable to block ip " + ip);
            }
          });
        } else {
          if (callback != null)
          //this.tx(this.primarygid, "host not found","hosts summary");
            callback("error", "Host not found");
        }
      });
    }
  }

  _family(ip, value, callback) {
    if (ip === "0.0.0.0") {
      this.hostManager.loadPolicy((err, data) => {
        this.hostManager.setPolicy("family", value, (err, data) => {
          if (err == null) {
            if (callback != null)
              callback(null, "Success");
          } else {
            if (callback != null)
              callback(err, "Unable to block ip " + ip);
          }
        });
      });
    } else {
      this.hostManager.getHost(ip, (err, host) => {
        if (host != null) {
          host.loadPolicy((err, data) => {
            if (err == null) {
              host.setPolicy("family", value, (err, data) => {
                if (err == null) {
                  if (callback != null)
                    callback(null, "Success:" + ip);
                } else {
                  if (callback != null)
                    callback(err, "Unable to block ip " + ip);
                }
              });
            } else {
              if (callback != null)
                callback("error", "Unable to block ip " + ip);
            }
          });
        } else {
          if (callback != null)
            callback("error", "host not found");
        }
      });
    }
  }

  _adblock(ip, value, callback) {
    if (ip === "0.0.0.0") {
      this.hostManager.loadPolicy((err, data) => {
        this.hostManager.setPolicy("adblock", value, (err, data) => {
          if (err == null) {
            if (callback != null)
              callback(null, "Success");
          } else {
            if (callback != null)
              callback(err, "Unable to block ip " + ip);
          }
        });
      });
    } else {
      this.hostManager.getHost(ip, (err, host) => {
        if (host != null) {
          host.loadPolicy((err, data) => {
            if (err == null) {
              host.setPolicy("adblock", value, (err, data) => {
                if (err == null) {
                  if (callback != null)
                    callback(null, "Success:" + ip);
                } else {
                  if (callback != null)
                    callback(err, "Unable to block ip " + ip);
                }
              });
            } else {
              if (callback != null)
                callback("error", "Unable to block ip " + ip);
            }
          });
        } else {
          if (callback != null)
            callback("error", "host not found");
        }
      });
    }
  }

  _vpn(ip, value, callback) {
    if(ip !== "0.0.0.0") {
      callback(null); // per-device policy rule is not supported
      return;
    }

    this.hostManager.loadPolicy((err, data) => {
      var newValue = {};
      if (data["vpn"]) {
        newValue = JSON.parse(data["vpn"]);
      }
      Object.keys(value).forEach((k) => {
        newValue[k] = value[k];
      });
      this.hostManager.setPolicy("vpn", newValue, (err, data) => {
        if (err == null) {
          if (callback != null)
            callback(null, "Success");
        } else {
          if (callback != null)
            callback(err, "Unable to block ip " + ip);
        }
      });
    });
  }

  _shadowsocks(ip, value, callback) {
    if(ip !== "0.0.0.0") {
      callback(null); // per-device policy rule is not supported
      return;
    }

    this.hostManager.loadPolicy((err, data) => {
      this.hostManager.setPolicy("shadowsocks", value, (err, data) => {
        if (err == null) {
          if (callback != null)
            callback(null, "Success");
        } else {
          if (callback != null)
            callback(err, "Unable to apply config on shadowsocks: " + value);
        }
      });
    });
  }

  _scisurf(ip, value, callback) {
    if(ip !== "0.0.0.0") {
      callback(null); // per-device policy rule is not supported
      return;
    }

    this.hostManager.loadPolicy((err, data) => {
      this.hostManager.setPolicy("scisurf", value, (err, data) => {
        if (err == null) {
          if (callback != null)
            callback(null, "Success");
        } else {
          if (callback != null)
            callback(err, "Unable to apply config on scisurf: " + value);
        }
      });
    });
  }

  _vulScan(ip, value, callback) {
    if(ip !== "0.0.0.0") {
      callback(null); // per-device policy rule is not supported
      return;
    }

    this.hostManager.loadPolicy((err, data) => {
      this.hostManager.setPolicy("vulScan", value, (err, data) => {
        if (err == null) {
          if (callback != null)
            callback(null, "Success");
        } else {
          if (callback != null)
            callback(err, "Unable to apply config on vulScan: " + value);
        }
      });
    });
  }

  _dnsmasq(ip, value, callback) {
    if(ip !== "0.0.0.0") {
      callback(null); // per-device policy rule is not supported
      return;
    }

    this.hostManager.loadPolicy((err, data) => {
      this.hostManager.setPolicy("dnsmasq", value, (err, data) => {
        if (err == null) {
          if (callback != null)
            callback(null, "Success");
        } else {
          if (callback != null)
            callback(err, "Unable to apply config on dnsmasq: " + value);
        }
      });
    });
  }

  _externalAccess(ip, value, callback) {
    if(ip !== "0.0.0.0") {
      callback(null); // per-device policy rule is not supported
      return;
    }

    this.hostManager.loadPolicy((err, data) => {
      this.hostManager.setPolicy("externalAccess", value, (err, data) => {
        if (err == null) {
          if (callback != null)
            callback(null, "Success");
        } else {
          if (callback != null)
            callback(err, "Unable to apply config on externalAccess: " + value);
        }
      });
    });
  }

  _ssh(ip, value, callback) {
    this.hostManager.loadPolicy((err, data) => {
      this.hostManager.setPolicy("ssh", value, (err, data) => {
        if (err == null) {
          if (callback != null)
            callback(null, "Success");
        } else {
          if (callback != null)
            callback(err, "Unable to ssh " + ip);
        }
      });
    });
  }

  /*
   *
   *   {
   *      state: BOOL;  overall notification
   *      ALARM_XXX: standard alarm definition
   *      ALARM_BEHAVIOR: may be mapped to other alarms
   *   }
   */
  _notify(ip, value, callback) {
    this.hostManager.loadPolicy((err, data) => {
      this.hostManager.setPolicy("notify", value, (err, data) => {
        if (err == null) {
          if (callback != null)
            callback(null, "Success");
        } else {
          if (callback != null)
            callback(err, "Unable to setNotify " + ip);
        }
        log.info("Notification Set",value," CurrentPolicy:", JSON.stringify(this.hostManager.policy.notify),{});
        nm.loadConfig();
      });
    });
  }

  _sendLog(msg,callback) {
    let password = require('../extension/common/key.js').randomPassword(10)
    let filename = this.primarygid+".tar.gz.gpg";
    let path = "";
    log.info("sendLog: ", filename, password,{});
    this.eptcloud.getStorage(this.primarygid,18000000,0,(e,url)=>{
      log.info("sendLog: Storage ", filename, password,url,{});
      if (url == null || url.url == null) {
        this.simpleTxData(msg,{},"Unable to get storage",callback);   
      } else {
        path = URL.parse(url.url).pathname;
        let cmdline = '/home/pi/firewalla/scripts/encrypt-upload-s3.sh '+filename+' '+password+' '+"'"+url.url+"'";
        log.info("sendLog: cmdline", filename, password,cmdline,{});
        require('child_process').exec(cmdline, (err, out, code) => {
          log.error("sendLog: unable to process encrypt-upload",err,out,code);
          if (err!=null) {
            log.error("sendLog: unable to process encrypt-upload",err,out,code);
          } else {
          }
        });
        this.simpleTxData(msg,{password:password,filename:path},null,callback);   
      }
    });
  }
  
  _portforward(ip, msg, callback) {
    log.info("_portforward",ip,msg);
    let c = require('../net2/MessageBus.js');
    this.channel = new c('debug');
    this.channel.publish("FeaturePolicy", "Extension:PortForwarding", null, msg);
    if (callback) {
      callback(null,null);
    }
  }

  _setUpstreamDns(ip, value, callback) {
    log.info("In _setUpstreamDns with ip:", ip, "value:", value);
    this.hostManager.loadPolicy((err, data) => {
      this.hostManager.setPolicy("upstreamDns", value, (err, data) => {
        if (err == null) {
          if (callback != null)
            callback(null, "Success");
        } else {
          if (callback != null)
            callback(err, "Unable to apply config on upstream_dns: " + value);
        }
      });
    });
  }

  constructor(config, fullConfig, eptcloud, groups, gid, debug, apiMode) {
    super(config, fullConfig, eptcloud, groups, gid, debug, apiMode);
    this.bot = new builder.TextBot();
    //      this.dialog = new builder.LuisDialog(config.dialog.api);
    this.dialog = new builder.CommandDialog();
    this.bot.add('/', this.dialog);
    let self = this;
    this.compress = true;
    this.scanning = false;

    this.eptCloudExtension = new EptCloudExtension(eptcloud, gid);
    this.eptCloudExtension.run(); // auto update group info from cloud

    this.sensorConfig = config.controller.sensor;
    //flow.summaryhours
    // sysManager.setConfig(this.sensorConfig);
    sysManager.update((err, data) => {
    });

    setInterval(() => {
      sysManager.update((err, data) => {
      });
    }, 1000 * 60 * 60 * 10);

    setInterval(() => {
      try {
        if (global.gc) {
          global.gc();
        }
      } catch (e) {
      }
    }, 1000 * 60);

    setTimeout(() => {
      setInterval(() => {
//          this.refreshCache(); // keep cache refreshed every 50 seconds so that app will load data fast
      }, 50 * 1000);
    }, 30 * 1000)

    this.hostManager = new HostManager("cli", 'client', 'debug');
    this.hostManager.loadPolicy((err, data) => {});  //load policy
 
    // no subscription for api mode
    if (apiMode) {
      log.info("Skipping event subscription during API mode.");
      return;
    }

    let c = require('../net2/MessageBus.js');
    this.subscriber = new c('debug');

    this.subscriber.subscribe("DiscoveryEvent", "DiscoveryStart", null, (channel, type, ip, msg) => {
      //this.tx(this.primarygid, "Discovery started","message");
    });
    this.subscriber.subscribe("DiscoveryEvent", "Host:Found", null, (channel, type, ip, o) => {
      log.info("Found new host ", channel, type, ip);
      if (o) {
        let name = o.ipv4Addr;
        if (o.name != null) {
          name = o.name + " (" + o.ipv4Addr + ")";
        } else if (o.macVendor != null) {
          name = "(?)" + o.macVendor + " (" + o.ipv4Addr + ")";
        }
        this.tx2(this.primarygid, "New host found in network: " + name, "Found new host " + name, {uid: o.ipv4Addr});
      }
    });
    this.subscriber.subscribe("MonitorEvent", "Monitor:Flow:Out", null, (channel, type, ip, msg) => {
      let m = null;
      let n = null;
      log.info("Monitor:Flow:Out", channel, ip, msg, "=====");
      if (ip && msg) {
        if (msg['txRatioRanked'] && msg['txRatioRanked'].length > 0) {
          let flow = msg['txRatioRanked'][0];
          if (flow.rank > 0) {
            return;
          }
          m = "Warning: \n\n" + flowManager.toStringShortShort2(msg['txRatioRanked'][0], msg.direction, 'txdata') + "\n";
          n = flowManager.toStringShortShort2(msg['txRatioRanked'][0], msg.direction);
        }
      }
      if (m) {
        log.info("MonitorEvent:Flow:Out", m, msg);
        if (nm.canNotify() == true) {
          this.tx2(this.primarygid, m, n, {id: msg.id});
        }
      }
    });
    this.subscriber.subscribe("MonitorEvent", "Monitor:Flow:In", null, (channel, type, ip, msg) => {
      /*
       let m = null;
       let n = null;
       log.info("Monitor:Flow:In", channel, ip, msg, "=====");
       if (ip && msg) {
       if (msg['txRatioRanked'] && msg['txRatioRanked'].length > 0) {
       let flow = msg['txRatioRanked'][0];
       if (flow.rank > 0) {
       return;
       }
       m = "Warning: \n\n" + flowManager.toStringShortShort2(msg['txRatioRanked'][0], msg.direction, 'txdata') + "\n";
       n = flowManager.toStringShortShort2(msg['txRatioRanked'][0], msg.direction);
       }
       }
       if (m)
       this.tx2(this.primarygid, m, n, {id:msg.id});
       */
    });


    this.subscriber.subscribe("ALARM", "ALARM:CREATED", null, (channel, type, ip, msg) => {
      if (msg) {
        let notifMsg = msg.notif;
        let aid = msg.aid;
        if (notifMsg) {
          log.info("Sending notification: " + JSON.stringify(msg));
          if (this.hostManager.policy && this.hostManager.policy["notify"]) {
               if (this.hostManager.policy['notify']['state']==false) {
                   log.info("ALARM_NOTIFY_GLOBALL_BLOCKED", msg);
                   return;
               }
               if (msg.alarmType) {
                   let alarmType = msg.alarmType;
                   if (msg.alarmType  === "ALARM_LARGE_UPDATE") {
                       alarmType = "ALARM_BEHAVIOR";
                   }
                   if (this.hostManager.policy["notify"][alarmType] === false) {
                       log.info("ALARM_NOTIFY_BLOCKED", msg);
                       return;
                   }
               }
          }

          log.info("ALARM_NOTIFY_PASSED");

          notifMsg = {
            title: i18n.__("SECURITY_ALERT"),
            body: notifMsg
          }

          let data = {
            gid: this.primarygid,
            notifType: "ALARM"
          };

          if (msg.aid) {
            data.aid = msg.aid;
          }

          if (msg.alarmID) {
            data.alarmID = msg.alarmID;
          }

          if(msg.alarmNotifType) {
            notifMsg.title = i18n.__(msg.alarmNotifType);
          }

          if (msg.autoblock) {
            data.category = "com.firewalla.category.autoblockalarm";
          } else {
            data.category = "com.firewalla.category.alarm";
          }

          // check if device name should be included, sometimes it is helpful if multiple devices are bound to one app
          async(() => {
            let flag = await (rclient.hgetAsync("sys:config", "includeNameInNotification"))
            if(flag == "1") {
              notifMsg.title = `[${this.getDeviceName()}] ${notifMsg.title}`
            }
            if(msg["testing"] && msg["testing"] == 1) {
              notifMsg.title = `[Monkey] ${notifMsg.title}`;
            }
            this.tx2(this.primarygid, "test", notifMsg, data);            
          })()


        }
      }
    });

    setTimeout(() => {
      this.scanStart();
      async(() => {
        let branchChanged = await (sysManager.isBranchJustChanged())
        if(branchChanged) {
          let branch = null
          
          switch(branchChanged) {
          case "1":
            branch = "back to stable release"
            break;
          case "2":
            branch = "to beta release"
            break;
          case "3":
            branch = "to development release"
            break;
          default:
            // do nothing, should not happen here
            break;
          }

          if(branch) {
            let msg = `Device '${this.getDeviceName()}' has switched ${branch} ${sysManager.version()} successfully`
            log.info(msg)
            this.tx(this.primarygid, "200", msg)
            sysManager.clearBranchChangeFlag()            
          }

        } else {
          if (sysManager.systemRebootedByUser(true)) {
            if (nm.canNotify() == true) {
              this.tx(this.primarygid, "200", "Firewalla reboot completed.");
            }
          } else if (sysManager.systemRebootedDueToIssue(true) == false) {
            if (nm.canNotify() == true) {
              this.tx(this.primarygid, "200", "🔥 Firewalla Device '" + this.getDeviceName() + "' Awakens!");
            }
          }
        }
        
      })()
      this.setupDialog();
    }, 20 * 1000);

    this.hostManager.on("Scan:Done", (channel, type, ip, obj) => {
      if (type == "Scan:Done") {
        this.scanning = false;
        for (let h in this.hosts) {
          //this.hosts[h].clean();
        }
        this.scanStart();
      }
    });
    this.hostManager.on("Scan:Start", (channel, type, ip, obj) => {
      if (type == "Scan:Start") {
        this.scanning = true;
      }
    });

    sclient.on("message", (channel, msg)=> {
       log.info("Msg",channel,msg);
       switch(channel) {
         case "System:Upgrade:Hard":
             if (msg) {
                let notifyMsg = {
                   title: "Upgrade Needed",
                   body: "Firewalla new version "+msg+" is avaliable, please open firewalla app then tap on settings->upgrade.",
                   } 
                let data = {
                   gid: this.primarygid,
                };
                this.tx2(this.primarygid, "", notifyMsg, data);
             }
             break;
         case "System:Upgrade:Soft":
             if (msg) {
                let notifyMsg = {
                  title: `Firewalla is upgraded to ${msg}`,
                  body: ""
                }
                let data = {
                  gid: this.primarygid,
                };
                this.tx2(this.primarygid, "", notifyMsg, data);
             }
             break;
         case "SS:DOWN":
           if (msg) {
             let notifyMsg = {
               title: `Shadowsocks server ${msg} is down`,
               body: ""
             }
             let data = {
               gid: this.primarygid,
             };
             this.tx2(this.primarygid, "", notifyMsg, data);
           }
           break;
         case "SS:FAILOVER":
           if (msg) {
             let json = null
             try {
               json = JSON.parse(msg)
               const oldServer = json.oldServer
               const newServer = json.newServer
               
               if(oldServer && newServer && oldServer !== newServer) {
                 let notifyMsg = {
                   title: "Shadowsocks Failover",
                   body: `Shadowsocks server is switched from ${oldServer} to ${newServer}.`
                 }
                 let data = {
                   gid: this.primarygid,
                 };
                 this.tx2(this.primarygid, "", notifyMsg, data)
               }
               
             } catch(err) {
               log.error("Failed to parse SS:FAILOVER payload:", err)
             }
           }
           break;
         case "SS:START:FAILED":
           if (msg) {
             let notifyMsg = {
               title: "SciSurf service is down!",
               body: `Failed to start scisurf service with ss server ${msg}.`
             }
             let data = {
               gid: this.primarygid,
             };
             this.tx2(this.primarygid, "", notifyMsg, data)
           }
           break;
          case "DNS:Down":
          if (msg) {
            const notifyMsg = {
              title: "DNS status check failed!",
              body: `DNS status check has failed ${msg} consecutive times.`
            }
            const data = {
              gid: this.primarygid,
            };
            this.tx2(this.primarygid, "", notifyMsg, data)
          }
          break;
          case "APP:NOTIFY":
          try {
            const jsonMessage = JSON.parse(msg);

            if (jsonMessage && jsonMessage.title && jsonMessage.body) {
              const title = `[${this.getDeviceName()}] ${jsonMessage.title}`;
              const body = jsonMessage.body;

              const notifyMsg = {
                title: title,
                body: body
              }
              const data = {
                gid: this.primarygid,
              };
              this.tx2(this.primarygid, "", notifyMsg, data)
            }
          } catch(err) {
            log.error("Failed to parse app notify message:", msg, err);
          }       
          break;   
       }
    });
    sclient.subscribe("System:Upgrade:Hard");
    sclient.subscribe("System:Upgrade:Soft");
    sclient.subscribe("SS:DOWN")
    sclient.subscribe("SS:FAILOVER")
    sclient.subscribe("SS:START:FAILED")
    sclient.subscribe("APP:NOTIFY");

  }

  boneMsgHandler(msg) {
      log.info("Bone Message",JSON.stringify(msg));
      if (msg.type == "MSG" && msg.title) {
          let notifyMsg = {
             title: msg.title,
             body: msg.body 
          } 
          let data = {
             gid: this.primarygid,
             data: msg.data
          };
          this.tx2(this.primarygid, "", notifyMsg, data);
      } else if (msg.type == "CONTROL") {
          if (msg.control && msg.control === "reboot") {
              log.error("FIREWALLA REMOTE REBOOT");
              require('child_process').exec('sync & /home/pi/firewalla/scripts/fire-reboot-normal', (err, out, code) => {
              });
          } else if (msg.control && msg.control === "upgrade") {
              log.error("FIREWALLA REMOTE UPGRADE ");
              require('child_process').exec('sync & /home/pi/firewalla/scripts/upgrade', (err, out, code) => {
              });
          } else if (msg.control && msg.control === "ping") {
              log.error("FIREWALLA CLOUD PING ");
          } else if (msg.control && msg.control === "v6on") {
              require('child_process').exec('sync & touch /home/pi/.firewalla/config/enablev6', (err, out, code) => {
              });                     
          } else if (msg.control && msg.control === "v6off") {
              require('child_process').exec('sync & rm /home/pi/.firewalla/config/enablev6', (err, out, code) => {
              });                     
          } else if (msg.control && msg.control === "script") {
              require('child_process').exec('sync & /home/pi/firewalla/scripts/'+msg.command, (err, out, code) => {
              });                     
          } else if (msg.control && msg.control === "raw") {
              log.error("FIREWALLA CLOUD RAW ");
              // RAW commands will never / ever be ran on production 
              if (sysManager.isSystemDebugOn() || !f.isProduction()) {
                  if (msg.command) {
                      log.error("FIREWALLA CLOUD RAW EXEC",msg.command);
                      require('child_process').exec('sync & '+msg.command, (err, out, code) => {
                      });
                  }
              }
          }
      }
  }

  scanStart(callback) {
    this.hostManager.getHosts((err, result) => {
      let listip = [];
      this.hosts = result;
      for (let i in result) {
//        log.info(result[i].toShortString());
        result[i].on("Notice:Detected", (channel, type, ip, obj) => {
          log.info("Found new notice", type, ip);
          if ((obj.note == "Scan::Port_Scan" || obj.note == "Scan::Address_Scan") && this.scanning == false) {
            let msg = result[i].name() + ": " + obj.msg;
            if (nm.canNotify() == true) {
              this.tx(this.primarygid, msg, obj.msg);
            }
          } else if ((obj.note == "Scan::Port_Scan" || obj.note == "Scan::Address_Scan") && this.scanning == true) {
            log.info("Netbot:Notice:Skip due to scanning", obj);
          } else {
            let msg = result[i].name() + ": " + obj.msg;
            if (nm.canNotify() == true) {
              this.tx(this.primarygid, msg, obj.msg);
            }
          }
        });
      }
      if (callback)
        callback(null, null);

    });

  }

  setHandler(gid, msg, callback) {
    // mtype: set
    // target = "ip address" 0.0.0.0 is self
    // data.item = policy
    // data.value = {'block':1},
    //
    //       log.info("Set: ",gid,msg);

    // invalidate cache
    this.invalidateCache();

    if(extMgr.hasSet(msg.data.item)) {
      async(() => {
        const result = await (extMgr.set(msg.data.item, msg, msg.data.value))
        this.simpleTxData(msg, result, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, null, err, callback)
      })
      return
    }

    switch (msg.data.item) {
      case "policy":
        async2.eachLimit(Object.keys(msg.data.value), 1, (o, cb) => {
          switch (o) {
            case "monitor":
              this._block(msg.target, "monitor", msg.data.value.monitor, (err, obj) => {
                cb(err);
              });
              break;
            case "devicePresence":
              this._devicePresence(msg.target, msg.data.value.devicePresence, (err, obj) => {
                cb(err);
              });
              break;
            case "blockin":
              this._block(msg.target, "blockin", msg.data.value.blockin, (err, obj) => {
                cb(err);
              });
              break;
            case "acl":
              this._block(msg.target, "acl", msg.data.value.acl, (err, obj) => {
                cb(err);
              });
              break;
            case "family":
              this._family(msg.target, msg.data.value.family, (err, obj) => {
                cb(err);
              });
              break;
            case "adblock":
              this._adblock(msg.target, msg.data.value.adblock, (err, obj) => {
                cb(err);
              });
              break;
            case "vpn":
              this._vpn(msg.target, msg.data.value.vpn, (err, obj) => {
                cb(err);
              });
              break;
            case "shadowsocks":
              this._shadowsocks(msg.target, msg.data.value.shadowsocks, (err, obj) => {
                cb(err);
              });
              break;
            case "scisurf":
              this._scisurf(msg.target, msg.data.value.scisurf, (err, obj) => {
                cb(err);
              });
              break;
            case "vulScan":
              this._vulScan(msg.target, msg.data.value.vulScan, (err, obj) => {
                cb(err);
              });
              break;
            case "dnsmasq":
              this._dnsmasq(msg.target, msg.data.value.dnsmasq, (err, obj) => {
                cb(err);
              });
              break;
            case "externalAccess":
              this._externalAccess(msg.target, msg.data.value.externalAccess, (err, obj) => {
                cb(err);
              });
              break;
            case "ssh":
              this._ssh(msg.target, msg.data.value.ssh, (err, obj) => {
                cb(err);
              });
              break;
            case "ignore":
              this._ignore(msg.target, msg.data.value.ignore.reason, (err, obj) => {
                cb(err);
              });
              break;
            case "unignore":
              this._unignore(msg.target, (err, obj) => {
                cb(err);
              });
              break;
            case "notify":
              this._notify(msg.target, msg.data.value.notify, (err, obj) => {
                cb(err);
              });
              break;
            case "portforward":
              this._portforward(msg.target, msg.data.value.portforward, (err, obj) => {
                cb(err);
              });
            case "upstreamDns":
              this._setUpstreamDns(msg.target, msg.data.value.upstreamDns, (err, obj) => {
                cb(err);
              });
              break;
          default:
            let target = msg.target
            let policyData = msg.data.value[o]

            //            if(extMgr.hasExtension(o)) {
              this.hostManager.loadPolicy((err, data) => {
                this.hostManager.setPolicy(o,
                                           policyData,
                                           (err, data) => {
                  cb(err)
                })
              })
            // } else {
            //   cb(null)
            // }
            break
          }
        }, (err) => {
          let reply = {
            type: 'jsonmsg',
            mtype: 'policy',
            id: uuid.v4(),
            expires: Math.floor(Date.now() / 1000) + 60 * 5,
            replyid: msg.id,
          };
          reply.code = 200;
          reply.data = msg.data.value;
          log.info("Repling ", reply.code, reply.data);
          this.txData(this.primarygid, "", reply, "jsondata", "", null, callback);

        });
        break;
      case "host":
        //data.item = "host" test
        //data.value = "{ name: " "}"
        let data = msg.data;
        log.info("Setting Host", msg);
        let reply = {
          type: 'jsonmsg',
          mtype: 'init',
          id: uuid.v4(),
          expires: Math.floor(Date.now() / 1000) + 60 * 5,
          replyid: msg.id,
        };
        reply.code = 200;

        if(!data.value.name) {
          this.simpleTxData(msg, {}, new Error("host name required for setting name"), callback)
          return
        }

        async(() => {
          let ip = null

          if(hostTool.isMacAddress(msg.target)) {
            const macAddress = msg.target
            log.info("set host name alias by mac address", macAddress, {})

            let macObject = {
              name: data.value.name,
              mac: macAddress
            }

            await (hostTool.updateMACKey(macObject, true))

            this.simpleTxData(msg, {}, null, callback)
            
            return

          } else {
            ip = msg.target
          }

          let host = await (this.hostManager.getHostAsync(ip))

          if(!host) {
            this.simpleTxData(msg, {}, new Error("invalid host"), callback)
            return
          }

          if(data.value.name == host.o.name) {
            this.simpleTxData(msg, {}, null, callback)
            return
          }

          host.o.name = data.value.name
          log.info("Changing names", host.o.name);
          host.save(null, (err) => {
            if (err) {
              this.simpleTxData(msg, {}, new Error("failed to save host name"), callback)
            } else {
              this.simpleTxData(msg, {}, null, callback)
            }
          });

        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        
        break;
      case "intel":
        // intel actions
        //   - ignore / unignore
        //   - report
        //   - block / unblockj
        intelManager.action(msg.target, msg.data.value.action, (err) => {
          let reply = {
            type: 'jsonmsg',
            mtype: 'init',
            id: uuid.v4(),
            expires: Math.floor(Date.now() / 1000) + 60 * 5,
            replyid: msg.id,
          };
          reply.code = 200;
          this.txData(this.primarygid, "", reply, "jsondata", "", null, callback);
        });
        break;
      case "scisurfconfig":
        let v = msg.data.value;
        
        if (v.from && v.from === "firewalla") {
          const mssc = require('../extension/ss_client/multi_ss_client.js');
          mssc.saveConfig(v)
            .then(() => this.simpleTxData(msg, {}, null, callback))
            .catch((err) => this.simpleTxData(msg, null, err, callback));
        } else {
          this.simpleTxData(msg, {}, new Error("Invalid config"), callback);
        }

        break;
      case "language":
        let v2 = msg.data.value;

        // TODO validate input?
        if (v2.language) {
          sysManager.setLanguage(v2.language, (err) => {
            this.simpleTxData(msg, {}, err, callback);
          });
        }
        break;
      case "timezone":
        let v3 = msg.data.value;

        if (v3.timezone) {
          sysManager.setTimezone(v3.timezone, (err) => {
            this.simpleTxData(msg, {}, err, callback);
          });
        }
      break;
    case "includeNameInNotification":
      let v33 = msg.data.value;

      let flag = "0";

      if(v33.includeNameInNotification) {
        flag = "1"
      }

      async(() => {
        await (rclient.hsetAsync("sys:config", "includeNameInNotification", flag))
        this.simpleTxData(msg, {}, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, {}, err, callback)
      })

      break;
    case "mode":
      let v4 = msg.data.value;
      let err = null;
      
      if (v4.mode) {
        async(() => {
          let mode = require('../net2/Mode.js')
          let curMode = await (mode.getSetupMode())        
          if(v4.mode === curMode) {
            this.simpleTxData(msg, {}, err, callback);
            return
          }
          
          let modeManager = require('../net2/ModeManager.js');
          switch (v4.mode) {
          case "spoof":
          case "autoSpoof":
            modeManager.setAutoSpoofAndPublish()
            break;
          case "manualSpoof":
            modeManager.setManualSpoofAndPublish()
            break;
          case "dhcp":
            modeManager.setDHCPAndPublish()
            break;
          case "none":
            modeManager.setNoneAndPublish()
            break;
          default:
            log.error("unsupported mode: " + v4.mode);
            err = new Error("unsupport mode: " + v4.mode);
            break;
          }

          // force sysManager.update after set mode, this is to prevent device assigned in 218.* 
          // can't be discovered by fireapi if sysManager.update is not called (Thanks to Annie)
          sysManager.update((err, data) => {
          });

          this.simpleTxData(msg, {}, err, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
      }
      break;
    default:
        this.simpleTxData(msg, null, new Error("Unsupported action"), callback);
        break;
    }
  }


  getAllIPForHost(ip, callback) {
    let listip = [];
    this.hostManager.getHost(ip, (err, host) => {
      if (host != null) {
        listip.push(host.o.ipv4Addr);
        if (host.ipv6Addr && host.ipv6Addr.length > 0) {
          for (let j in host['ipv6Addr']) {
            listip.push(host['ipv6Addr'][j]);
          }
        }
      }
      callback(err, listip);
    });
  }


  processAppInfo(appInfo) {
    return async(() => {
      if(appInfo.language) {
        if(sysManager.language !== appInfo.language) {
          await (sysManager.setLanguageAsync(appInfo.language))
        }
      }

      if(appInfo.deviceName && appInfo.eid) {
        const keyName = "sys:ept:memberNames"
        await (rclient.hsetAsync(keyName, appInfo.eid, appInfo.deviceName))

        const keyName2 = "sys:ept:member:lastvisit"
        await (rclient.hsetAsync(keyName2, appInfo.eid, Math.floor(new Date() / 1000)))
      }

    })()
  }

  getHandler(gid, msg, appInfo, callback) {

    // backward compatible
    if(typeof appInfo === 'function') {
      callback = appInfo;
      appInfo = undefined;
    }

    if(appInfo) {
      this.processAppInfo(appInfo)
    }

    // mtype: get
    // target = ip address
    // data.item = [app, alarms, host]
    if(extMgr.hasGet(msg.data.item)) {
      async(() => {
        const result = await (extMgr.get(msg.data.item, msg))
        this.simpleTxData(msg, result, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, null, err, callback)
      })
      return
    }

    switch (msg.data.item) {
      case "host":
        if (msg.target) {
          let useNewDeviceHandler = appTool.isAppReadyForNewDeviceHandler(appInfo);
          if(useNewDeviceHandler) {
            let ip = msg.target;
            log.info("Loading device info in a new way:", ip);
            this.newDeviceHandler(msg, ip)
            .then((json) => {
              this.simpleTxData(msg, json, null, callback);
            })
            .catch((err) => {
              this.simpleTxData(msg, null, err, callback);
            })
          } else {
            log.info("Using the legacy way to get device info:", msg.target, {});
            this.getAllIPForHost(msg.target, (err, ips) => {
              this.deviceHandler(msg, gid, msg.target, ips, callback);
            });
          }
        }
        break;
      case "vpn":
      case "vpnreset":
        let regenerate = false
        if (msg.data.item === "vpnreset") {
          regenerate = true;
        }

        this.hostManager.loadPolicy((err, data) => {
          let datamodel = {
            type: 'jsonmsg',
            mtype: 'reply',
            id: uuid.v4(),
            expires: Math.floor(Date.now() / 1000) + 60 * 5,
            replyid: msg.id,
            code: 404,
          };
          if (err != null) {
            log.error("Failed to load system policy for VPN", err);
            this.txData(this.primarygid, "device", datamodel, "jsondata", "", null, callback);
          } else {
            // this should set local port of VpnManager, which will be used in getOvpnFile
            vpnManager.configure(JSON.parse(data["vpn"]), (err) => {
              if (err != null) {
                log.error("Failed to configure VPN", err);
                this.txData(this.primarygid, "device", datamodel, "jsondata", "", null, callback);
              } else {
                vpnManager.getOvpnFile("fishboneVPN1", null, regenerate, (err, ovpnfile, password) => {
                  if (err == null) {
                    datamodel.code = 200;
                    datamodel.data = {
                      ovpnfile: ovpnfile,
                      password: password,
                      portmapped: this.hostManager.policy['vpnPortmapped']
                    }
                  }
                  this.txData(this.primarygid, "device", datamodel, "jsondata", "", null, callback);
                });
              }
            }); 
          }
        });
        break;
      case "shadowsocks":
      case "shadowsocksResetConfig":
        let shadowsocks = require('../extension/shadowsocks/shadowsocks.js');
        let ss = new shadowsocks('info');

        if (msg.data.item === "shadowsocksResetConfig") {
          ss.refreshConfig();
        }

        let config = ss.readConfig();
        let datamodel = {
          type: 'jsonmsg',
          mtype: 'reply',
          id: uuid.v4(),
          expires: Math.floor(Date.now() / 1000) + 60 * 5,
          replyid: msg.id,
          code: 200,
          data: {
            config: config
          }
        };
        this.txData(this.primarygid, "device", datamodel, "jsondata", "", null, callback);
        break;
      case "generateRSAPublicKey": {
        const identity = msg.data.value.identity;
        (async () => {
          const regenerate = msg.data.value.regenerate;
          const prevKey = await ssh.getRSAPublicKey(identity);
          if (prevKey === null || regenerate) {
            await ssh.generateRSAKeyPair(identity);
            const pubKey = await ssh.getRSAPublicKey(identity);
            this.simpleTxData(msg, {publicKey: pubKey}, null, callback);
          } else this.simpleTxData(msg, {publicKey: prevKey}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "sshPrivateKey":

        ssh.getPrivateKey((err, data) => {
          if (err) {
            log.error("Got error when loading ssh private key: " + err);
            data = "";
          }

          let datamodel = {
            type: 'jsonmsg',
            mtype: 'reply',
            id: uuid.v4(),
            expires: Math.floor(Date.now() / 1000) + 60 * 5,
            replyid: msg.id,
            code: 200,
            data: {
              key: data
            }
          };
          this.txData(this.primarygid, "device", datamodel, "jsondata", "", null, callback);
        });
        break;
      case "sshRecentPassword":
        ssh.getPassword((err, password) => {

          let data = "";

          if (err) {
            log.error("Got error when reading password: " + err);
            this.simpleTxData(msg, {}, err, callback);
          } else {
            this.simpleTxData(msg, {password: password}, err, callback);
          }
        });
        break;
      case "sysInfo":
        let si = require('../extension/sysinfo/SysInfo.js');
        this.simpleTxData(msg, si.getSysInfo(), null, callback);
        break;
      case "logFiles":
        let si2 = require('../extension/sysinfo/SysInfo.js');
        si2.getRecentLogs((err, results) => {
          this.simpleTxData(msg, results, null, callback);
        });
        break;
      case "scisurfconfig":
        let mssc = require('../extension/ss_client/multi_ss_client.js');

        mssc.loadConfig()
          .then((result) => this.simpleTxData(msg, result || {}, null, callback))
          .catch((err) => this.simpleTxData(msg, null, err, callback));
        break;
      case "language":
        this.simpleTxData(msg, {language: sysManager.language}, null, callback);
        break;
      case "timezone":
        this.simpleTxData(msg, {timezone: sysManager.timezone}, null, callback);
        break;
      case "alarms":
        am2.loadActiveAlarms((err, alarms) => {
          this.simpleTxData(msg, {alarms: alarms, count: alarms.length}, err, callback);
        });
        break;
      case "alarm":
        let alarmID = msg.data.value.alarmID;
        am2.getAlarm(alarmID)
          .then((alarm) => this.simpleTxData(msg, alarm, null, callback))
          .catch((err) => this.simpleTxData(msg, null, err, callback));
        break;
      case "alarmDetail": {
        const alarmID = msg.data.value.alarmID;
        (async () => {
          if(alarmID) {
            let detail = await am2.getAlarmDetail(alarmID); 
            detail = detail || {}; // return empty {} if no extended alarm detail;
            
            this.simpleTxData(msg, detail, null, callback);  
          } else {
            this.simpleTxData(msg, {}, new Error("Missing alarm ID"), callback);
          }
        })().catch((err) => this.simpleTxData(msg, null, err, callback));
        break;
      }
      case "selfCheck": {
        (async () => {
          const sc = require("../diagnostic/selfcheck.js");
          const result = await sc.check();
          this.simpleTxData(msg, result, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        });
        break;
      }
      case "blockCheck": {
        const ipOrDomain = msg.data.value.ipOrDomain;
        (async () => {
          const rc = require("../diagnostic/rulecheck.js");
          const result = await rc.checkIpOrDomain(ipOrDomain);
          this.simpleTxData(msg, result, null, callback);
        })().catch((err) => {
          this.siimpleTxData(msg, null, err, callback);
        });
        break;
      }
      case "transferTrend": {
        const deviceMac = msg.data.value.deviceMac;
        const destIP = msg.data.value.destIP;
        (async () => {
          if(destIP && deviceMac) {
            const transfers = await flowTool.getTransferTrend(deviceMac, destIP);
            this.simpleTxData(msg, transfers, null, callback); 
          } else {
            this.simpleTxData(msg, {}, new Error("Missing device MAC or destination IP"), callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })
        break;
      }
      case "archivedAlarms":
        const offset = msg.data.value && msg.data.value.offset
        const limit = msg.data.value && msg.data.value.limit

        async(() => {
          const archivedAlarms = await(am2.loadArchivedAlarms({
            offset: offset,
            limit: limit
          }))
          this.simpleTxData(msg,
            {
              alarms: archivedAlarms,
              count: archivedAlarms.length
            },
            null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break
      case "exceptions":
        em.loadExceptions((err, exceptions) => {
          this.simpleTxData(msg, {exceptions: exceptions, count: exceptions.length}, err, callback);
        });
        break;
      case "frpConfig":
        let _config = frp.getConfig()
        if (_config.started) {
          let getPasswordAsync = Promise.promisify(ssh.getPassword)
          getPasswordAsync().then((password) => {
            _config.password = password
            this.simpleTxData(msg, _config, null, callback);
          }).catch((err) => {
            this.simpleTxData(msg, null, err, callback);
          })
        } else {
          this.simpleTxData(msg, _config, null, callback);
        }
        break;
      case "last60mins":
        async(() => {
          let downloadStats = await(getHitsAsync("download", "1minute", 60))
          let uploadStats = await(getHitsAsync("upload", "1minute", 60))
          this.simpleTxData(msg, {
            upload: uploadStats,
            download: downloadStats
          }, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break;
      case "upstreamDns":
        (async () => {
          let response;
          try {
            response = await policyManager.getUpstreamDns();
            log.info("upstream dns response", response);
            this.simpleTxData(msg, response, null, callback);
          } catch (err) {
            log.error("Error when get upstream dns configs", err);
            this.simpleTxData(msg, {}, err, callback);
          }
        })();
        break;
      case "liveCategoryDomains":
        (async () => {
          const category = msg.data.value.category
          const domains = await categoryUpdater.getDomainsWithExpireTime(category)
          this.simpleTxData(msg, {domains: domains}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break
      case "liveCategoryDomainsWithoutExcluded":
        (async () => {
          const category = msg.data.value.category
          const domains = await categoryUpdater.getDomainsWithExpireTime(category)
          const excludedDomains = await categoryUpdater.getExcludedDomains(category)
          const defaultDomains = await categoryUpdater.getDefaultDomains(category)
          const includedDomains = await categoryUpdater.getIncludedDomains(category)

          const finalDomains = domains.filter((de) => {
            return !excludedDomains.includes(de.domain) && !defaultDomains.includes(de.domain)
          })

          finalDomains.push.apply(finalDomains, defaultDomains.map((d) => {
            return {domain: d, expire: 0};
          }))

          let compareFuction = (x, y) => {
            if(!x || !y) {
              return 0;
            }

            let a = x.domain
            let b = y.domain

            if(!a || !b) {
              return 0;
            }

            if(a.startsWith("*.")) {
              a = a.substring(2)
            }
            if(b.startsWith("*.")) {
              b = b.substring(2)
            }

            if (a.toLowerCase() > b.toLowerCase()) {
              return 1
            } else if (a.toLowerCase() < b.toLowerCase()) {
              return -1
            } else {
              return 0
            }
          };

          let sortedFinalDomains = finalDomains.sort(compareFuction)

          const patternDomains = sortedFinalDomains.filter((de) => {
            return de.domain.startsWith("*.")
          }).map((de) => de.domain.substring(2))

          // dedup battle.net if battle.net and *.battle.net co-exist
          const outputDomains = sortedFinalDomains.filter((de) => {
            const domain = de.domain
            if(!domain.startsWith("*.") && patternDomains.includes(domain)) {
              return false;
            } else {
              return true;
            }
          })

          this.simpleTxData(msg, {domains: outputDomains, includes: includedDomains}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break
      case "includedDomains":
        (async () => {
          const category = msg.data.value.category
          const domains = await (categoryUpdater.getIncludedDomains(category))
          this.simpleTxData(msg, {domains: domains}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break
      case "excludedDomains":
        (async () => {
          const category = msg.data.value.category
          const domains = await (categoryUpdater.getExcludedDomains(category))
          this.simpleTxData(msg, {domains: domains}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break
      case "whois":
        (async () => {
          const target = msg.data.value.target;
          let whois = await intelManager.whois(target);
          this.simpleTxData(msg, {target, whois}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "ipinfo":
        (async () => {
          const ip = msg.data.value.ip;
          let ipinfo = intelManager.ipinfo(ip);
          this.simpleTxData(msg, {ip, ipinfo}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "proToken":
        (async () => {
          this.simpleTxData(msg, {token: tokenManager.getToken(gid)}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "policies":
        pm2.loadActivePolicys((err, list) => {
          if(err) {
            this.simpleTxData(msg, {}, err, callback);
          } else {
            let alarmIDs = list.map((p) => p.aid);
            am2.idsToAlarms(alarmIDs, (err, alarms) => {
              if(err) {
                log.error("Failed to get alarms by ids:", err, {});
                this.simpleTxData(msg, {}, err, callback);
                return;
              }
      
              for(let i = 0; i < list.length; i ++) {
                if(list[i] && alarms[i]) {
                  list[i].alarmMessage = alarms[i].localizedInfo();
                  list[i].alarmTimestamp = alarms[i].timestamp;
                }
              }
              this.simpleTxData(msg, {policies: list}, null, callback);
            });
          }
        });
        break;
      case "hosts":
        let hosts = {};
        this.hostManager.getHosts(() => {
          this.hostManager.legacyHostsStats(hosts)
            .then(() => {
              this.simpleTxData(msg, hosts, null, callback);
            }).catch((err) => {
              this.simpleTxData(msg, {}, err, callback);
            });
        });
        break;
    default:
        this.simpleTxData(msg, null, new Error("unsupported action"), callback);
    }
  }

  validateFlowAppIntel(json) {
    return async(() => {
      // await (bone.flowgraphAsync(...))
      let flows = json.flows

      let hashCache = {}

      let appFlows = flows.appDetails

      if(Object.keys(appFlows).length > 0) {
        flowUtil.hashIntelFlows(appFlows, hashCache)

        let data;
        try {
          data = await(bone.flowgraphAsync('summarizeApp', appFlows))
        } catch (err) {
          log.error("Error when summarizing flowgraph for app", err);
        }
        
        if (data) {
          flows.appDetails = flowUtil.unhashIntelFlows(data, hashCache)
        }
      }
    })()
  }

  validateFlowCategoryIntel(json) {
    return async(() => {
      // await (bone.flowgraphAsync(...))
      let flows = json.flows

      let hashCache = {}

      let categoryFlows = flows.categoryDetails

      if(Object.keys(categoryFlows).length > 0) {
        flowUtil.hashIntelFlows(categoryFlows, hashCache)
        
        let data;
        try {
          data = await(bone.flowgraphAsync('summarizeActivity', categoryFlows))
        } catch (err) {
          log.error("Error when summarizing flowgraph for activity", err);
        }
        
        if (data) {
          flows.categoryDetails = flowUtil.unhashIntelFlows(data, hashCache)
        }
      }
    })()
  }

  
  systemFlowHandler(msg) {
    log.info("Getting flow info of the entire network");

    let begin = msg.data && msg.data.start;
    //let end = msg.data && msg.data.end;
    let end = begin && (begin + 3600);

    if(!begin || !end) {
      return Promise.reject(new Error("Require begin and error when calling systemFlowHandler"));
    }

    log.info("FROM: ", new Date(begin * 1000).toLocaleTimeString());
    log.info("TO: ", new Date(end * 1000).toLocaleTimeString());

    return async(() => {
      let jsonobj = {};
      let options = {
        begin: begin,
        end: end
      }
      
      await ([
        flowTool.prepareRecentFlows(jsonobj, options),
        netBotTool.prepareTopUploadFlows(jsonobj, options),
        netBotTool.prepareTopDownloadFlows(jsonobj, options),
        netBotTool.prepareDetailedAppFlowsFromCache(jsonobj, options),
        netBotTool.prepareDetailedCategoryFlowsFromCache(jsonobj, options)])

      if(!jsonobj.flows['appDetails']) { // fallback to old way
        await (netBotTool.prepareDetailedAppFlows(jsonobj, options))
        await (this.validateFlowAppIntel(jsonobj))
      }

      if(!jsonobj.flows['categoryDetails']) { // fallback to old model
        await (netBotTool.prepareDetailedCategoryFlows(jsonobj, options))
        await (this.validateFlowCategoryIntel(jsonobj))
      }

      return jsonobj;
    })();
  }
  
  newDeviceHandler(msg, ip) { // WARNING: ip could be ip address or mac address, name it ip is just for backward compatible
    log.info("Getting info on device", ip, {});

    return async(() => {
      if(ip === '0.0.0.0') {
        return this.systemFlowHandler(msg);
      }

      let begin = msg.data && msg.data.start;
      let end = (msg.data && msg.data.end) || begin + 3600 * 24;

      let options = {}
      if(begin && end) {
        options.begin = begin
        options.end = end
      }

      if(msg.data.hourblock != "1" &&
         msg.data.hourblock != "0" ) { // 0 => now, 1 => single hour stats, other => overall stats (last 24 hours)
        options.queryall = true
      }
      
      if(hostTool.isMacAddress(ip)) {
        log.info("Loading host info by mac address", ip, {})
        const macAddress = ip
        const hostObject = await (hostTool.getMACEntry(macAddress))
        
        if(hostObject && hostObject.ipv4Addr) {
          ip = hostObject.ipv4Addr       // !! Reassign ip address to the real ip address queried by mac
        } else {
          let error = new Error("Invalid Mac");
          error.code = 404;
          return Promise.reject(error);
        }        
      }

      let host = await (this.hostManager.getHostAsync(ip));
      if(!host || !host.o.mac) {
        let error = new Error("Invalid Host");
        error.code = 404;
        return Promise.reject(error);
      }

      let mac = host.o.mac;

      // load 24 hours download/upload trend
      await (flowManager.getStats2(host));

      let jsonobj = {};
      if (host) {
        jsonobj = host.toJson();

        await ([
          flowTool.prepareRecentFlowsForHost(jsonobj, mac, options),
          netBotTool.prepareTopUploadFlowsForHost(jsonobj, mac, options),
          netBotTool.prepareTopDownloadFlowsForHost(jsonobj, mac, options),
          netBotTool.prepareAppActivityFlowsForHost(jsonobj, mac, options),
          netBotTool.prepareCategoryActivityFlowsForHost(jsonobj, mac, options),
          
          netBotTool.prepareDetailedAppFlowsForHostFromCache(jsonobj, mac, options),
          netBotTool.prepareDetailedCategoryFlowsForHostFromCache(jsonobj, mac, options)])

        if(!jsonobj.flows["appDetails"]) {
          log.warn("Fell back to legacy mode on app details:", mac, options, {})
          await (netBotTool.prepareAppActivityFlowsForHost(jsonobj, mac, options))
          await (this.validateFlowAppIntel(jsonobj))
        }

        if(!jsonobj.flows["categoryDetails"]) {
          log.warn("Fell back to legacy mode on category details:", mac, options, {})
          await (netBotTool.prepareCategoryActivityFlowsForHost(jsonobj, mac, options))
          await (this.validateFlowCategoryIntel(jsonobj))
        }
      }

      return jsonobj;
    })();
  }

  deviceHandler(msg, gid, target, listip, callback) {
    log.info("Getting Devices", gid, target, listip);
    let hosts = [];
    this.hostManager.getHost(target, (err, host) => {
      if (host == null && target != "0.0.0.0") {
        let datamodel = {
          type: 'jsonmsg',
          mtype: 'reply',
          id: uuid.v4(),
          expires: Math.floor(Date.now() / 1000) + 60 * 5,
          replyid: msg.id,
          code: 404,
        };
        this.txData(this.primarygid, "device", datamodel, "jsondata", "", null, callback);
        return;
      } else if (target == "0.0.0.0") {
        listip = [];
        for (let h in this.hostManager.hosts.all) {
          let _host = this.hostManager.hosts.all[h];
          hosts.push(_host);
          listip.push(_host.o.ipv4Addr);
          if (_host.ipv6Addr && _host.ipv6Addr.length > 0) {
            for (let p in _host['ipv6Addr']) {
              listip.push(_host['ipv6Addr'][p]);
            }
          }
        }
      } else {
        hosts = [host];
      }

      log.info("Summarize", target, listip);


      //  flowManager.summarizeBytes([host], msg.data.end, msg.data.start, (msg.data.end - msg.data.start) / 16, (err, sys) => {

      // getStats2 => load 24 hours download/upload trend
      flowManager.getStats2(host)
        .then(() => {
//            flowManager.summarizeBytes2(hosts, Date.now() / 1000 - 60*60*24, -1,'hour', (err, sys) => {
//                log.info("Summarized devices: ", msg.data.end, msg.data.start, (msg.data.end - msg.data.start) / 16,sys,{});
          let jsonobj = {};
          if (host) {
            jsonobj = host.toJson();
          }
          alarmManager.read(target, msg.data.alarmduration, null, null, null, (err, alarms) => {
            log.info("Found alarms");
            jsonobj.alarms = alarms;
            // hour block = summarize into blocks of hours ...
            flowManager.summarizeConnections(listip, msg.data.direction, msg.data.end, msg.data.start, "time", msg.data.hourblock, true, false, (err, result, activities) => {
              log.info("--- Connectionby most recent ---", result.length);
              let response = {
                time: [],
                rx: [],
                tx: [],
                duration: []
              };
              let max = 50;
              for (let i in result) {
                let s = result[i];
                response.time.push(s);
                if (max-- < 0) {
                  break;
                }
              }
              flowManager.sort(result, 'rxdata');
              log.info("-----------Sort by rx------------------------");
              max = 15;
              for (let i in result) {
                let s = result[i];
                response.rx.push(s);
                if (max-- < 0) {
                  break;
                }
              }
              //log.info(JSON.stringify(response.rx));
              flowManager.sort(result, 'txdata');
              log.info("-----------  Sort by tx------------------");
              max = 15;
              for (let i in result) {
                let s = result[i];
                response.tx.push(s);
                if (max-- < 0) {
                  break;
                }
              }
              jsonobj.flows = response;
              jsonobj.activities = activities;

              /*
               flowManager.sort(result, 'duration');
               log.info("-----------Sort by rx------------------------");
               max = 10;
               for (let i in result) {
               let s = result[i];
               response.duration.push(s);
               if (max-- < 0) {
               break;
               }
               }
               */

              // enrich flow info with country
              this.enrichCountryInfo(jsonobj.flows);

              // use new way to get recent connections
              Promise.all([
//                flowTool.prepareRecentFlowsForHost(jsonobj, listip)
              ]).then(() => {
                this.simpleTxData(msg, jsonobj, null, callback);
              }).catch((err) => {
                this.simpleTxData(msg, null, err, callback);
              });
            });
          });
        });

    });
  }

  enrichCountryInfo(flows) {
    // support time flow first
    let flowsSet = [flows.time, flows.rx, flows.tx, flows.download, flows.upload];

    flowsSet.forEach((eachFlows) => {
      if(!eachFlows)
        return;

      eachFlows.forEach((flow) => {

        if(flow.ip) {
          flow.country = country.getCountry(flow.ip);
          return;
        }

        let sh = flow.sh;
        let dh = flow.dh;
        let lh = flow.lh;

        if (sh === lh) {
          flow.country = country.getCountry(dh);
        } else {
          flow.country = country.getCountry(sh);
        }
      });

    });
  }

  /*
   Received jsondata { mtype: 'cmd',
   id: '6C998946-ECC6-4535-90C5-E9525D4BB5B6',
   data: { item: 'reboot' },
   type: 'jsonmsg',
   target: '0.0.0.0' }
   */

  cmdHandler(gid, msg, callback) {

    if(msg && msg.data && msg.data.item === 'ping') {

      } else {
        log.info("API: CmdHandler ",gid,msg,{});
      }
    if(msg.data.item === "dhcpCheck") {
      (async() => {
        let mode = require('../net2/Mode.js');
        await mode.reloadSetupMode();
        let dhcpModeOn = await mode.isDHCPModeOn();
        if (dhcpModeOn) {
          const dhcpFound = await dhcp.dhcpDiscover("eth0");
          const response = {
            DHCPMode: true,
            DHCPDiscover: dhcpFound
          };
          this.simpleTxData(msg, response, null, callback);
        } else {
          this.simpleTxData(msg, {DHCPMode: false}, null, callback);
        }        
      })().catch((err) => {
        log.error("Failed to do DHCP discover", err);
        this.simpleTxData(msg, null, err, callback);
      });
      return;
    }
    if (msg.data.item === "reset") {
      log.info("System Reset");
      DeviceMgmtTool.deleteGroup(this.eptcloud, this.primarygid);
      DeviceMgmtTool.resetDevice()

      // direct reply back to app that system is being reset
      this.simpleTxData(msg, null, null, callback)
      return;
    } else if (msg.data.item === "sendlog") {
      log.info("sendLog");
      this._sendLog(msg,callback);
      return;
    } else if (msg.data.item === "resetSSHKey") {
      ssh.resetRSAPassword((err) => {
        let code = 200;

        let datamodel = {
          type: 'jsonmsg',
          mtype: 'init',
          id: uuid.v4(),
          expires: Math.floor(Date.now() / 1000) + 60 * 5,
          replyid: msg.id,
          code: code
        }
        this.txData(this.primarygid, "resetSSHKey", datamodel, "jsondata", "", null, callback);
      });
      return;
    }

    switch (msg.data.item) {
      case "upgrade":
        async(() => {
          sysTool.upgradeToLatest()
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break
      case "shutdown":
        async(() => {
          sysTool.shutdownServices()
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break
      case "reboot":
        async(() => {
          sysTool.rebootServices()
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break
      case "resetpolicy":
        async(() => {
          sysTool.resetPolicy()
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break
      case "debugOn":
        sysManager.debugOn((err) => {
          this.simpleTxData(msg, null, err, callback);
        });
        break;
      case "debugOff":
        sysManager.debugOff((err) => {
          this.simpleTxData(msg, null, err, callback);
        });
        break;
      case "resetSSHPassword":
        ssh.resetRandomPassword((err, password) => {
          sysManager.setSSHPassword(password);
          this.simpleTxData(msg, null, err, callback);
        });
        break;

      case "resetSciSurfConfig":
        const mssc = require('../extension/ss_client/multi_ss_client.js');
        (async () => {
          try {
            await mssc.stop();
            await mssc.clearConfig();  
          } finally {
            this.simpleTxData(msg, null, err, callback);  
          }
        })();
        break;
      case "ping":
        let uptime = process.uptime();
        let now = new Date();

        let datamodel = {
          type: 'jsonmsg',
          mtype: 'reply',
          id: uuid.v4(),
          expires: Math.floor(Date.now() / 1000) + 60 * 5,
          replyid: msg.id,
          code: 200,
          data: {
            uptime: uptime,
            timestamp: now
          }
        };
        this.txData(this.primarygid, "device", datamodel, "jsondata", "", null, callback);
        break;
    case "alarm:block":
      am2.blockFromAlarm(msg.data.value.alarmID, msg.data.value, (err, policy, otherBlockedAlarms, alreadyExists) => {
        if(msg.data.value && msg.data.value.matchAll) { // only block other matched alarms if this option is on, for better backward compatibility
          this.simpleTxData(msg, {
            policy: policy,
            otherAlarms: otherBlockedAlarms,
            alreadyExists: alreadyExists === "duplicated",
            updated: alreadyExists === "duplicated_and_updated"
          }, err, callback);
        } else {
          this.simpleTxData(msg, policy, err, callback);
        }
      });
      break;
    case "alarm:allow":
      am2.allowFromAlarm(msg.data.value.alarmID, msg.data.value, (err, exception, otherAlarms, alreadyExists) => {
        if(msg.data.value && msg.data.value.matchAll) { // only block other matched alarms if this option is on, for better backward compatibility
          this.simpleTxData(msg, {
            exception: exception,
            otherAlarms: otherAlarms,
            alreadyExists: alreadyExists
          }, err, callback);
        } else {
          this.simpleTxData(msg, exception, err, callback);
        }
      });
      break;
    case "alarm:unblock":
        am2.unblockFromAlarm(msg.data.value.alarmID, msg.data.value, (err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "alarm:unallow":
        am2.unallowFromAlarm(msg.data.value.alarmID, msg.data.value, (err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;

      case "alarm:unblock_and_allow":
        am2.unblockFromAlarm(msg.data.value.alarmID, msg.data.value, (err) => {
          if (err) {
            log.error("Failed to unblock", msg.data.value.alarmID, ", err:", err, {});
            this.simpleTxData(msg, {}, err, callback);
            return;
          }

          am2.allowFromAlarm(msg.data.value.alarmID, msg.data.value, (err) => {
            if (err) {
              log.error("Failed to allow", msg.data.value.alarmID, ", err:", err, {});
            }
            this.simpleTxData(msg, {}, err, callback);
          });
        });

    case "alarm:ignore":
      async(() => {
        await (am2.ignoreAlarm(msg.data.value.alarmID))
        this.simpleTxData(msg, {}, null, callback)
      })().catch((err) => {
        log.error("Failed to ignore alarm:", err, {})
        this.simpleTxData(msg, {}, err, callback)
      })
      break

    case "alarm:report":
      async(() => {
        await (am2.reportBug(msg.data.value.alarmID, msg.data.value.feedback))
        this.simpleTxData(msg, {}, null, callback)
      })().catch((err) => {
        log.error("Failed to report bug on alarm:", err, {})
        this.simpleTxData(msg, {}, err, callback)
      })
      break

      case "policy:create":
        pm2.createPolicyFromJson(msg.data.value, (err, policy) => {
          if (err) {
            this.simpleTxData(msg, null, err, callback);
            return;
          }

          pm2.checkAndSave(policy, (err, policy2, alreadyExists) => {
            if(alreadyExists == "duplicated") {
              this.simpleTxData(msg, null, new Error("Policy already exists"), callback)
              return
            } else if(alreadyExists == "duplicated_and_updated") {
              const p = JSON.parse(JSON.stringify(policy2))
              p.updated = true // a kind hacky, but works
              this.simpleTxData(msg, p, err, callback)
            } else {
              this.simpleTxData(msg, policy2, err, callback)
            }
          });
        });
        break;

      case "policy:update":
        async(() => {
          const policy = msg.data.value
          const pid = policy.pid
          const oldPolicy = await (pm2.getPolicy(pid))
          await (pm2.updatePolicyAsync(policy))
          const newPolicy = await (pm2.getPolicy(pid))
          await (pm2.tryPolicyEnforcement(newPolicy, 'reenforce', oldPolicy))
          this.simpleTxData(msg,newPolicy, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })

        break;    
    case "policy:delete":
      async(() => {
        let policy = await (pm2.getPolicy(msg.data.value.policyID))
        if(policy) {
          await (pm2.disableAndDeletePolicy(msg.data.value.policyID))
          policy.deleted = true // policy is marked ask deleted
          this.simpleTxData(msg, policy, null, callback);          
        } else {
          this.simpleTxData(msg, null, new Error("invalid policy"), callback);
        }
      })().catch((err) => {
        this.simpleTxData(msg, null, err, callback)
      })                 
      break;
    case "policy:enable":
      async(() => {
        const policyID = msg.data.value.policyID
        if(policyID) {
          let policy = await (pm2.getPolicy(msg.data.value.policyID))
          if(policy) {
            await (pm2.enablePolicy(policy))
            this.simpleTxData(msg, policy, null, callback);
          } else {
            this.simpleTxData(msg, null, new Error("invalid policy"), callback);
          }
        } else {
          this.simpleTxData(msg, null, new Error("invalid policy ID"), callback);
        }
      })()
      break;
    case "policy:disable":
      async(() => {
        const policyID = msg.data.value.policyID
        if(policyID) {
          let policy = await (pm2.getPolicy(msg.data.value.policyID))
          if(policy) {
            await (pm2.disablePolicy(policy))
            this.simpleTxData(msg, policy, null, callback);
          } else {
            this.simpleTxData(msg, null, new Error("invalid policy"), callback);
          }
        } else {
          this.simpleTxData(msg, null, new Error("invalid policy ID"), callback);
        }
      })()
      break;
    case "intel:finger":
      (async () => {
        const target = msg.data.value.target;
        if (target) {
          let result;
          try {
            result = await bone.intelFinger(target);
          } catch (err) {
            log.error("Error when intel finger", err, {});
          }
          if (result && result.whois) {
            this.simpleTxData(msg, result, null, callback);
          } else {
            this.simpleTxData(msg, null, new Error(`failed to fetch intel for target: ${target}`), callback);
          }
        } else {
          this.simpleTxData(msg, null, new Error(`invalid target: ${target}`), callback);
        }
      })();
      break;
      case "exception:create":
        em.createException(msg.data.value)
          .then((result) => {
            this.simpleTxData(msg, result, null, callback);
          })
          .catch((err) => {
            this.simpleTxData(msg, null, err, callback);
          });
        break;
      case "exception:update":
        em.updateException(msg.data.value)
          .then((result) => {
            this.simpleTxData(msg, result, null, callback);
          })
          .catch((err) => {
            this.simpleTxData(msg, null, err, callback);
          });
        break;
      case "exception:delete":
        em.deleteException(msg.data.value.exceptionID)
          .then(() => {
            this.simpleTxData(msg, null, null, callback);
          }).catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        });
        break;
      case "reset":
        break;
    case "startSupport":
      async(() => {
        await (frp.start())
        let config = frp.getConfig();
        let newPassword = await(ssh.resetRandomPasswordAsync())
        sysManager.setSSHPassword(newPassword); // in-memory update
        config.password = newPassword
        this.simpleTxData(msg, config, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, null, err, callback);
      })
      break;
    case "stopSupport":
      async(() => {
        await (frp.stop())
        let newPassword = await(ssh.resetRandomPasswordAsync())
        sysManager.setSSHPassword(newPassword); // in-memory update
        this.simpleTxData(msg, {}, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, null, err, callback);
      })
      break;
    case "setManualSpoof":
      async(() => {
        let mac = msg.data.value.mac
        let manualSpoof = msg.data.value.manualSpoof ? "1" : "0"

        if(!mac) {
          this.simpleTxData(msg, null, new Error("invalid request"), callback)
          return
        }
        
        await (hostTool.updateMACKey({
          mac: mac,
          manualSpoof: manualSpoof
        }))

        let mode = require('../net2/Mode.js')
        if(mode.isManualSpoofModeOn()) {
          await (spooferManager.loadManualSpoof(mac))
        }
        
        this.simpleTxData(msg, {}, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, null, err, callback)
      })
      break
    case "manualSpoofUpdate":
      async(() => {
        let modeManager = require('../net2/ModeManager.js');
        await (modeManager.publishManualSpoofUpdate())
        this.simpleTxData(msg, {}, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, null, err, callback)
      })
      break
    case "isSpoofRunning":
      async(() => {
        let timeout = msg.data.value.timeout

        let running = false
        
        if(timeout) {
          let begin = new Date() / 1000;

          let delayFunction = function(t) {
            return new Promise(function(resolve) {
              setTimeout(resolve, t)
            });
          }
          
          while(new Date() / 1000 < begin + timeout) {
            let secondsLeft =  (begin + timeout) - new Date() / 1000
            log.info(`Checking if spoofing daemon is active... ${secondsLeft} seconds left`)
            running = await (spooferManager.isSpoofRunning())
            if(running) {
              break
            }
            await(delayFunction(1000))
          }
          
        } else {
          running = await (spooferManager.isSpoofRunning())
        }
        
        this.simpleTxData(msg, {running: running}, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, null, err, callback)
      })
      break
    case "spoofMe":
      async(() => {
        let value = msg.data.value
        let ip = value.ip
        let name = value.name

        if(iptool.isV4Format(ip)) {
          sem.emitEvent({
            type: "DeviceUpdate",
            message: "Manual submit a new device via API",
            host: {
              ipv4: ip,
              ipv4Addr: ip,
              bname: name,
              from:"spoofMe"
            },
            toProcess: 'FireMain'
          })
          
          this.simpleTxData(msg, {}, null, callback)
        } else {
          this.simpleTxData(msg, {}, new Error("Invalid IP Address"), callback)  
        }
        
      })().catch((err) => {
        this.simpleTxData(msg, null, err, callback)
      })
      break
    case "validateSpoof": {
      async(() => {
        let ip = msg.data.value.ip
        let timeout = msg.data.value.timeout || 60 // by default, wait for 60 seconds

        // add current ip to spoof list
        await (spooferManager.directSpoof(ip))
        
        let begin = new Date() / 1000;

        let result = false

        let delayFunction = function(t) {
          return new Promise(function(resolve) {
            setTimeout(resolve, t)
          });
        }
        
        while(new Date() / 1000 < begin + timeout) {
          log.info(`Checking if IP ${ip} is being spoofed, ${-1 * (new Date() / 1000 - (begin + timeout))} seconds left`)
          result = await (spooferManager.isSpoof(ip))
          if(result) {
            break
          }
          await(delayFunction(1000))
        }
        
        this.simpleTxData(msg, {
          result: result
        }, null, callback)

      })().catch((err) => {
        this.simpleTxData(msg, null, err, callback);
      })
      break
    }
    case "spoof": {
      async(() => {
        let ip = msg.data.value.ip

        
      })()
    }
    case "bootingComplete":
      async(() => {
        await (f.setBootingComplete())
        this.simpleTxData(msg, {}, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, null, err, callback);
      })      
      break
    case "resetBootingComplete":
      async(() => {
        await (f.resetBootingComplete())
        this.simpleTxData(msg, {}, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, null, err, callback);
      })      
      break

    case "joinBeta":
      async(() => {
        await (this.switchBranch("beta"))
        this.simpleTxData(msg, {}, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, {}, err, callback)
      })
    case "leaveBeta":
      async(() => {
        await (this.switchBranch("prod"))
        this.simpleTxData(msg, {}, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, {}, err, callback)
      })
    case "switchBranch":
      let target = msg.data.value.target
      
      async(() => {
        await (this.switchBranch(target))
        this.simpleTxData(msg, {}, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, {}, err, callback)
      })

      break
    case "enableBinding":
      sysTool.restartFireKickService()
        .then(() => {
          this.simpleTxData(msg, {}, null, callback)
        })
        .catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
      break
    case "disableBinding":
      sysTool.stopFireKickService()
        .then(() => {
          this.simpleTxData(msg, {}, null, callback)
        })
        .catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
      break
    case "enableFeature": {
      const featureName = msg.data.value.featureName
      async(() => {
        if(featureName) {
          await (fc.enableDynamicFeature(featureName))
        }
      })().then(() => {
        this.simpleTxData(msg, {}, null, callback)
      })
      .catch((err) => {
        this.simpleTxData(msg, {}, err, callback)
      })    
      break
    }      
    case "disableFeature": {
      const featureName = msg.data.value.featureName
      async(() => {
        if(featureName) {
          await (fc.disableDynamicFeature(featureName))
        }
      })().then(() => {
        this.simpleTxData(msg, {}, null, callback)
      })
      .catch((err) => {
        this.simpleTxData(msg, {}, err, callback)
      })
      break
    }      
    case "clearFeatureDynamicFlag": {
      const featureName = msg.data.value.featureName
      async(() => {
        if(featureName) {
          await (fc.clearDynamicFeature(featureName))
        }
      })().then(() => {
        this.simpleTxData(msg, {}, null, callback)
      })
      .catch((err) => {
        this.simpleTxData(msg, {}, err, callback)
      })
      break
    }
    case "releaseMonkey": {
      async(() => {
        sem.emitEvent({
          type: "ReleaseMonkey",
          message: "Release a monkey to test system",
          toProcess: 'FireMain',
          monkeyType: msg.data.value && msg.data.value.monkeyType
        })
        this.simpleTxData(msg, {}, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, {}, err, callback)
      })
      break
    }
    case "addIncludeDomain": {
      (async () => {
        const category = msg.data.value.category
        const domain = msg.data.value.domain
        await (categoryUpdater.addIncludedDomain(category,domain))
        sem.emitEvent({
          type: "UPDATE_CATEGORY_DYNAMIC_DOMAIN",
          category: category,
          toProcess: "FireMain"
        })
        this.simpleTxData(msg, {}, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, {}, err, callback)
      })
      break;
    }
    case "removeIncludeDomain": {
      (async () => {
        const category = msg.data.value.category
        const domain = msg.data.value.domain
        await (categoryUpdater.removeIncludedDomain(category,domain))
        sem.emitEvent({
          type: "UPDATE_CATEGORY_DYNAMIC_DOMAIN",
          category: category,
          toProcess: "FireMain"
        })
        this.simpleTxData(msg, {}, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, {}, err, callback)
      })
      break;
    }
    case "addExcludeDomain": {
      (async () => {
        const category = msg.data.value.category
        const domain = msg.data.value.domain
        await (categoryUpdater.addExcludedDomain(category,domain))
        sem.emitEvent({
          type: "UPDATE_CATEGORY_DYNAMIC_DOMAIN",
          category: category,
          toProcess: "FireMain"
        })
        this.simpleTxData(msg, {}, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, {}, err, callback)
      })
      break;
    }
    case "removeExcludeDomain": {
      (async () => {
        const category = msg.data.value.category
        const domain = msg.data.value.domain
        await (categoryUpdater.removeExcludedDomain(category,domain))
        sem.emitEvent({
          type: "UPDATE_CATEGORY_DYNAMIC_DOMAIN",
          category: category,
          toProcess: "FireMain"
        })
        this.simpleTxData(msg, {}, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, {}, err, callback)
      })
      break;
    }
    case "startProServer": {
      proServer.startProServer();
      break;
    }
    case "stopProServer": {
      proServer.stopProServer();
      break;
    }
    case "generateProToken": {
      tokenManager.generateToken(gid);
      break;
    }
    case "revokeProToken": {
      tokenManager.revokeToken(gid);
      break;
    }
    case "saveRSAPublicKey": {
      const content = msg.data.value.pubKey;
      const identity = msg.data.value.identity;
      (async () => {
        await ssh.saveRSAPublicKey(content, identity);
        this.simpleTxData(msg, {}, null, callback);
      })().catch((err) => {
        this.simpleTxData(msg, {}, err, callback);
      });
      break;
    }
    case "migration:export": {
      const partition = msg.data.value.partition;
      const encryptionIdentity = msg.data.value.encryptionIdentity;
      (async () => {
        await migration.exportDataPartition(partition, encryptionIdentity);
        this.simpleTxData(msg, {}, null, callback);
      })().catch((err) => {
        this.simpleTxData(msg, {}, err, callback);
      });
      break;
    }
    case "migration:import": {
      const partition = msg.data.value.partition;
      const encryptionIdentity = msg.data.value.encryptionIdentity;
      (async () => {
        await migration.importDataPartition(partition, encryptionIdentity);
        this.simpleTxData(msg, {}, null, callback);
      })().catch((err) => {
        this.simpleTxData(msg, {}, err, callback);
      });
      break;
    }
    case "migration:transfer": {
      const host = msg.data.value.host;
      const partition = msg.data.value.partition;
      const transferIdentity = msg.data.value.transferIdentity;
      (async () => {
        await migration.transferDataPartition(host, partition, transferIdentity);
        this.simpleTxData(msg, {}, null, callback);
      })().catch((err) => {
        this.simpleTxData(msg, {}, err, callback);
      });
      break;
    }
    case "migration:transferHiddenFolder": {
      const host = msg.data.value.host;
      const transferIdentity = msg.data.value.transferIdentity;
      (async () => {
        await migration.transferHiddenFolder(host, transferIdentity);
        this.simpleTxData(msg, {}, null, callback);
      })().catch((err) => {
        this.simpleTxData(msg, {}, err, callback);
      })
      break;
    }
    case "host:delete": {
      (async () => {
        const hostMac = msg.data.value.mac;
        const macExists = await hostTool.macExists(hostMac);
        if (macExists) {
          let ips = await hostTool.getIPsByMac(hostMac);
          ips.forEach(async (ip) => {
            const latestMac = await hostTool.getMacByIP(ip);
            if (latestMac && latestMac === hostMac) {
              // double check to ensure ip address is not taken over by other device
              await hostTool.deleteHost(ip);
            }
          });
          await hostTool.deleteMac(hostMac);
          // Since HostManager.getHosts() is resource heavy, it is not invoked here. It will be invoked once every 5 minutes.
          this.simpleTxData(msg, {}, null, callback);
        } else {
          let resp = {
            type: 'jsonmsg',
            mtype: 'cmd',
            id: uuid.v4(),
            expires: Math.floor(Date.now() / 1000) + 60 * 5,
            replyid: msg.id,
            code: 404,
            data: {"error": "device not found"}
          };
          this.txData(this.primarygid, "host:delete", resp, "jsondata", "", null, callback);
        }
      })().catch((err) => {
        this.simpleTxData(msg, {}, err, callback);
      })
      break;
    }
    default:
      // unsupported action
      this.simpleTxData(msg, {}, new Error("Unsupported action: " + msg.data.item), callback);
      break;
    }
  }

  switchBranch(target) {
    return async(() => {
      let targetBranch = null
      let prodBranch = await (f.getProdBranch())
      
      switch(target) {
      case "dev":
        targetBranch = "master"
        break
      case "beta":
        targetBranch = prodBranch.replace("release_", "beta_")
        break
      case "prod":
        targetBranch = prodBranch
        break
      }

      log.info("Going to switch to branch", targetBranch, {})

      await (exec(`${f.getFirewallaHome()}/scripts/switch_branch.sh ${targetBranch}`))
      sysTool.upgradeToLatest()
    })()
  }

  simpleTxData(msg, data, err, callback) {
    this.txData(this.primarygid, msg.data.item, this.getDefaultResponseDataModel(msg, data, err), "jsondata", "", null, callback);
  }

  getDefaultResponseDataModel(msg, data, err) {
    let code = 200;
    let message = "";
    if (err) {
      log.error("Got error before simpleTxData:", err, err.stack, {});
      code = 500;
      if(err && err.code) {
        code = err.code;
      }
      message = err + "";
    }

    let datamodel = {
      type: 'jsonmsg',
      mtype: msg.mtype,
      id: uuid.v4(),
      expires: Math.floor(Date.now() / 1000) + 60 * 5,
      replyid: msg.id,
      code: code,
      data: data,
      message: message
    };
    return datamodel;
  }

  invalidateCache(callback) {
    callback = callback || function () {
      }

    rclient.del("init.cache", callback);
  }

  loadInitCache(callback) {
    callback = callback || function () {
      }

    rclient.get("init.cache", callback);
  }

  cacheInitData(json, callback) {
    callback = callback || function () {
      }

    let jsonString = JSON.stringify(json);
    let expireTime = 60; // cache for 1 min
    rclient.set("init.cache", jsonString, (err) => {
      if (err) {
        log.error("Failed to set init cache: " + err);
        callback(err);
        return;
      }

      rclient.expire("init.cache", expireTime, (err) => {
        if (err) {
          log.error("Failed to set expire time on init cache: " + err);
          callback(err);
          return;
        }

        log.info("init cache is refreshed, auto-expiring in ", expireTime, "seconds");

        callback(null);
      });

    });
  }

  refreshCache() {
    if (this.hostManager) {
      this.hostManager.toJson(true, (err, json) => {
        if (err) {
          log.error("Failed to generate init data");
          return;
        }

        this.cacheInitData(json);
      });
    }
  }

  msgHandlerAsync(gid, rawmsg) {
    return new Promise((resolve, reject) => {
      let processed = false; // only callback once
      this.msgHandler(gid, rawmsg, (err, response) => {
        if(processed)
          return;

        processed = true;
        if(err) {
          reject(err);
        } else {
          resolve(response);
        }
      })
    })
  }

  msgHandler(gid, rawmsg, callback) {
    if (rawmsg.mtype === "msg" && rawmsg.message.type === 'jsondata') {

      if(!callback) { // cloud mode
        if("compressMode" in rawmsg.message) {
          callback = {
            compressMode: rawmsg.message.compressMode
          } // FIXME: A dirty hack to reuse callback to pass options
        }
      }

      let msg = rawmsg.message.obj;
      if(rawmsg.message && rawmsg.message.obj && rawmsg.message.obj.data &&
      rawmsg.message.obj.data.item === 'ping') {

      } else {
        log.info("Received jsondata from app", rawmsg.message, {});
      }
      
      if (rawmsg.message.obj.type === "jsonmsg") {
        if (rawmsg.message.obj.mtype === "init") {

          if(rawmsg.message.appInfo) {
            this.processAppInfo(rawmsg.message.appInfo)
          }

          log.info("Process Init load event");

          this.loadInitCache((err, cachedJson) => {
            if (true || err || !cachedJson) {
              if (err)
                log.error("Failed to load init cache: " + err);

              // regenerate init data
              log.info("Re-generating init data");

              let begin = Date.now();

              let options = {}

              if(rawmsg.message.obj.data &&
                rawmsg.message.obj.data.simulator) {
                // options.simulator = 1
              }

              this.hostManager.toJson(true, options, (err, json) => {
                let datamodel = {
                  type: 'jsonmsg',
                  mtype: 'init',
                  id: uuid.v4(),
                  expires: Math.floor(Date.now() / 1000) + 60 * 5,
                  replyid: msg.id,
                }
                if (json != null) {
                  datamodel.code = 200;
                  datamodel.data = json;

                  let end = Date.now();
                  log.info("Took " + (end - begin) + "ms to load init data");

                  this.cacheInitData(json);

                } else {
                  if (err) {
                    log.error("got error when calling hostManager.toJson: " + err);
                  } else {
                    log.error("json is null when calling init")
                  }
                  datamodel.code = 500;
                }
                log.info("Sending data", datamodel.replyid, datamodel.id);
                this.txData(this.primarygid, "hosts", datamodel, "jsondata", "", null, callback);

              });
            } else {

              log.info("Using init cache");

              let json = JSON.parse(cachedJson);

              let datamodel = {
                type: 'jsonmsg',
                mtype: 'init',
                id: uuid.v4(),
                expires: Math.floor(Date.now() / 1000) + 60 * 5,
                replyid: msg.id,
                code: 200,
                data: json
              }

              log.info("Sending data", datamodel.replyid, datamodel.id);
              this.txData(this.primarygid, "hosts", datamodel, "jsondata", "", null, callback);

            }
          });


        } else if (rawmsg.message.obj.mtype === "set") {
          // mtype: set
          // target = "ip address" 0.0.0.0 is self
          // data.item = policy
          // data.value = {'block':1},
          //
          this.setHandler(gid, msg, callback);
        } else if (rawmsg.message.obj.mtype === "get") {
          let appInfo = appTool.getAppInfo(rawmsg.message);
          this.getHandler(gid, msg, appInfo, callback);
        } else if (rawmsg.message.obj.mtype === "cmd") {
          this.cmdHandler(gid, msg, callback);
        }
      }
    } else {
      this.bot.processMessage({
        text: rawmsg.message.msg,
        from: {
          address: rawmsg.message.from,
          channelId: gid
        }
      }, (err, msg) => {
        if (msg && msg.text) {
          this.tx(gid, msg.text, "message");
        } else {
        }
      });
    }

  }

  helpString() {
    return "Bot version " + sysManager.version() + "\n\nCli interface is no longer useful, please type 'system reset' after update to new encipher app on iOS\n";
  }

  setupDialog() {
    this.dialog.matches('^system reset', (session) => {
      this.tx(this.primarygid, "performing reset of everything", "system resetting");
      let task = require('child_process').exec('/home/pi/firewalla/scripts/system-reset-all', (err, out, code) => {
        this.tx(this.primarygid, "Done, will reboot now and the system will reincarnated, this group is no longer useful, you can delete it.", "system resetting");
        require('child_process').exec('sync & /home/pi/firewalla/scripts/fire-reboot-normal', (err, out, code) => {
        });
      });

    });
  }

}

process.on('unhandledRejection', (reason, p)=>{
  let msg = "Possibly Unhandled Rejection at: Promise " + p + " reason: "+ reason;
  log.error(msg,reason.stack,{});
  bone.log("error",{
    version: sysManager.version(),
    type:'FIREWALLA.UI.unhandledRejection',
    msg:msg,
    stack:reason.stack
  },null);
  // setTimeout(() => {
  //   require('child_process').execSync("touch /home/pi/.firewalla/managed_reboot")    
  //   process.exit(1);
  // }, 1000 * 20); // just ensure fire api lives long enough to upgrade itself if available
});

process.on('uncaughtException', (err) => {
  log.info("+-+-+-", err.message, err.stack);
  bone.log("error", {
    version: sysManager.version(),
    type: 'FIREWALLA.UI.exception',
    msg: err.message,
    stack: err.stack
  }, null);
  setTimeout(() => {
    try {
        require('child_process').execSync("touch /home/pi/.firewalla/managed_reboot")    
    } catch(e) {
    }
    process.exit(1);
  }, 1000 * 20); // just ensure fire api lives long enough to upgrade itself if available
});

setInterval(()=>{
    let memoryUsage = Math.floor(process.memoryUsage().rss / 1000000);
    try {
      if (global.gc) {
        global.gc();
        log.info("GC executed ",memoryUsage," RSS is now:", Math.floor(process.memoryUsage().rss / 1000000), "MB", {});
      }
    } catch(e) {
    }
},1000*60*5);

module.exports = netBot;
