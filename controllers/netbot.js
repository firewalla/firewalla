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
var fs = require('fs');
var cloud = require('../encipher');
var program = require('commander');
var qrcode = require('qrcode-terminal');
var publicIp = require('public-ip');
var intercomm = require('../lib/intercomm.js');

var ControllerBot = require('../lib/ControllerBot.js');

var HostManager = require('../net2/HostManager.js');
var SysManager = require('../net2/SysManager.js');
var FlowManager = require('../net2/FlowManager.js');
var flowManager = new FlowManager('info');
var AlarmManager = require('../net2/AlarmManager.js');
var alarmManager = new AlarmManager('info');
var sysmanager = new SysManager();
var VpnManager = require("../vpn/VpnManager.js");
var vpnManager = new VpnManager('info');
var IntelManager = require('../net2/IntelManager.js');
var intelManager = new IntelManager('debug');

let Promise = require('bluebird');

let redis = require('redis');
let rclient = redis.createClient();

let AM2 = require('../alarm/AlarmManager2.js');
let am2 = new AM2();

let EM = require('../alarm/ExceptionManager.js');
let em = new EM();

let PM2 = require('../alarm/PolicyManager2.js');
let pm2 = new PM2();

let SSH = require('../extension/ssh/ssh.js');
let ssh = new SSH('info');

let country = require('../extension/country/country.js');

var builder = require('botbuilder');
var uuid = require('uuid');

var async = require('async');

let NM = require('../ui/NotifyManager.js');
let nm = new NM();

let f = require('../net2/Firewalla.js');

let flowTool = require('../net2/FlowTool')();

