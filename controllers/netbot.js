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
const log = require('../net2/logger.js')(__filename, "info");

const util = require('util');
const fs = require('fs');

const ControllerBot = require('../lib/ControllerBot.js');

const sem = require('../sensor/SensorEventManager.js').getInstance();

const fc = require('../net2/config.js')
const URL = require("url");
const bone = require("../lib/Bone");
const dhcp = require("../extension/dhcp/dhcp.js");
const SysInfo = require('../extension/sysinfo/SysInfo.js');

const EptCloudExtension = require('../extension/ept/eptcloud.js');

const CategoryFlowTool = require('../flow/CategoryFlowTool.js')
const categoryFlowTool = new CategoryFlowTool()

const HostManager = require('../net2/HostManager.js');
const SysManager = require('../net2/SysManager.js');
const FlowManager = require('../net2/FlowManager.js');
const flowManager = new FlowManager('info');
const sysManager = new SysManager();
const VpnManager = require("../vpn/VpnManager.js");
const IntelManager = require('../net2/IntelManager.js');
const intelManager = new IntelManager('debug');

const upgradeManager = require('../net2/UpgradeManager.js');

const CategoryUpdater = require('../control/CategoryUpdater.js')
const categoryUpdater = new CategoryUpdater()

const DeviceMgmtTool = require('../util/DeviceMgmtTool');

const Promise = require('bluebird');

const SysTool = require('../net2/SysTool.js')
const sysTool = new SysTool()

const flowUtil = require('../net2/FlowUtil');

const iptool = require('ip')

const rclient = require('../util/redis_manager.js').getRedisClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();

const exec = require('child-process-promise').exec
const writeFileAsync = util.promisify(fs.writeFile);
const readFileAsync = util.promisify(fs.readFile);
const readdirAsync = util.promisify(fs.readdir);
const unlinkAsync = util.promisify(fs.unlink);
const existsAsync = util.promisify(fs.exists);

const AM2 = require('../alarm/AlarmManager2.js');
const am2 = new AM2();

const EM = require('../alarm/ExceptionManager.js');
const em = new EM();

const Policy = require('../alarm/Policy.js');
const PM2 = require('../alarm/PolicyManager2.js');
const pm2 = new PM2();

const SSH = require('../extension/ssh/ssh.js');
const ssh = new SSH('info');

const builder = require('botbuilder');
const uuid = require('uuid');

const NM = require('../ui/NotifyManager.js');
const nm = new NM();

const FRPManager = require('../extension/frp/FRPManager.js')
const fm = new FRPManager()
const frp = fm.getSupportFRP();

const fireWeb = require('../mgmt/FireWeb.js');

const f = require('../net2/Firewalla.js');

const flowTool = require('../net2/FlowTool')();

const i18n = require('../util/i18n');

const FlowAggrTool = require('../net2/FlowAggrTool');
const flowAggrTool = new FlowAggrTool();

const NetBotTool = require('../net2/NetBotTool');
const netBotTool = new NetBotTool();

const HostTool = require('../net2/HostTool');
const hostTool = new HostTool();

const DNSTool = require('../net2/DNSTool.js');
const dnsTool = new DNSTool();

const appTool = require('../net2/AppTool')();

const SpooferManager = require('../net2/SpooferManager.js')

const extMgr = require('../sensor/ExtensionManager.js')

const PolicyManager = require('../net2/PolicyManager.js');
const policyManager = new PolicyManager();

const proServer = require('../api/bin/pro');
const tokenManager = require('../api/middlewares/TokenManager').getInstance();

const migration = require('../migration/migration.js');

const Dnsmasq = require('../extension/dnsmasq/dnsmasq.js');

const OpenVPNClient = require('../extension/vpnclient/OpenVPNClient.js');

const conncheck = require('../diagnostic/conncheck.js');

const { delay } = require('../util/util.js')

class netBot extends ControllerBot {

  _vpn(ip, value, callback) {
    if(ip !== "0.0.0.0") {
      callback(null); // per-device policy rule is not supported
      return;
    }

    this.hostManager.loadPolicy((err, data) => {
      let oldValue = {};
      if (data["vpn"]) {
        oldValue = JSON.parse(data["vpn"]);
      }
      const newValue = Object.assign({}, oldValue, value);
      this.hostManager.setPolicy("vpn", newValue, (err, data) => {
        if (err == null) {
          if (callback != null)
            callback(null, "Success");
        } else {
          if (callback != null)
            callback(err, "Unable to enable vpn on ip " + ip);
        }
      });
    });
  }