let i18n = require('../util/i18n');

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
    this.hostManager.loadPolicy((err, data) => {
      this.hostManager.setPolicy("vpn", value, (err, data) => {
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
   *      state: on/off
   *      intel: <major/minor>
   *      porn: <major/minor>
   *      gaming: <major/minor>
   *      flow: <major/minor>
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
        nm.loadConfig();
      });
    });
  }

  constructor(config, fullConfig, eptcloud, groups, gid, debug, apiMode) {
    super(config, fullConfig, eptcloud, groups, gid, debug, apiMode);
    this.bot = new builder.TextBot();
    //      this.dialog = new builder.LuisDialog(config.dialog.api);
    this.dialog = new builder.CommandDialog();
    this.bot.add('/', this.dialog);
    var self = this;
    this.compress = true;
    this.scanning = false;

    this.sensorConfig = config.controller.sensor;
    //flow.summaryhours
    // sysmanager.setConfig(this.sensorConfig);
    sysmanager.update((err, data) => {
    });

    setInterval(() => {
      sysmanager.update((err, data) => {
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
          log.info("Sending notification: " + notifMsg);
          
          notifMsg = {
            title: i18n.__("SECURITY_ALERT"),
            body: notifMsg
          }

          let data = {
            gid: this.primarygid,
          };

          if (msg.aid) {
            data.aid = msg.aid;
          }

          if (msg.alarmID) {
            data.alarmID = msg.alarmID;
          }
          
          switch(msg.alarmNotifType) {
            case "security":
              notifMsg.title = i18n.__("SECURITY_ALERT");
              break;
            case "activity":
              notifMsg.title = i18n.__("ACTIVITY_ALERT");
              break;
            default:
              break;
          }

          if (msg.autoblock) {
            data.category = "com.firewalla.category.autoblockalarm";
          } else {
            data.category = "com.firewalla.category.alarm";
          }

          this.tx2(this.primarygid, "test", notifMsg, data);
        }
      }
    });

    setTimeout(() => {
      this.scanStart();
      if (sysmanager.systemRebootedDueToIssue(true) == false) {
        if (nm.canNotify() == true) {
          this.tx(this.primarygid, "200", "🔥 Firewalla Device '" + this.getDeviceName() + "' Awakens!");
        }
      }
      this.setupDialog();
    }, 2000);

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
  }

  scanStart(callback) {
    this.hostManager.getHosts((err, result) => {
      let listip = [];
      this.hosts = result;
      for (let i in result) {
        log.info(result[i].toShortString());
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


    switch (msg.data.item) {
      case "policy":
        async.eachLimit(Object.keys(msg.data.value), 1, (o, cb) => {
          switch (o) {
            case "monitor":
              this._block(msg.target, "monitor", msg.data.value.monitor, (err, obj) => {
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
            default:
              cb();
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

        this.hostManager.getHost(msg.target, (err, host) => {
          if (host == null) {
            log.info("Host not found");
            reply.code = 404;
            this.txData(this.primarygid, "", reply, "jsondata", "", null, callback);
            return;
          }

          if (data.value.name == host.o.name) {
            log.info("Host not changed", data.value.name, host.o.name);
            reply.code = 200;
            this.txData(this.primarygid, "", reply, "jsondata", "", null, callback);
            return;
          }

          host.o.name = data.value.name;
          log.info("Changing names", host.o.name);
          host.save(null, (err) => {
            if (err) {
              reply.code = 500;
              this.txData(this.primarygid, "", reply, "jsondata", "", null, callback);
            } else {
              reply.code = 200;
              reply.data = msg.data.value;
              this.txData(this.primarygid, "", reply, "jsondata", "", null, callback);
            }
          });
        });
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

        // TODO validate input ??
        if (v.from && v.from === "firewalla") {
          let scisurf = require('../extension/ss_client/ss_client.js');
          scisurf.saveConfig(v, (err) => {
            this.simpleTxData(msg, {}, err, callback);
          });
        } else {
          this.simpleTxData(msg, {}, new Error("Invalid config"), callback);
        }

        break;
      case "language":
        let v2 = msg.data.value;

        // TODO validate input?
        if (v2.language) {
          sysmanager.setLanguage(v2.language, (err) => {
            this.simpleTxData(msg, {}, err, callback);
          });
        }
        break;
      case "timezone":
        let v3 = msg.data.value;

        if (v3.timezone) {
          sysmanager.setTimezone(v3, (err) => {
            this.simpleTxData(msg, {}, err, callback);
          });
        }
        break;
      case "mode":
        let v4 = msg.data.value;
        let err = null;
        if (v4.mode) {
          let modeManager = require('../net2/ModeManager.js');
          switch (v4.mode) {
            case "spoof":
              modeManager.setSpoofAndPublish();
              break;
            case "dhcp":
              modeManager.setDHCPAndPublish();
              break;
            default:
              log.error("unsupported mode: " + v4.mode);
              err = new Error("unsupport mode: " + v4.mode);
              break;
          }
          this.simpleTxData(msg, {}, err, callback);
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

  getHandler(gid, msg, callback) {
    // mtype: get
    // target = ip address
    // data.item = [app, alarms, host]

    switch (msg.data.item) {
      case "host":
        if (msg.target) {
          this.getAllIPForHost(msg.target, (err, ips) => {
            this.deviceHandler(msg, gid, msg.target, ips, callback);
          });
        }
        break;
      case "vpn":
      case "vpnreset":
        let regenerate = true;
        if (msg.data.item === "vpnreset") {
          regenerate = true;
        }

        this.hostManager.loadPolicy(() => {
          vpnManager.getOvpnFile("fishboneVPN1", null, regenerate, (err, ovpnfile, password) => {
            let datamodel = {
              type: 'jsonmsg',
              mtype: 'reply',
              id: uuid.v4(),
              expires: Math.floor(Date.now() / 1000) + 60 * 5,
              replyid: msg.id,
              code: 404,
            };
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

          var data = "";

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
        let ssc = require('../extension/ss_client/ss_client.js');
        ssc.loadConfig((err, result) => {
          this.simpleTxData(msg, result || {}, err, callback);
        });
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
      case "exceptions":
        em.loadExceptions((err, exceptions) => {
          this.simpleTxData(msg, {exceptions: exceptions, count: exceptions.length}, err, callback);
        });
        break;
      default:
        this.simpleTxData(msg, null, new Error("unsupported action"), callback);
    }
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
                this.prepareRecentFlowsForHost(jsonobj, listip)
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

  prepareRecentFlowsForHost(json, listip) {
    if (!"flows" in json)
      json.flows = {};

    json.flows.time = [];

    let promises = listip.map((ip) => {
      return flowTool.getRecentOutgoingConnections(ip)
        .then((flows) => {
          Array.prototype.push.apply(json.flows.time, flows);
          return json;
        })
    });

    return Promise.all(promises);

  }

  enrichCountryInfo(flows) {
    // support time flow first
    let flowsSet = [flows.time, flows.rx, flows.tx];

    flowsSet.forEach((eachFlows) => {
      eachFlows.forEach((flow) => {
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
    if (msg.data.item === "reboot") {
      log.info("Rebooting");
      let datamodel = {
        type: 'jsonmsg',
        mtype: 'init',
        id: uuid.v4(),
        expires: Math.floor(Date.now() / 1000) + 60 * 5,
        replyid: msg.id,
        code: 200
      }
      this.txData(this.primarygid, "reboot", datamodel, "jsondata", "", null, callback);
      require('child_process').exec('sync & /home/pi/firewalla/scripts/fire-reboot-normal', (err, out, code) => {
      });
    } else if (msg.data.item === "reset") {
      log.info("Reseting System");
      let task = require('child_process').exec('/home/pi/firewalla/scripts/system-reset-all', (err, out, code) => {
        let datamodel = {
          type: 'jsonmsg',
          mtype: 'init',
          id: uuid.v4(),
          expires: Math.floor(Date.now() / 1000) + 60 * 5,
          replyid: msg.id,
          code: 200
        }
        this.txData(this.primarygid, "reset", datamodel, "jsondata", "", null, callback);
      });
    } else if (msg.data.item === "resetpolicy") {
      log.info("Reseting Policy");
      let task = require('child_process').exec('/home/pi/firewalla/scripts/reset-policy', (err, out, code) => {
        let datamodel = {
          type: 'jsonmsg',
          mtype: 'init',
          id: uuid.v4(),
          expires: Math.floor(Date.now() / 1000) + 60 * 5,
          replyid: msg.id,
          code: 200
        }
        this.txData(this.primarygid, "reset", datamodel, "jsondata", "", null, callback);
      });
    } else if (msg.data.item === "upgrade") {
      log.info("upgrading");
      let task = require('child_process').exec('/home/pi/firewalla/scripts/upgrade', (err, out, code) => {
        let datamodel = {
          type: 'jsonmsg',
          mtype: 'init',
          id: uuid.v4(),
          expires: Math.floor(Date.now() / 1000) + 60 * 5,
          replyid: msg.id,
          code: 200
        }
        this.txData(this.primarygid, "reset", datamodel, "jsondata", "", null, callback);
      });

    } else if (msg.data.item === "shutdown") {
      log.info("shutdown firewalla in 60 seconds");
      let task = require('child_process').exec('sudo shutdown -h', (err, out, code) => {
        let datamodel = {
          type: 'jsonmsg',
          mtype: 'init',
          id: uuid.v4(),
          expires: Math.floor(Date.now() / 1000) + 60 * 5,
          replyid: msg.id,
          code: 200
        }
        this.txData(this.primarygid, "shutdown", datamodel, "jsondata", "", null, callback);
      });
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
    }

    switch (msg.data.item) {
      case "debugOn":
        sysmanager.debugOn((err) => {
          this.simpleTxData(msg, null, err, callback);
        });
        break;
      case "debugOff":
        sysmanager.debugOff((err) => {
          this.simpleTxData(msg, null, err, callback);
        });
        break;
      case "resetSSHPassword":
        ssh.resetRandomPassword((err, password) => {
          sysmanager.sshPassword = password;
          this.simpleTxData(msg, null, err, callback);
        });
        break;

      case "resetSciSurfConfig":
        let ssc = require('../extension/ss_client/ss_client.js');
        ssc.stop((err) => {
          // stop should always succeed
          if (err) {
            // stop again if failed
            ssc.stop((err) => {
            });
          }
          ssc.clearConfig((err) => {
            this.simpleTxData(msg, null, err, callback);
          });
        });
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
        am2.blockFromAlarm(msg.data.value.alarmID, msg.data.value, (err) => {
          this.simpleTxData(msg, null, err, callback);
        });
        break;
      case "alarm:allow":
        am2.allowFromAlarm(msg.data.value.alarmID, msg.data.value, (err) => {
          this.simpleTxData(msg, null, err, callback);
        });
        break;
      case "alarm:unblock":
        am2.unblockFromAlarm(msg.data.value.alarmID, msg.data.value, (err) => {
          this.simpleTxData(msg, null, err, callback);
        });
        break;
      case "alarm:unallow":
        am2.unallowFromAlarm(msg.data.value.alarmID, msg.data.value, (err) => {
          this.simpleTxData(msg, null, err, callback);
        });
        break;

      case "alarm:unblock_and_allow":
        am2.unblockFromAlarm(msg.data.value.alarmID, msg.data.value, (err) => {
          if (err) {
            log.error("Failed to unblock", msg.data.value.alarmID, ", err:", err, {});
            this.simpleTxData(msg, null, err, callback);
            return;
          }

          am2.allowFromAlarm(msg.data.value.alarmID, msg.data.value, (err) => {
            if (err) {
              log.error("Failed to allow", msg.data.value.alarmID, ", err:", err, {});
            }
            this.simpleTxData(msg, null, err, callback);
          });
        });

      case "policy:create":
        pm2.createPolicyFromJson(msg.data.value, (err, policy) => {
          if (err) {
            this.simpleTxData(msg, null, err, callback);
            return;
          }

          pm2.checkAndSave(policy, (err, policyID) => {
            this.simpleTxData(msg, null, err, callback);
          });
        });
        break;
      case "policy:delete":
        pm2.disableAndDeletePolicy(msg.data.value.policyID)
          .then(() => {
            this.simpleTxData(msg, null, null, callback);
          }).catch((err) => {
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

      default:
        // unsupported action
        this.simpleTxData(msg, null, new Error("Unsupported action"), callback);
        break;
    }
  }

  simpleTxData(msg, data, err, callback) {
    this.txData(this.primarygid, msg.data.item, this.getDefaultResponseDataModel(msg, data, err), "jsondata", "", null, callback);
  }

  getDefaultResponseDataModel(msg, data, err) {
    var code = 200;
    var message = "";
    if (err) {
      log.error("Got error before simpleTxData: " + err);
      code = 500;
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
//            log.info("Received jsondata", msg);
      if (rawmsg.message.obj.type === "jsonmsg") {
        if (rawmsg.message.obj.mtype === "init") {
          
          log.info("Process Init load event");

          this.loadInitCache((err, cachedJson) => {
            if (true || err || !cachedJson) {
              if (err)
                log.error("Failed to load init cache: " + err);

              // regenerate init data
              log.info("Re-generate init data");

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
          this.getHandler(gid, msg, callback);
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
    return "Bot version " + sysmanager.version() + "\n\nCli interface is no longer useful, please type 'system reset' after update to new encipher app on iOS\n";
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

process.on("unhandledRejection", function (r, e) {
  log.info("Oh No! Unhandled rejection!! \nr::", r, "\ne::", e);
});

var bone = require('../lib/Bone.js');
process.on('uncaughtException', (err) => {
  log.info("+-+-+-", err.message, err.stack);
  bone.log("error", {
    program: 'ui',
    version: sysmanager.version(),
    type: 'exception',
    msg: err.message,
    stack: err.stack
  }, null);
  setTimeout(() => {
    process.exit(1);
  }, 1000 * 2);
});

module.exports = netBot;