  _ipAllocation(ip, value, callback) {
    if (ip === "0.0.0.0") {
      // ip allocation is only applied on device
      callback(null)
      return;
    }
    if (value.alternativeIp && value.type === "static") {
      const mySubnet = sysManager.mySubnet();
      if (!iptool.cidrSubnet(mySubnet).contains(value.alternativeIp)) {
        callback(`Alternative IP address should be in ${mySubnet}`);
        return;
      }
    }
    if (value.secondaryIp && value.type === "static") {
      const mySubnet2 = sysManager.mySubnet2();
      if (!iptool.cidrSubnet(mySubnet2).contains(value.secondaryIp)) {
        callback(`Secondary IP address should be in ${mySubnet2}`);
        return;
      }
    }
    this.hostManager.getHost(ip, (err, host) => {
      if (host != null) {
        host.loadPolicy((err, data) => {
          if (err == null) {
            host.setPolicy("ipAllocation", value, (err, data) => {
              if (err == null) {
                if (callback != null)
                  callback(null, "Success: " + ip);
              } else {
                if (callback != null)
                  callback(err, "Failed to set ip allocation to policy of " + ip);
              }
            });
          } else {
            log.error("Failed to load policy of " + ip, err);
            if (callback != null)
                callback(err, "Failed to load policy");
          }
        })
      } else {
        if (callback != null)
          callback("error", "host not found: " + ip);
      }
    })
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

  _enhancedSpoof(ip, value, callback) {
    if (ip !== "0.0.0.0") {
      callback(null);
      return;
    }

    this.hostManager.loadPolicy((err, data) => {
      this.hostManager.setPolicy("enhancedSpoof", value, (err, data) => {
        if (err == null) {
          if (callback)
            callback(null, "Success");
        } else {
          if (callback)
            callback(err, "Unable to apply compatible spoof: " + value);
        }
      })
    })
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
    if(ip === "0.0.0.0") {
      this.hostManager.loadPolicy((err, data) => {
        let oldValue = {};
        if (data["dnsmasq"]) {
          oldValue = JSON.parse(data["dnsmasq"]);
        }
        const newValue = Object.assign({}, oldValue, value);
        this.hostManager.setPolicy("dnsmasq", newValue, (err, data) => {
          if (err == null) {
            if (callback != null)
              callback(null, "Success");
          } else {
            if (callback != null)
              callback(err, "Unable to apply config on dnsmasq: " + value);
          }
        });
      });
    } else {
      this.hostManager.getHost(ip, (err, host) => {
        if (host != null) {
          host.loadPolicy((err, data) => {
            if (err == null) {
              host.setPolicy('dnsmasq', value, (err, data) => {
                if (err == null) {
                  if (callback != null)
                    callback(null, "Success:" + ip);
                } else {
                  if (callback != null)
                    callback(err, "Unable to change dnsmasq config of " + ip)

                }
              });
            } else {
              if (callback != null)
                callback("error", "Unable to change dnsmasq config of " + ip);
            }
          });
        } else {
          if (callback != null)
            callback("error", "Host not found");
        }
      });
    }
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
        log.info("Notification Set",value," CurrentPolicy:", JSON.stringify(this.hostManager.policy.notify));
        nm.loadConfig();
      });
    });
  }

  _sendLog(msg,callback) {
    let password = require('../extension/common/key.js').randomPassword(10)
    let filename = this.primarygid+".tar.gz.gpg";
    log.info("sendLog: ", filename, password);
    this.eptcloud.getStorage(this.primarygid,18000000,0,(e,url)=>{
      log.info("sendLog: Storage ", filename, password,url);
      if (url == null || url.url == null) {
        this.simpleTxData(msg,{},"Unable to get storage",callback);
      } else {
        const path = URL.parse(url.url).pathname;
        const homePath = f.getFirewallaHome();
        let cmdline = `${homePath}/scripts/encrypt-upload-s3.sh ${filename} ${password} '${url.url}'`;
        log.info("sendLog: cmdline", filename, password,cmdline);
        require('child_process').exec(cmdline, (err, out, code) => {
          if (err!=null) {
            log.error("sendLog: unable to process encrypt-upload",err,out,code);
          } else {
          }
        });
        const getDevices = `${homePath}/scripts/sanity_check.sh -f`;
        exec(getDevices)
          .then(res => {
            this.simpleTxData(msg, {password: password, filename: path, content: res.stdout}, null, callback);
          })
          .catch(err => {
            this.simpleTxData(msg, null, err, callback)
          })
      }
    });
  }

  _portforward(target, msg, callback) {
    log.info("_portforward", msg);
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

    sem.on('Alarm:NewAlarm', async (event) => {
      let alarm, notifMsg;
      try {
        alarm = await am2.getAlarm(event.alarmID)
        notifMsg = alarm.localizedNotification();
      }
      catch(err) {
        log.error("Failed to fetch alarm", event, err)
        return
      }

      if (!notifMsg) return;

      log.info("Sending notification: " + JSON.stringify(alarm));
      if (this.hostManager.policy && this.hostManager.policy["notify"]) {
        if (this.hostManager.policy['notify']['state'] == false) {
          log.info("ALARM_NOTIFY_GLOBALL_BLOCKED", alarm);
          return;
        }
        if (alarm.type) {
          let alarmType = alarm.type;
          if (alarmType === "ALARM_LARGE_UPLOAD") {
            alarmType = "ALARM_BEHAVIOR";
          }
          if (this.hostManager.policy["notify"][alarmType] === false ||
            this.hostManager.policy["notify"][alarmType] === 0
          ) {
            log.info("ALARM_NOTIFY_BLOCKED", alarm);
            return;
          }
        }
      }

      log.info("ALARM_NOTIFY_PASSED");

      notifMsg = {
        title: i18n.__(alarm.getNotifType()),
        body: notifMsg
      }

      let data = {
        gid: this.primarygid,
        notifType: "ALARM"
      };

      if (alarm.aid) {
        data.aid = alarm.aid;
        data.alarmID = alarm.alarmID;
      }

      if (alarm.result_method === "auto" && alarm.result === "block") {
        data.category = "com.firewalla.category.autoblockalarm";
      } else {
        if (alarm.getManagementType() === "") {
          // default category
          data.category = "com.firewalla.category.alarm";
        } else {
          data.category = "com.firewalla.category.alarm." + alarm.getManagementType();
        }
      }

      // check if device name should be included, sometimes it is helpful if multiple devices are bound to one app
      if (alarm["p.monkey"] && alarm["p.monkey"] == 1) {
        notifMsg.title = `[Monkey] ${notifMsg.title}`;
      }

      const pa = alarm.cloudAction();
      if(pa && f.isDevelopmentVersion()) {
        notifMsg.body = `${notifMsg.body} - Cloud Action ${pa}`;
      }
      this.tx2(this.primarygid, "test", notifMsg, data);

    });

    sem.on("FW_NOTIFICATION", (event) => {
      const titleKey = event.titleKey;
      const bodyKey = event.bodyKey;
      const payload = event.payload;

      if(!titleKey || !bodyKey || !payload) {
        return;
      }

      const notifyMsg = {
        title: i18n.__(titleKey, payload),
        body: i18n.__(bodyKey, payload),
      };

      const data = {
        gid: this.primarygid,
      };

      this.tx2(this.primarygid, "", notifyMsg, data);
    });

    setTimeout(async () => {
      this.scanStart();

      let branchChanged = await sysManager.isBranchJustChanged();
      let upgradeInfo = await upgradeManager.getUpgradeInfo();
      if(branchChanged) {
        let branch = null

        if(branch) {
          let msg = i18n.__mf("NOTIF_BRANCH_CHANGE", {
            deviceName: this.getDeviceName(),
            branchChanged: branchChanged,
            version: sysManager.version()
          })
          log.info(msg)
          this.tx(this.primarygid, "200", msg)
          sysManager.clearBranchChangeFlag()
        }
      }
      else if (upgradeInfo.upgraded) {
        let msg = i18n.__("NOTIF_UPGRADE_COMPLETE", {
          version: f.isProductionOrBeta() ? fc.getSimpleVersion() : upgradeInfo.to
        });
        this.tx(this.primarygid, "200", msg);
        upgradeManager.updateVersionTag();
      }
      else {
        if (sysManager.systemRebootedByUser(true)) {
          if (nm.canNotify() == true) {
            this.tx(this.primarygid, "200", i18n.__("NOTIF_REBOOT_COMPLETE"));
          }
        } else if (sysManager.systemRebootedDueToIssue(true) == false) {
          if (nm.canNotify() == true) {
            this.tx(this.primarygid, "200", i18n.__("NOTIF_AWAKES"));
          }
        }
      }

      this.setupDialog();
    }, 20 * 1000);

    this.hostManager.on("Scan:Done", (channel, type, ip, obj) => {
      if (type == "Scan:Done") {
        this.scanning = false;
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
    sclient.subscribe("SS:DOWN");
    sclient.subscribe("SS:FAILOVER");
    sclient.subscribe("SS:START:FAILED");
    sclient.subscribe("APP:NOTIFY");
  }

  boneMsgHandler(msg) {
      log.debug("Bone Message",JSON.stringify(msg));
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
          } else if (msg.control && msg.control === "clean_intel") {
            log.error("FIREWALLA CLEAN INTEL ");
            require('child_process').exec("redis-cli keys 'intel:ip:*' | xargs -n 100 redis-cli del", (err, out, code) => {
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
          } else if (msg.control === 'cloud') {
            log.error("Firewalla Cloud");
            // cloud commands will never / ever be ran on production 
            if (sysManager.isSystemDebugOn() || !f.isProduction()) {
              if (msg.command) {
                const cloudManager = require('../extension/cloud/CloudManager.js');
                cloudManager.run(msg.command, msg.info).catch((err) => {
                  log.error("Got error when handling cloud action, err:", err);
                });
              }
            }
          }
      }
  }

  scanStart(callback) {
    this.hostManager.getHosts((err, result) => {
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

  setHandler(gid, msg /*rawmsg.message.obj*/, callback) {
    // mtype: set
    // target = "ip address" 0.0.0.0 is self
    // data.item = policy
    // data.value = {'block':1},
    //
    //       log.info("Set: ",gid,msg);

    // invalidate cache
    this.invalidateCache();
    if(extMgr.hasSet(msg.data.item)) {
      (async () => {
        const result = await extMgr.set(msg.data.item, msg, msg.data.value)
        this.simpleTxData(msg, result, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, null, err, callback)
      })
      return
    }

    let value = msg.data.value;
    switch (msg.data.item) {
      case "policy":
        (async() => {
          // further policy enforcer should be implemented in Host.js or PolicyManager.js
          let processorMap = {
            "ipAllocation": this._ipAllocation,
            "vpn": this._vpn,
            "shadowsocks": this._shadowsocks,
            "scisurf": this._scisurf,
            "enhancedSpoof": this._enhancedSpoof,
            "vulScan": this._vulScan,
            "dnsmasq": this._dnsmasq,
            "externalAccess": this._externalAccess,
            "ssh": this._ssh,
            "notify": this._notify,
            "portforward": this._portforward,
            "upstreamDns": this._upstreamDns,
          }
          for (const o of Object.keys(value)) {
            if (processorMap[o]) {
              await util.promisify(processorMap[o]).bind(this)(msg.target, value[o])
            } else {

              let target = msg.target
              let policyData = value[o]

              log.info(o, target, policyData)

              if (target === "0.0.0.0") {
                await this.hostManager.loadPolicyAsync()
                await this.hostManager.setPolicyAsync(o, policyData);
              } else {
                let host = await this.hostManager.getHostAsync(target)
                if (host) {
                  await host.loadPolicyAsync()
                  await host.setPolicyAsync(o, policyData)
                } else {
                  throw new Error('Invalid host')
                }
              }
            }
          }
          let reply = {
            type: 'jsonmsg',
            mtype: 'policy',
            id: uuid.v4(),
            expires: Math.floor(Date.now() / 1000) + 60 * 5,
            replyid: msg.id,
          };
          reply.code = 200;
          reply.data = value;
          log.info("Repling ", reply.code, reply.data);
          this.txData(this.primarygid, "", reply, "jsondata", "", null, callback);
        })().catch(err =>
          this.simpleTxData(msg, {}, err, callback)
        )
        break
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

        (async() => {
          let ip = null

          if(hostTool.isMacAddress(msg.target)) {
            const macAddress = msg.target
            log.info("set host name alias by mac address", macAddress);

            let macObject = {
              name: data.value.name,
              mac: macAddress
            }

            await hostTool.updateMACKey(macObject, true)

            this.simpleTxData(msg, {}, null, callback)

            return

          } else {
            ip = msg.target
          }

          let host = await this.hostManager.getHostAsync(ip)

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
        intelManager.action(msg.target, value.action, (err) => {
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
        let v = value;

        if (v.from && v.from === "firewalla") {
          const ssClient = require('../extension/ss_client/ss_client.js');
          mssc.saveConfig(v)
            .then(() => this.simpleTxData(msg, {}, null, callback))
            .catch((err) => this.simpleTxData(msg, null, err, callback));
        } else {
          this.simpleTxData(msg, {}, new Error("Invalid config"), callback);
        }

        break;
      case "language":
        let v2 = value;

        // TODO validate input?
        if (v2.language) {
          sysManager.setLanguage(v2.language, (err) => {
            this.simpleTxData(msg, {}, err, callback);
          });
        }
        break;
      case "timezone":
        let v3 = value;

        if (v3.timezone) {
          sysManager.setTimezone(v3.timezone, (err) => {
            this.simpleTxData(msg, {}, err, callback);
          });
        }
      break;
    case "includeNameInNotification":
      let v33 = value;

      let flag = "0";

      if(v33.includeNameInNotification) {
        flag = "1"
      }

      (async() => {
        await rclient.hsetAsync("sys:config", "includeNameInNotification", flag)
        this.simpleTxData(msg, {}, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, {}, err, callback)
      })

      break;
    case "mode":
      let v4 = value;
      let err = null;

      if (v4.mode) {
        (async() => {
          let mode = require('../net2/Mode.js')
          let curMode = await mode.getSetupMode()
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
          case "dhcpSpoof":
            modeManager.setDHCPSpoofAndPublish()
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
    case "userConfig":
      (async () => {
        const updatedPart = value || {};
        await fc.updateUserConfig(updatedPart);
        this.simpleTxData(msg, {}, null, callback);
      })().catch((err) => {
        this.simpleTxData(msg, {}, err, callback);
      });
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


  async processAppInfo(appInfo) {
      if(appInfo.language) {
        if(sysManager.language !== appInfo.language) {
          await sysManager.setLanguageAsync(appInfo.language)
        }
      }

      if(appInfo.deviceName && appInfo.eid) {
        const keyName = "sys:ept:memberNames"
        await rclient.hsetAsync(keyName, appInfo.eid, appInfo.deviceName)

        const keyName2 = "sys:ept:member:lastvisit"
        await rclient.hsetAsync(keyName2, appInfo.eid, Math.floor(new Date() / 1000))
      }

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
      (async() => {
        const result = await extMgr.get(msg.data.item, msg, msg.data.value)
        this.simpleTxData(msg, result, null, callback)
      })().catch((err) => {
        this.simpleTxData(msg, null, err, callback)
      })
      return
    }

    let value = msg.data.value;

    switch (msg.data.item) {
      case "host":
        if (msg.target) {
          let ip = msg.target;
          log.info("Loading device info in a new way:", ip);
          this.deviceHandler(msg, ip)
          .then((json) => {
            this.simpleTxData(msg, json, null, callback);
          })
          .catch((err) => {
            this.simpleTxData(msg, null, err, callback);
          })
        }
        break;
      case "flows":
        (async () => {
          // options:
          //  count: number of alarms returned, default 100
          //  ts: timestamp used to query alarms, default to now
          //  asc: return results in ascending order, default to false
          //  begin/end: time range used to query, will be ommitted when ts is set

          let options = Object.assign({}, msg.data);

          if (msg.target && msg.target != '0.0.0.0') {
            let host = await this.hostManager.getHostAsync(msg.target);
            if (!host || !host.o.mac) {
              let error = new Error("Invalid Host");
              error.code = 404;
              throw error;
            }
            options.mac = host.o.mac
          }

          options.begin = options.begin || options.start;

          let flows = await flowTool.prepareRecentFlows({}, options)
          let data = {
            count: flows.length,
            flows,
            nextTs: flows[flows.length - 1].ts
          }
          this.simpleTxData(msg, data, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break;
      case "vpn":
      case "vpnreset":
        let regenerate = false
        if (msg.data.item === "vpnreset") {
          regenerate = true;
        }
        let compAlg = "";
        if (value) {
          compAlg = compAlg || value.compress;
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
            const vpnConfig = JSON.parse(data["vpn"] || "{}");
            let externalPort = "1194";
            if (vpnConfig && vpnConfig.externalPort)
              externalPort = vpnConfig.externalPort;
            VpnManager.getOvpnFile("fishboneVPN1", null, regenerate, compAlg, externalPort, (err, ovpnfile, password) => {
              if (err == null) {
                datamodel.code = 200;
                datamodel.data = {
                  ovpnfile: ovpnfile,
                  password: password,
                  portmapped: JSON.parse(data['vpnPortmapped'] || "false")
                };

                (async () => {
                  const doublenat = await rclient.getAsync("ext.doublenat");
                  if (doublenat !== null) {
                    datamodel.data.doublenat = doublenat;
                  }
                  this.txData(this.primarygid, "device", datamodel, "jsondata", "", null, callback);
                })();
              } else {
                this.txData(this.primarygid, "device", datamodel, "jsondata", "", null, callback);
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
        const identity = value.identity;
        (async () => {
          const regenerate = value.regenerate;
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
        this.simpleTxData(msg, SysInfo.getSysInfo(), null, callback);
        break;
      case "logFiles":
        SysInfo.getRecentLogs().then(results => {
          this.simpleTxData(msg, results, null, callback);
        }).catch(err => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "scisurfconfig":
        (async () => {
          const mgr = require('../extension/ss_client/ss_client_manager.js');
          const client = mgr.getSSClient();
          const result = client.getConfig();
          this.simpleTxData(msg, result || {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        });
        break;
      case "language":
        this.simpleTxData(msg, {language: sysManager.language}, null, callback);
        break;
      case "timezone":
        this.simpleTxData(msg, {timezone: sysManager.timezone}, null, callback);
        break;
      case "alarms":
        am2.loadActiveAlarms(value, (err, alarms) => {
          this.simpleTxData(msg, {alarms: alarms, count: alarms.length}, err, callback);
        });
        break;
      case "fetchNewAlarms":
        (async () => {
          const sinceTS = value.sinceTS;
          const timeout = value.timeout || 60;
          const alarms = await am2.fetchNewAlarms(sinceTS, {timeout});
          this.simpleTxData(msg, {alarms: alarms, count: alarms.length}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        });
        break;
      case "alarm":
        am2.getAlarm(value.alarmID)
          .then((alarm) => this.simpleTxData(msg, alarm, null, callback))
          .catch((err) => this.simpleTxData(msg, null, err, callback));
        break;
      case "alarmDetail": {
        (async () => {
          const alarmID = value.alarmID;
          if(alarmID) {
            const basic = await am2.getAlarm(alarmID);
            const detail = (await am2.getAlarmDetail(alarmID)) || {};
            this.simpleTxData(msg, Object.assign({}, basic, detail), null, callback);
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
        const ipOrDomain = value.ipOrDomain;
        (async () => {
          const rc = require("../diagnostic/rulecheck.js");
          const result = await rc.checkIpOrDomain(ipOrDomain);
          this.simpleTxData(msg, result, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        });
        break;
      }
      case "transferTrend": {
        const deviceMac = value.deviceMac;
        const destIP = value.destIP;
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
      case "archivedAlarms": {
        const offset = value && value.offset;
        const limit = value && value.limit;

        (async() => {
          const archivedAlarms = await am2.loadArchivedAlarms({
            offset: offset,
            limit: limit
          })
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
      }
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
        this.hostManager.last60MinStats().then(stats => {
          this.simpleTxData(msg, {
            upload: stats.uploadStats,
            download: stats.downloadStats
          }, null, callback)
        }).catch((err) => {
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
      case "linkedDomains":
        (async () => {
          const target = value.target;
          const isDomainPattern = value.isDomainPattern || false;
          if (!target) {
            this.simpleTxData(msg, {}, {code: 400, msg: "'target' should be specified."}, callback);
          } else {
            const domains = await dnsTool.getLinkedDomains(target, isDomainPattern);
            this.simpleTxData(msg, {domains: domains}, null, callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      case "liveCategoryDomains":
        (async () => {
          const category = value.category
          const domains = await categoryUpdater.getDomainsWithExpireTime(category)
          this.simpleTxData(msg, {domains: domains}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break
      case "liveCategoryDomainsWithoutExcluded":
        (async () => {
          const category = value.category
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
          const category = value.category
          const domains = await categoryUpdater.getIncludedDomains(category)
          this.simpleTxData(msg, {domains: domains}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break
      case "excludedDomains":
        (async () => {
          const category = value.category
          const domains = await categoryUpdater.getExcludedDomains(category)
          this.simpleTxData(msg, {domains: domains}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break
      case "whois":
        (async () => {
          const target = value.target;
          let whois = await intelManager.whois(target);
          this.simpleTxData(msg, {target, whois}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "ipinfo":
        (async () => {
          const ip = value.ip;
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
        pm2.loadActivePolicies((err, list) => {
          if(err) {
            this.simpleTxData(msg, {}, err, callback);
          } else {
            let alarmIDs = list.map((p) => p.aid);
            am2.idsToAlarms(alarmIDs, (err, alarms) => {
              if(err) {
                log.error("Failed to get alarms by ids:", err);
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
      case "vpnProfile":
      case "ovpnProfile":
        const type = (value && value.type) || "openvpn";
        switch (type) {
          case "openvpn":
            (async () => {
              const profileId = value.profileId;
              if (!profileId) {
                this.simpleTxData(msg, {}, {code: 400, msg: "'profileId' should be specified."}, callback);
              } else {
                const ovpnClient = new OpenVPNClient({profileId: profileId});
                const filePath = ovpnClient.getProfilePath();
                const fileExists = await existsAsync(filePath);
                if (!fileExists) {
                  this.simpleTxData(msg, {}, {code: 404, msg: "Specified profileId is not found."}, callback);
                } else {
                  const profileContent = await readFileAsync(filePath, "utf8");
                  const passwordPath = ovpnClient.getPasswordPath();
                  let password = "";
                  if (await existsAsync(passwordPath)) {
                    password = await readFileAsync(passwordPath, "utf8");
                    if (password === "dummy_ovpn_password")
                      password = ""; // not a real password, just a placeholder
                  }
                  const userPassPath = ovpnClient.getUserPassPath();
                  let user = "";
                  let pass = "";
                  if (await existsAsync(userPassPath)) {
                    const userPass = await readFileAsync(userPassPath, "utf8");
                    const lines = userPass.split("\n", 2);
                    if (lines.length == 2) {
                      user = lines[0];
                      pass = lines[1];
                    }
                  }

                  const status = await ovpnClient.status();
                  const stats = await ovpnClient.getStatistics();
                  this.simpleTxData(msg, {profileId: profileId, content: profileContent, password: password, user: user, pass: pass, status: status, stats: stats}, null, callback);
                }
              }
            })().catch((err) => {
              this.simpleTxData(msg, {}, err, callback);
            })
            break;
          default:
            this.simpleTxData(msg, {}, {code: 400, msg: "Unsupported VPN client type: " + type}, callback);
        }
        break;
      case "vpnProfiles":
      case "ovpnProfiles": {
        const types = (value && value.types) || ["openvpn"];
        if (!Array.isArray(types)) {
          this.simpleTxData(msg, {}, {code: 400, msg: "'types' should be an array."}, callback);
          return;
        }
        (async () => {
          let profiles = [];
          for (let type of types) {
            switch (type) {
              case "openvpn":
                const dirPath = f.getHiddenFolder() + "/run/ovpn_profile";
                const cmd = "mkdir -p " + dirPath;
                await exec(cmd);
                const files = await readdirAsync(dirPath);
                const ovpns = files.filter(filename => filename.endsWith('.ovpn'));
                Array.prototype.push.apply(profiles, await Promise.all(ovpns.map(async filename => {
                  const profileId = filename.slice(0, filename.length - 5);
                  const ovpnClient = new OpenVPNClient({profileId: profileId});
                  const passwordPath = ovpnClient.getPasswordPath();
                  const profile = {profileId: profileId};
                  let password = "";
                  if (await existsAsync(passwordPath)) {
                    password = await readFileAsync(passwordPath, "utf8");
                    if (password === "dummy_ovpn_password")
                      password = ""; // not a real password, just a placeholder
                  }
                  profile.password = password;
                  const userPassPath = ovpnClient.getUserPassPath();
                  let user = "";
                  let pass = "";
                  if (await existsAsync(userPassPath)) {
                    const userPass = await readFileAsync(userPassPath, "utf8");
                    const lines = userPass.split("\n", 2);
                    if (lines.length == 2) {
                      user = lines[0];
                      pass = lines[1];
                    }
                  }
                  profile.user = user;
                  profile.pass = pass;
                  const status = await ovpnClient.status();
                  profile.status = status;
                  const stats = await ovpnClient.getStatistics();
                  profile.stats = stats;
                  return profile;
                })));
                break;
              default:
                this.simpleTxData(msg, {}, {code: 400, msg: "Unsupported VPN client type: " + type}, callback);
                return;
            }
          }
          this.simpleTxData(msg, {"profiles": profiles}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      }
      case "country:supported":
        rc.smembersAsync('country:list').then(list => {
          this.simpleTxData(msg, {supported: list}, null, callback);
        }).catch(err => {
          this.simpleTxData(msg, {}, err, callback);
        })

    default:
        this.simpleTxData(msg, null, new Error("unsupported action"), callback);
    }
  }

  async validateFlowAppIntel(json) {
      // await bone.flowgraphAsync(...)
      let flows = json.flows

      let hashCache = {}

      let appFlows = flows.appDetails

      if(Object.keys(appFlows).length > 0) {
        flowUtil.hashIntelFlows(appFlows, hashCache)

        let data;
        try {
          data = await bone.flowgraphAsync('summarizeApp', appFlows)
        } catch (err) {
          log.error("Error when summarizing flowgraph for app", err);
        }

        if (data) {
          flows.appDetails = flowUtil.unhashIntelFlows(data, hashCache)
        }
      }
  }

  async validateFlowCategoryIntel(json) {
      // await bone.flowgraphAsync(...)
      let flows = json.flows

      let hashCache = {}

      let categoryFlows = flows.categoryDetails

      if(Object.keys(categoryFlows).length > 0) {
        flowUtil.hashIntelFlows(categoryFlows, hashCache)

        let data;
        try {
          data = await bone.flowgraphAsync('summarizeActivity', categoryFlows)
        } catch (err) {
          log.error("Error when summarizing flowgraph for activity", err);
        }

        if (data) {
          flows.categoryDetails = flowUtil.unhashIntelFlows(data, hashCache)
        }
      }
  }


  async systemFlowHandler(msg) {
    log.info("Getting flow info of the entire network");

    let begin = msg.data && msg.data.start;
    //let end = msg.data && msg.data.end;
    let end = begin && (begin + 3600);

    if (!begin || !end) {
      throw new Error("Require begin and error when calling systemFlowHandler");
    }

    log.info("FROM: ", new Date(begin * 1000).toLocaleTimeString());
    log.info("TO: ", new Date(end * 1000).toLocaleTimeString());

    let jsonobj = {};
    let options = {
      begin: begin,
      end: end
    }

    await Promise.all([
      flowTool.prepareRecentFlows(jsonobj, options),
      netBotTool.prepareTopUploadFlows(jsonobj, options),
      netBotTool.prepareTopDownloadFlows(jsonobj, options),
      netBotTool.prepareDetailedAppFlowsFromCache(jsonobj, options),
      netBotTool.prepareDetailedCategoryFlowsFromCache(jsonobj, options)
    ])

    if (!jsonobj.flows['appDetails']) { // fallback to old way
      await netBotTool.prepareDetailedAppFlows(jsonobj, options)
      await this.validateFlowAppIntel(jsonobj)
    }

    if (!jsonobj.flows['categoryDetails']) { // fallback to old model
      await netBotTool.prepareDetailedCategoryFlows(jsonobj, options)
      await this.validateFlowCategoryIntel(jsonobj)
    }

    return jsonobj;
  }

  async deviceHandler(msg, target) { // WARNING: target could be ip address or mac address
    log.info("Getting info on device", target);

    if (target === '0.0.0.0') {
      return this.systemFlowHandler(msg);
    }

    let begin = msg.data && msg.data.start;
    let end = (msg.data && msg.data.end) || begin + 3600 * 24;

    // A backward compatbiel fix for query host network stats for 'NOW'
    // extend it to a full hour if not enough
    if ((end - begin) < 3600 && msg.data.hourblock === 0) {
      end = begin + 3600;
    }

    let options = {}
    if (begin && end) {
      options.begin = begin
      options.end = end
    }

    if (msg.data.hourblock != "1" &&
      msg.data.hourblock != "0") { // 0 => now, 1 => single hour stats, other => overall stats (last 24 hours)
      options.queryall = true
    }

    let host = await this.hostManager.getHostAsync(target);
    if (!host || !host.o.mac) {
      let error = new Error("Invalid Host");
      error.code = 404;
      throw error;
    }

    let mac = host.o.mac;
    options.mac = mac;

    // load 24 hours download/upload trend
    await flowManager.getStats2(host);

    let jsonobj = {};
    if (host) {
      jsonobj = host.toJson();

      await Promise.all([
        flowTool.prepareRecentFlows(jsonobj, options),
        netBotTool.prepareTopUploadFlowsForHost(jsonobj, mac, options),
        netBotTool.prepareTopDownloadFlowsForHost(jsonobj, mac, options),
        netBotTool.prepareAppActivityFlowsForHost(jsonobj, mac, options),
        netBotTool.prepareCategoryActivityFlowsForHost(jsonobj, mac, options),

        netBotTool.prepareDetailedAppFlowsForHostFromCache(jsonobj, mac, options),
        netBotTool.prepareDetailedCategoryFlowsForHostFromCache(jsonobj, mac, options),

        this.hostManager.last60MinStatsForInit(jsonobj, mac),
        this.hostManager.last30daysStatsForInit(jsonobj, mac)
      ])

      if (!jsonobj.flows["appDetails"]) {
        log.warn("Fell back to legacy mode on app details:", mac, options);
        await netBotTool.prepareAppActivityFlowsForHost(jsonobj, mac, options)
        await this.validateFlowAppIntel(jsonobj)
      }

      if (!jsonobj.flows["categoryDetails"]) {
        log.warn("Fell back to legacy mode on category details:", mac, options);
        await netBotTool.prepareCategoryActivityFlowsForHost(jsonobj, mac, options)
        await this.validateFlowCategoryIntel(jsonobj)
      }
    }

    return jsonobj;
  }

  /*
   Received jsondata { mtype: 'cmd',
   id: '6C998946-ECC6-4535-90C5-E9525D4BB5B6',
   data: { item: 'reboot' },
   type: 'jsonmsg',
   target: '0.0.0.0' }
   */

  // Main Entry Point
  cmdHandler(gid, msg, callback) {

    if(msg && msg.data && msg.data.item === 'ping') {

    } else {
      log.info("API: CmdHandler ",gid,msg);
    }

    if(extMgr.hasCmd(msg.data.item)) {
      (async () => {
        let result = null;
        let err = null;
        try {
          result = await extMgr.cmd(msg.data.item, msg, msg.data.value);
        } catch(e) {
          err = e;
        } finally {
          this.simpleTxData(msg, result, err, callback)
        }
      })();
      return;
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

    let value = msg.data.value;
    switch (msg.data.item) {
      case "upgrade":
        (async() =>{
          sysTool.upgradeToLatest()
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break
      case "shutdown":
        (async() =>{
          sysTool.shutdownServices()
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break
      case "reboot":
        (async() =>{
          sysTool.rebootServices()
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break
      case "resetpolicy":
        (async() =>{
          sysTool.resetPolicy()
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break
      case "stopService":
        (async () => {
          await sysTool.stopServices();
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      case "startService":
        (async () => {
          // no need to await, otherwise fireapi will also be restarted
          sysTool.restartServices();
          sysTool.restartFireKickService();
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      case "cleanIntel":
        (async () => {
          await sysTool.cleanIntel();
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      case "checkIn":
        sem.sendEventToFireMain({
          type: 'CloudReCheckin',
          message: "",
        });
        sem.once("CloudReCheckinComplete", async (event) => {
          let { ddns, publicIp } = await rclient.hgetallAsync('sys:network:info')
          try {
            ddns = JSON.parse(ddns);
            publicIp = JSON.parse(publicIp);
          } catch(err) {
            log.error("Failed to parse strings:", ddns, publicIp);
          }
          this.simpleTxData(msg, { ddns, publicIp }, null, callback);
        })
        break;
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
        (async () => {
          const mgr = require('../extension/ss_client/ss_client_manager.js');
          try {
            const client = mgr.getSSClient();
            client.resetConfig();
            // await mssc.stop();
            // await mssc.clearConfig();
            this.simpleTxData(msg, null, null, callback);
          } catch(err) {
            this.simpleTxData(msg, null, err, callback);
          }
        })();
        break;
      case "ping": {
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
      }
      case "alarm:block":
        am2.blockFromAlarm(value.alarmID, value, (err, policy, otherBlockedAlarms, alreadyExists) => {
          if(value && value.matchAll) { // only block other matched alarms if this option is on, for better backward compatibility
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
        am2.allowFromAlarm(value.alarmID, value, (err, exception, otherAlarms, alreadyExists) => {
          if(value && value.matchAll) { // only block other matched alarms if this option is on, for better backward compatibility
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
        am2.unblockFromAlarm(value.alarmID, value, (err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      case "alarm:unallow":
        am2.unallowFromAlarm(value.alarmID, value, (err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;

      case "alarm:unblock_and_allow":
        am2.unblockFromAlarm(value.alarmID, value, (err) => {
          if (err) {
            log.error("Failed to unblock", value.alarmID, ", err:", err);
            this.simpleTxData(msg, {}, err, callback);
            return;
          }

          am2.allowFromAlarm(value.alarmID, value, (err) => {
            if (err) {
              log.error("Failed to allow", value.alarmID, ", err:", err);
            }
            this.simpleTxData(msg, {}, err, callback);
          });
        });
        break;

      case "alarm:ignore":
        (async() => {
          await am2.ignoreAlarm(value.alarmID)
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          log.error("Failed to ignore alarm:", err)
          this.simpleTxData(msg, {}, err, callback)
        })
        break

      case "alarm:report":
        (async() => {
          await am2.reportBug(value.alarmID, value.feedback)
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          log.error("Failed to report bug on alarm:", err)
          this.simpleTxData(msg, {}, err, callback)
        })
        break

      case "alarm:delete":
        try {
          (async () => {
            await am2.removeAlarmAsync(value.alarmID);
            this.simpleTxData(msg, {}, null, callback)
          })()
        } catch(err) {
          log.error("Failed to delete alarm:", err)
          this.simpleTxData(msg, null, err, callback)
        }
        break;

      case "policy:create":
        let policy
        try {
          policy = new Policy(value)
        } catch (err) {
          log.error('Error creating policy', err);
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
        break;

      case "policy:update":
        (async() => {
          const policy = value

          const pid = policy.pid
          const oldPolicy = await pm2.getPolicy(pid)
          await pm2.updatePolicyAsync(policy)
          const newPolicy = await pm2.getPolicy(pid)
          await pm2.tryPolicyEnforcement(newPolicy, 'reenforce', oldPolicy)
          this.simpleTxData(msg, newPolicy, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })

        break;
      case "policy:delete":
        (async() => {
          let policy = await pm2.getPolicy(value.policyID)
          if(policy) {
            await pm2.disableAndDeletePolicy(value.policyID)
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
        (async() => {
          const policyID = value.policyID
          if(policyID) {
            let policy = await pm2.getPolicy(value.policyID)
            if(policy) {
              await pm2.enablePolicy(policy)
              this.simpleTxData(msg, policy, null, callback);
            } else {
              this.simpleTxData(msg, null, new Error("invalid policy"), callback);
            }
          } else {
            this.simpleTxData(msg, null, new Error("invalid policy ID"), callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })
        break;
      case "policy:disable":
        (async() => {
          const policyID = value.policyID
          if(policyID) {
            let policy = await pm2.getPolicy(value.policyID)
            if(policy) {
              await pm2.disablePolicy(policy)
              this.simpleTxData(msg, policy, null, callback);
            } else {
              this.simpleTxData(msg, null, new Error("invalid policy"), callback);
            }
          } else {
            this.simpleTxData(msg, null, new Error("invalid policy ID"), callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })
        break;
      case "intel:finger":
        (async () => {
          const target = value.target;
          if (target) {
            let result;
            try {
              result = await bone.intelFinger(target);
            } catch (err) {
              log.error("Error when intel finger", err);
            }
            if (result && result.whois) {
              this.simpleTxData(msg, result, null, callback);
            } else {
              this.simpleTxData(msg, null, new Error(`failed to fetch intel for target: ${target}`), callback);
            }
          } else {
            this.simpleTxData(msg, null, new Error(`invalid target: ${target}`), callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })
        break;
      case "exception:create":
        em.createException(value)
          .then((result) => {
            this.simpleTxData(msg, result, null, callback);
          })
          .catch((err) => {
            this.simpleTxData(msg, null, err, callback);
          });
        break;
      case "exception:update":
        em.updateException(value)
          .then((result) => {
            this.simpleTxData(msg, result, null, callback);
          })
          .catch((err) => {
            this.simpleTxData(msg, null, err, callback);
          });
        break;
      case "exception:delete":
        em.deleteException(value.exceptionID)
          .then(() => {
            this.simpleTxData(msg, null, null, callback);
          }).catch((err) => {
            this.simpleTxData(msg, null, err, callback);
          });
        break;
      case "reset":
        break;
      case "startSupport":
        (async() => {
          await frp.start()
          let config = frp.getConfig();
          let newPassword = await ssh.resetRandomPasswordAsync()
          sysManager.setSSHPassword(newPassword); // in-memory update
          config.password = newPassword
          this.simpleTxData(msg, config, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break;
      case "stopSupport":
        (async() => {
          await frp.stop()
          let newPassword = await ssh.resetRandomPasswordAsync()
          sysManager.setSSHPassword(newPassword); // in-memory update
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break;
      case "setManualSpoof":
        (async() => {
          let mac = value.mac
          let manualSpoof = value.manualSpoof ? "1" : "0"

          if(!mac) {
            this.simpleTxData(msg, null, new Error("invalid request"), callback)
            return
          }

          await hostTool.updateMACKey({
            mac: mac,
            manualSpoof: manualSpoof
          })

          let mode = require('../net2/Mode.js')
          if(mode.isManualSpoofModeOn()) {
            await new SpooferManager().loadManualSpoof(mac)
          }

          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })
        break
      case "manualSpoofUpdate":
        (async() => {
          let modeManager = require('../net2/ModeManager.js');
          await modeManager.publishManualSpoofUpdate()
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })
        break
      case "isSpoofRunning":
        (async() => {
          let timeout = value.timeout

          let running = false

          if(timeout) {
            let begin = new Date() / 1000;

            while(new Date() / 1000 < begin + timeout) {
              const secondsLeft =  Math.floor((begin + timeout) - new Date() / 1000);
              log.info(`Checking if spoofing daemon is active... ${secondsLeft} seconds left`)
              running = await new SpooferManager().isSpoofRunning()
              if(running) {
                break
              }
              await delay(1000)
            }

          } else {
            running = await new SpooferManager().isSpoofRunning()
          }

          this.simpleTxData(msg, {running: running}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback)
        })
        break
      case "spoofMe":
        log.info("zhijie test", value)
        (async() => {
          let ip = value.ip
          let name = value.name

          if(iptool.isV4Format(ip)) {
            sem.emitEvent({
              type: "DeviceUpdate",
              message: `Manual submit a new device via API ${ip} ${name}`,
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
        (async () => {
          let ip = value.ip
          let timeout = value.timeout || 60 // by default, wait for 60 seconds

          // add current ip to spoof list
          await new SpooferManager().directSpoof(ip)

          let begin = new Date() / 1000;

          let result = false

          while(new Date() / 1000 < begin + timeout) {
            log.info(`Checking if IP ${ip} is being spoofed, ${-1 * (new Date() / 1000 - (begin + timeout))} seconds left`)
            result = await new SpooferManager().isSpoof(ip)
            if(result) {
              break
            }
            await delay(1000)
          }

          this.simpleTxData(msg, {
            result: result
          }, null, callback)

        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break
      }
      case "bootingComplete":
        (async() => {
          await f.setBootingComplete()
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break
      case "resetBootingComplete":
        (async() => {
          await f.resetBootingComplete()
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, null, err, callback);
        })
        break
      case "joinBeta":
        (async() => {
          await this.switchBranch("beta")
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break;
      case "leaveBeta":
        (async() =>{
          await this.switchBranch("prod")
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break;
      case "switchBranch":
        (async() =>{
          await this.switchBranch(value.target)
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
      case "isBindingActive": {
        (async () => {
          try {
            const active = await sysTool.isFireKickRunning();
            this.simpleTxData(msg, {active}, null, callback);
          } catch(err) {
            this.simpleTxData(msg, {}, err, callback)
          }
        })();
        break;
      }
      case "enableFeature": {
        const featureName = value.featureName;
        (async() =>{
          if(featureName) {
            await fc.enableDynamicFeature(featureName)
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
        const featureName = value.featureName;
        (async() =>{
          if(featureName) {
            await fc.disableDynamicFeature(featureName)
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
        const featureName = value.featureName;
        (async() =>{
          if(featureName) {
            await fc.clearDynamicFeature(featureName)
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
        (async() =>{
          sem.emitEvent({
            type: "ReleaseMonkey",
            message: "Release a monkey to test system",
            toProcess: 'FireMain',
            monkeyType: value && value.monkeyType
          })
          this.simpleTxData(msg, {}, null, callback)
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break
      }
      case "addIncludeDomain": {
        (async () => {
          const category = value.category
          const domain = value.domain
          await categoryUpdater.addIncludedDomain(category,domain)
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
          const category = value.category
          const domain = value.domain
          await categoryUpdater.removeIncludedDomain(category,domain)
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
          const category = value.category
          const domain = value.domain
          await categoryUpdater.addExcludedDomain(category,domain)
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
          const category = value.category
          const domain = value.domain
          await categoryUpdater.removeExcludedDomain(category,domain)
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
      case "startVpnClient": {
        const type = value.type;
        if (!type) {
          this.simpleTxData(msg, {}, {code: 400, msg: "'type' is not specified."}, callback);
          return;
        }
        switch (type) {
          case "openvpn":
            const profileId = value.profileId;
            if (!profileId) {
              this.simpleTxData(msg, {}, {code: 400, msg: "'profileId' is not specified."}, callback);
            } else {
              (async () => {
                const ovpnClient = new OpenVPNClient({profileId: profileId});
                await ovpnClient.setup().catch((err) => {
                  log.error(`Failed to setup openvpn client for ${profileId}`, err);
                });
                const result = await ovpnClient.start();
                if (!result) {
                  await ovpnClient.stop();
                  // set state to false in system policy
                  this._vpnClient("0.0.0.0", {state: false});
                  // HTTP 408 stands for request timeout
                  this.simpleTxData(msg, {}, {code: 408, msg: "Failed to start vpn client within 20 seconds."}, callback);
                } else {
                  this._vpnClient("0.0.0.0", {state: true});
                  this.simpleTxData(msg, {}, null, callback);
                }
              })().catch((err) => {
                this.simpleTxData(msg, {}, err, callback);
              });
            }
            break;
          default:
            this.simpleTxData(msg, {}, {code: 400, msg: "Unsupported VPN client type: " + type}, callback);
        }
        break;
      }
      case "stopVpnClient": {
        const type = value.type;
        if (!type) {
          this.simpleTxData(msg, {}, {code: 400, msg: "'type' is not specified."}, callback);
          return;
        }
        switch (type) {
          case "openvpn":
            const profileId = value.profileId;
            if (!profileId) {
              this.simpleTxData(msg, {}, {code: 400, msg: "'profileId' is not specified."}, callback);
            } else {
              (async () => {
                const ovpnClient = new OpenVPNClient({profileId: profileId});
                await ovpnClient.setup().catch((err) => {
                  log.error(`Failed to setup openvpn client for ${profileId}`, err);
                });
                const stats = await ovpnClient.getStatistics();
                await ovpnClient.stop();
                this._vpnClient("0.0.0.0", {state: false});
                this.simpleTxData(msg, {stats: stats}, null, callback);
              })().catch((err) => {
                this.simpleTxData(msg, {}, err, callback);
              })
            }
            break;
          default:
            this.simpleTxData(msg, {}, {code: 400, msg: "Unsupported VPN client type: " + type}, callback);
        }
        break;
      }
      case "saveVpnProfile":
      case "saveOvpnProfile": {
        let type = value.type || "openvpn";
        switch (type) {
          case "openvpn": {
            const content = value.content;
            let profileId = value.profileId;
            const password = value.password;
            const user = value.user;
            const pass = value.pass;
            if (!content) {
              this.simpleTxData(msg, {}, {code: 400, msg: "'content' should be specified"}, callback);
              return;
            }
            if (content.match(/^auth-user-pass\s*/gm)) {
              // username password is required for this profile
              if (!user || !pass) {
                this.simpleTxData(msg, {}, {code: 400, msg: "'user' and 'pass' should be specified for this profile", callback});
                return;
              }
            }
            if (!profileId || profileId === "") {
              // use default profile id
              profileId = "vpn_client";
            }
            const matches = profileId.match(/^[a-zA-Z0-9_]+/g);
            if (profileId.length > 10 || matches == null || matches.length != 1 || matches[0] !== profileId) {
              this.simpleTxData(msg, {}, {code: 400, msg: "'profileId' should only contain alphanumeric letters or underscore and no longer than 10 characters"}, callback);
            } else {
              (async () => {
                const ovpnClient = new OpenVPNClient({profileId: profileId});
                const dirPath = f.getHiddenFolder() + "/run/ovpn_profile";
                const cmd = "mkdir -p " + dirPath;
                await exec(cmd);
                const files = await readdirAsync(dirPath);
                const ovpns = files.filter(filename => filename.endsWith('.ovpn'));
                if (ovpns && ovpns.length >= 10) {
                  this.simpleTxData(msg, {}, {code: 429, msg: "At most 10 profiles can be saved on Firewalla"}, callback);
                } else {
                  const profilePath = ovpnClient.getProfilePath();
                  await writeFileAsync(profilePath, content, 'utf8');
                  if (password) {
                    const passwordPath = ovpnClient.getPasswordPath();
                    await writeFileAsync(passwordPath, password, 'utf8');
                  }
                  if (user && pass) {
                    const userPassPath = ovpnClient.getUserPassPath();
                    await writeFileAsync(userPassPath, `${user}\n${pass}`);
                  }
                  this.simpleTxData(msg, {}, null, callback);
                }
              })().catch((err) => {
                this.simpleTxData(msg, {}, err, callback);
              })
            }
            break;
          }
          default:
            this.simpleTxData(msg, {}, {code: 400, msg: "Unsupported VPN client type: " + type}, callback);
        }
        break;
      }
      case "deleteVpnProfile":
      case "deleteOvpnProfile": {
        const type = value.type || "openvpn";
        switch (type) {
          case "openvpn":
            (async () => {
              const profileId = value.profileId;
              if (!profileId || profileId === "") {
                this.simpleTxData(msg, {}, {code: 400, msg: "'profileId' is not specified"}, callback);
              } else {
                const ovpnClient = new OpenVPNClient({profileId: profileId});
                const status = await ovpnClient.status();
                if (status) {
                  this.simpleTxData(msg, {}, {code: 400, msg: "OpenVPN client " + profileId + " is still running"}, callback);
                } else {
                  const profilePath = ovpnClient.getProfilePath();
                  if (fs.existsSync(profilePath)) {
                    await unlinkAsync(profilePath);
                    const passwordPath = ovpnClient.getPasswordPath();
                    if (fs.existsSync(passwordPath)) {
                      await unlinkAsync(passwordPath);
                    }
                    const userPassPath = ovpnClient.getUserPassPath();
                    if (fs.existsSync(userPassPath)) {
                      await unlinkAsync(userPassPath);
                    }
                    this.simpleTxData(msg, {}, null, callback);
                  } else {
                    this.simpleTxData(msg, {}, {code: 404, msg: "'profileId' '" + profileId + "' does not exist"}, callback);
                  }
                }
              }
            })().catch((err) => {
              this.simpleTxData(msg, {}, err, callback);
            })
            break;
          default:
            this.simpleTxData(msg, {}, {code: 400, msg: "Unsupported VPN client type: " + type}, callback);
        }
        break;
      }
      case "saveRSAPublicKey": {
        const content = value.pubKey;
        const identity = value.identity;
        (async () => {
          await ssh.saveRSAPublicKey(content, identity);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "migration:export": {
        const partition = value.partition;
        const encryptionIdentity = value.encryptionIdentity;
        (async () => {
          await migration.exportDataPartition(partition, encryptionIdentity);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "migration:import": {
        const partition = value.partition;
        const encryptionIdentity = value.encryptionIdentity;
        (async () => {
          await migration.importDataPartition(partition, encryptionIdentity);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "migration:transfer": {
        const host = value.host;
        const partition = value.partition;
        const transferIdentity = value.transferIdentity;
        (async () => {
          await migration.transferDataPartition(host, partition, transferIdentity);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }
      case "migration:transferHiddenFolder": {
        const host = value.host;
        const transferIdentity = value.transferIdentity;
        (async () => {
          await migration.transferHiddenFolder(host, transferIdentity);
          this.simpleTxData(msg, {}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      }

      case "enableWebToken": {
        (async () => {
          const tokenInfo = await fireWeb.enableWebToken(this.eptcloud);
          this.simpleTxData(msg, tokenInfo, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        });
        break;
      }

      case "host:delete": {
        (async () => {
          const hostMac = value.mac;
          log.info('host:delete', hostMac);
          const macExists = await hostTool.macExists(hostMac);
          if (macExists) {

            await pm2.deleteMacRelatedPolicies(hostMac);
            await em.deleteMacRelatedExceptions(hostMac);
            await am2.deleteMacRelatedAlarms(hostMac);

            await categoryFlowTool.delAllCategories(hostMac);
            await flowAggrTool.removeAggrFlowsAll(hostMac);
            await flowManager.removeFlowsAll(hostMac);

            let ips = await hostTool.getIPsByMac(hostMac);
            for (const ip of ips) {
              const latestMac = await hostTool.getMacByIP(ip);
              if (latestMac && latestMac === hostMac) {
                // double check to ensure ip address is not taken over by other device
                await hostTool.deleteHost(ip);

                // remove port forwarding
                this._portforward({
                  "toPort": "*",
                  "protocol": "*",
                  "toIP": ip,
                  "type": "portforward",
                  "state": false,
                  "dport": "*"
                })

                // simply remove monitor spec directly here instead of adding reference to FlowMonitor.js
                await rclient.delAsync([
                  "monitor:flow:in:" + ip,
                  "monitor:flow:out:" + ip
                ]);
              }
            };
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
      case "networkInterface:update": {
        // secondary interface settings includes those in config files and dhcp address pool range
        (async () => {
          const network = msg.data.value.network;
          const intf = msg.data.value.interface;
          const dhcpRange = msg.data.value.dhcpRange;
          const dnsServers = msg.data.value.dnsServers || []; // default value is empty
          if (!network || !intf || !intf.ipAddress || !intf.subnetMask) {
            this.simpleTxData(msg, {}, {code: 400, msg: "network, interface.ipAddress/subnetMask should be specified."}, callback);
            return;
          }
          if (dhcpRange && (!dhcpRange.begin || !dhcpRange.end)) {
            this.simpleTxData(msg, {}, {code: 400, msg: "dhcpRange.start/end should be set at the same time."}, callback);
            return;
          }
          const currentConfig = fc.getConfig(true);
          switch (network) {
            case "secondary": {
              const currentSecondaryInterface = currentConfig.secondaryInterface;
              const updatedConfig = {intf: "eth0:0"};
              const ipAddress = intf.ipAddress;
              const subnetMask = intf.subnetMask;
              const ipSubnet = iptool.subnet(ipAddress, subnetMask);
              updatedConfig.ip = ipAddress + "/" + ipSubnet.subnetMaskLength; // ip format is <ip_address>/<subnet_mask_length>
              const mergedSecondaryInterface = Object.assign({}, currentSecondaryInterface, updatedConfig); // if ip2 is not defined, it will be inherited from previous settings
              // redundant entries for backward compatitibility
              mergedSecondaryInterface.ipOnly = ipAddress;
              mergedSecondaryInterface.ipsubnet = ipSubnet.networkAddress + "/" + ipSubnet.subnetMaskLength;
              mergedSecondaryInterface.ipnet = ipAddress.substring(0, ipAddress.lastIndexOf("."));
              mergedSecondaryInterface.ipmask = subnetMask;
              if (mergedSecondaryInterface.ip2) {
                const ipSubnet2 = iptool.cidrSubnet(mergedSecondaryInterface.ip2);
                mergedSecondaryInterface.ip2Only = mergedSecondaryInterface.ip2.substring(0, mergedSecondaryInterface.ip2.lastIndexOf('/')); // e.g., 192.168.168.1
                mergedSecondaryInterface.ipsubnet2 = ipSubnet2.networkAddress + "/" + ipSubnet2.subnetMaskLength; // e.g., 192.168.168.0/24
                mergedSecondaryInterface.ipnet2 = mergedSecondaryInterface.ip2.substring(0, mergedSecondaryInterface.ip2.lastIndexOf(".")); // e.g., 192.168.168
                mergedSecondaryInterface.ipmask2 = ipSubnet2.subnetMask; // e.g., 255.255.255.0
              }
              await fc.updateUserConfig({secondaryInterface: mergedSecondaryInterface});
              if (dhcpRange)
                this._dnsmasq("0.0.0.0", {secondaryDnsServers: dnsServers, secondaryDhcpRange: dhcpRange});
              setTimeout(() => {
                let modeManager = require('../net2/ModeManager.js');
                modeManager.publishNetworkInterfaceUpdate();
              }, 5000); // update interface in 5 seconds, otherwise FireApi response may not reach client
              this.simpleTxData(msg, {}, null, callback);
              break;
            }
            case "alternative": {
              const currentAlternativeInterface = currentConfig.alternativeInterface || {ip: sysManager.mySubnet(), gateway: sysManager.myGateway()}; // default value is current ip/subnet/gateway on eth0
              const updatedAltConfig = {gateway: intf.gateway};
              const altIpAddress = intf.ipAddress;
              const altSubnetMask = intf.subnetMask;
              const altIpSubnet = iptool.subnet(altIpAddress, altSubnetMask);
              updatedAltConfig.ip = altIpAddress + "/" + altIpSubnet.subnetMaskLength; // ip format is <ip_address>/<subnet_mask_length>
              const mergedAlternativeInterface = Object.assign({}, currentAlternativeInterface, updatedAltConfig);
              await fc.updateUserConfig({alternativeInterface: mergedAlternativeInterface});
              if (dhcpRange)
                this._dnsmasq("0.0.0.0", {alternativeDnsServers: dnsServers, alternativeDhcpRange: dhcpRange});
              setTimeout(() => {
                let modeManager = require('../net2/ModeManager.js');
                modeManager.publishNetworkInterfaceUpdate();
              }, 5000); // update interface in 5 seconds, otherwise FireApi response may not reach client
              this.simpleTxData(msg, {}, null, callback);
              break;
            }
            case "wifi": {
              const currentWifiInterface = currentConfig.wifiInterface;
              const updatedWifiConfig = {intf: "wlan0"};
              const wifiIpAddress = intf.ipAddress;
              const wifiSubnetMask = intf.subnetMask;
              const wifiIpSubnet = iptool.subnet(wifiIpAddress, wifiSubnetMask);
              updatedWifiConfig.ip = wifiIpAddress + "/" + wifiIpSubnet.subnetMaskLength; // ip format is <ip_address>/<subnet_mask_length>
              updatedWifiConfig.mode = intf.mode || "router";
              updatedWifiConfig.ssid = intf.ssid || "FW_AP";
              updatedWifiConfig.password = intf.password || "firewalla";
              updatedWifiConfig.band = intf.band || "g";
              updatedWifiConfig.channel = intf.channel || "5";
              const mergedWifiInterface = Object.assign({}, currentWifiInterface, updatedWifiConfig); // if ip2 is not defined, it will be inherited from previous settings
              await fc.updateUserConfig({wifiInterface: mergedWifiInterface});
              if (dhcpRange)
                this._dnsmasq("0.0.0.0", {wifiDnsServers: dnsServers, wifiDhcpRange: dhcpRange});
              this.simpleTxData(msg, {}, null, callback);
              break;
            }
            default:
              log.error("Unknown network type in networkInterface:update, " + network);
              this.simpleTxData(msg, {}, {code: 400, msg: "Unknown network type: " + network}, callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      }
      case "networkInterface:get": {
        (async () => {
          const network = msg.data.value.network;
          if (!network) {
            this.simpleTxData(msg, {}, {code: 400, msg: "network should be specified."}, callback);
          } else {
            const config = fc.getConfig(true);
            const dnsmasq = new Dnsmasq();
            let dhcpRange = await dnsmasq.getDefaultDhcpRange(network);
            switch (network) {
              case "secondary":
                // convert ip/subnet to ip address and subnet mask
                const secondaryInterface = config.secondaryInterface;
                const secondaryIpSubnet = iptool.cidrSubnet(secondaryInterface.ip);
                this.hostManager.loadPolicy((err, data) => {
                  let secondaryDnsServers = sysManager.myDNS();
                  if (data.dnsmasq) {
                    const dnsmasq = JSON.parse(data.dnsmasq);
                    if (dnsmasq.secondaryDnsServers && dnsmasq.secondaryDnsServers.length !== 0) {
                      secondaryDnsServers = dnsmasq.secondaryDnsServers;
                    }
                    if (dnsmasq.secondaryDhcpRange) {
                      dhcpRange = dnsmasq.secondaryDhcpRange;
                    }
                  }
                  this.simpleTxData(msg,
                    {
                      interface: {
                        ipAddress: secondaryInterface.ip.split('/')[0],
                        subnetMask: secondaryIpSubnet.subnetMask
                      },
                      dhcpRange: dhcpRange,
                      dnsServers: secondaryDnsServers
                    }, null, callback);
                });
                break;
              case "alternative":
                // convert ip/subnet to ip address and subnet mask
                const alternativeInterface = config.alternativeInterface || {ip: sysManager.mySubnet(), gateway: sysManager.myGateway()}; // default value is current ip/subnet/gateway on eth0
                const alternativeIpSubnet = iptool.cidrSubnet(alternativeInterface.ip);
                this.hostManager.loadPolicy((err, data) => {
                  let alternativeDnsServers = sysManager.myDNS();
                  if (data.dnsmasq) {
                    const dnsmasq = JSON.parse(data.dnsmasq);
                    if (dnsmasq.alternativeDnsServers && dnsmasq.alternativeDnsServers.length != 0) {
                      alternativeDnsServers = dnsmasq.alternativeDnsServers;
                    }
                    if (dnsmasq.alternativeDhcpRange) {
                      dhcpRange = dnsmasq.alternativeDhcpRange;
                    }
                  }
                  this.simpleTxData(msg,
                    {
                      interface: {
                        ipAddress: alternativeInterface.ip.split('/')[0],
                        subnetMask: alternativeIpSubnet.subnetMask,
                        gateway: alternativeInterface.gateway
                      },
                      dhcpRange: dhcpRange,
                      dnsServers: alternativeDnsServers
                    }, null, callback);
                });
                break;
              default:
                log.error("Unknwon network type in networkInterface:update, " + network);
                this.simpleTxData(msg, {}, {code: 400, msg: "Unknown network type: " + network});
            }
          }
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      }
      case "getConnTestDest": {
        (async () => {
          const dest = await conncheck.getDestToCheck();
          this.simpleTxData(msg, dest, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      }
      case "startConnTest": {
        (async () => {
          if (!value.src || !value.src.ip) {
            this.simpleTxData(msg, {}, {code: 400, msg: "src.ip should be specified"}, callback);
            return;
          }
          if (!value.dst || !value.dst.ip || !value.dst.port) {
            this.simpleTxData(msg, {}, {code: 400, msg: "dst.ip and dst.port should be specified"}, callback);
            return;
          }
          const pid = await conncheck.startConnCheck(value.src, value.dst, value.duration);
          this.simpleTxData(msg, {pid: pid}, null, callback);
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback);
        })
        break;
      }
      case "getConnTestResult": {
        (async () => {
          if (!value.pid) {
            this.simpleTxData(msg, {}, {code: 400, msg: "pid should be specified"}, callback);
            return;
          }
          const result = await conncheck.getConnCheckResult(value.pid);
          if (!result) {
            this.simpleTxData(msg, {}, {code: 404, msg: "Test result of specified pid is not found"}, callback);
          } else {
            this.simpleTxData(msg, result, null, callback);
          }
        })().catch((err) => {
          this.simpleTxData(msg, {}, err, callback)
        })
        break;
      }
      default:
        // unsupported action
        this.simpleTxData(msg, {}, new Error("Unsupported action: " + msg.data.item), callback);
        break;
    }
  }

  async switchBranch(target) {
    let targetBranch = null
    let prodBranch = await f.getProdBranch()

    switch (target) {
      case "dev":
        targetBranch = "master";
        break;
      case "alpha":
        targetBranch = "beta_7_0";
        break;
      case "beta":
        targetBranch = prodBranch.replace("release_", "beta_")
        break
      case "prod":
        targetBranch = prodBranch
        break
    }

    log.info("Going to switch to branch", targetBranch);

    await exec(`${f.getFirewallaHome()}/scripts/switch_branch.sh ${targetBranch}`)
    sysTool.upgradeToLatest()
  }

  simpleTxData(msg, data, err, callback) {
    this.txData(
      /* gid     */ this.primarygid,
      /* msg     */ msg.data.item,
      /* obj     */ this.getDefaultResponseDataModel(msg, data, err),
      /* type    */ "jsondata",
      /* beepmsg */ "",
      /* whisper */ null,
      /* callback*/ callback
    );
  }

  getDefaultResponseDataModel(msg, data, err) {
    let code = 200;
    let message = "";
    if (err) {
      log.error("Got error before simpleTxData:", err, err.stack);
      code = 500;
      if(err && err.code) {
        code = err.code;
      }
      message = err + "";
      if (err && err.msg) {
        message = err.msg;
      }
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
    callback = callback || function () { }

    rclient.get("init.cache", callback);
  }

  cacheInitData(json, callback) {
    callback = callback || function () { }

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
        log.info("Received jsondata from app", rawmsg.message);
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
              sysManager.update((err) => {
                this.hostManager.toJson(true, options, (err, json) => {
                  let datamodel = {
                    type: 'jsonmsg',
                    mtype: 'init',
                    id: uuid.v4(),
                    expires: Math.floor(Date.now() / 1000) + 60 * 5,
                    replyid: msg.id,
                  }
                  if (json != null) {

                    json.device = this.getDeviceName();

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
                  this.txData(this.primarygid, "hosts", datamodel, "jsondata", null, null, callback);

                });
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
  log.error(msg,reason.stack);
  bone.logAsync("error",{
    type:'FIREWALLA.UI.unhandledRejection',
    msg:msg,
    stack:reason.stack,
    err: JSON.stringify(reason)
  });
});

process.on('uncaughtException', (err) => {
  log.info("+-+-+-", err.message, err.stack);
  bone.logAsync("error", {
    type: 'FIREWALLA.UI.exception',
    msg: err.message,
    stack: err.stack,
    err: JSON.stringify(err)
  });
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
        log.info("GC executed ",memoryUsage," RSS is now:", Math.floor(process.memoryUsage().rss / 1000000), "MB");
      }
    } catch(e) {
    }
},1000*60*5);

module.exports = netBot;
