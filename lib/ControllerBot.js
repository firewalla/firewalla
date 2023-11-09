#!/usr/bin/env node

/*    Copyright 2016-2023 Firewalla Inc.
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

// TODO Need to check argument, a null appid work ... shouldn't
'use strict';

const log = require('../net2/logger.js')(__filename);
const Trace = require('../util/audit.js');
const rclient = require('../util/redis_manager.js').getRedisClient()
const pclient = require('../util/redis_manager.js').getPublishClient();
const sem = require('../sensor/SensorEventManager.js').getInstance();
const f = require('../net2/Firewalla.js');
const Message = require('../net2/Message.js');

let forceTrace = false;

rclient.get("sys:trace:force", (err, reply) => {
  if(reply) {
    forceTrace = true;
  }
};


module.exports = class {
    // config is the controller json file + the controller section of fullConfig
    constructor(config, fullConfig, eptcloud, groups, gid, debug, offlineMode = false) {
        this.type = config.controller.type;
        this.id = eptcloud.eid + "." + config.controller.id;
        this.name = config.controller.name;

        this.fullConfig = fullConfig
        this.config = config;
        this.groups = groups;
        this.gid = gid;
        this.eptcloud = eptcloud;
        this.eid = eptcloud.eid;
        this.primarygid = gid;
        this.groupsdb = {};
        this.intercommDevices = {};
        this.defaultDevice = null;
        this.capabilitydb = {};

        this._txQueue = [];
        this._txQueueTxing = false;

        this.compress = true; // if this is on, if last msg send is same ... don't send

        this.offlineMode = offlineMode

        if (offlineMode) {
            log.info("Skipping eptcloud feature in offline mode");
            return; // skip eptcloud stuff when in offline Mode
        }

        this.initEptCloud()
    }

    initEptCloud() {
      log.info("Initializeing Controller", this.name, this.type, this.id);

      log.info("Groups Counter : ", this.groups.length, this.gid);
      for (const group of this.groups) {
        log.debug("Processing Groups : ", group);
        if (group.me == null) {
          continue;
        }
        log.info("Group ID: ", group.gid, " Known as: ", group.me.displayName);
        this.groupsdb[group.gid] = group;
        if (this.fullConfig.listen == "all" || group.gid == this.gid) {
          log.info("Listening to group ", group.gid, group.name, "members count", group.symmetricKeys.length);
          if (group.symmetricKeys.length > 2) {
            this.tx(group.gid, "Please use @" + group.me.displayName + " to talk to me");
          }
          this.eptcloud.pullMsgFromGroup(group.gid, 4, (e, r) => {
            if (e) {
              log.error('Error getting message from group', e)
              return
            }

            log.debug(" - ----- Received :", r.length, " msgs", r);
            let myname = group.me.displayName;
            if (!Array.isArray(r)) return
            for (const ri of r) try {
              let message = ri.message;
              if (message && "msg" in message && message.msg.constructor.name === 'String') {
                let lmsg = message.msg.toLowerCase();
                if (lmsg.indexOf('@' + myname) == -1 && group.symmetricKeys.length > 2) {
                  // anicent code, don't know logic here
                  log.error("Skipped");
                  continue;
                }
                let options = {}
                if (ri.mtype === "msg" && message.type === 'jsondata' && "compressMode" in message) {
                  options = {
                    compressMode: ri.message.compressMode
                  }
                }
                this.msgHandler(group.gid, ri, options);
              } else {
                log.error("Invalid error message:", ri);
              }
            } catch (err) {
              log.error("Got error when parsing messages, err:", err);
            }
          }, (e, msg) => {
            if (this.boneMsgHandler) {
              this.boneMsgHandler(msg);
            }
          });
        }
      }
    }

    getDeviceName() {
        for (const group of this.groups) {
            if (group.gid === this.primarygid) {
                return group.name;
            }
        }

        return "Unknown"; // should not reach this line, every device should belong to a group
    }

  updatePrimaryDeviceName(name) {
        for (const group of this.groups) {
            if (group.gid === this.primarygid) {
              group.name = name;
              break;
            }
        }
  }

    async msgHandler(gid, msg, options) { }

    // this is advertise locally or may be remotely like steaming addres ...
    addCapability(gid, eid, type, object, publish) {
        this.capabilitydb[type] = object;
        if (publish) {
            this.publish(gid, eid);
        }
    }

    // msg == type == video
    txFile(gid, thumb, file, msg, type, beepmsg, height, width) {
        let name = this.groupsdb[gid].me.displayName;
        this.eptcloud.sendFileToGroup(gid, msg, file, thumb, type, name, beepmsg, height, width, "", function (e, r) {
            if (e) {
                log.info("Error Sending file", e);
            } else {
                log.info("Message is sent successfully");
            }
        });
    }

    async txData(gid, msg, obj, type, beepmsg, whisper, cloudOptions, rawmsg) {
        this.recordTracelog(rawmsg,obj);

        // local requests
        if (!cloudOptions) return obj;

        if (cloudOptions && cloudOptions.compressMode) {
            obj.compressMode = true;
        }

        var name = this.groupsdb[gid].me.displayName;

        return new Promise((resolve, reject) => {
            this.eptcloud.sendDataToGroup(gid, msg, obj, type, name, beepmsg, whisper, (e) => {
                if (e) {
                    log.error("Error Sending data", e, JSON.stringify(msg));
                    reject(e);
                } else {
                    log.info("Success Sending via cloud")
                    log.debug(msg, obj);
                    resolve(obj);
                }
            });
        });
    }

    recordTracelog(rawmsg, obj) {
      try {
        const appInfo = rawmsg.appInfo;
        const mtype = rawmsg.mtype;
        const data = rawmsg.data;
        if (mtype == "init" || mtype == "get") return; // no need record init/get

        if (data && data.item === "batchAction") {
          // no need to record batch action at all
          // because each set/cmd action within the batch
          // will be logged separately
          return;
        }

        const filterItems = ["ping", 'liveStats'];
        const item = data && data.item;
        if (!appInfo.eid) return;
        if (filterItems.indexOf(item) != -1) return;
        if (appInfo.platform == "web" && item == "flows") return;
        let tracelog = {
          target: rawmsg.target,
          action: data,
          appInfo: {
            deviceName: appInfo.deviceName,
            eid: appInfo.eid,
            appID: appInfo.appID,
            platform: appInfo.platform,
            version: appInfo.version
          },
          success: obj.code == 200,
          mtype: mtype
        }
        if (!tracelog.success) tracelog.error = obj.message
        Trace(tracelog)
        if (['set', 'cmd'].includes(mtype) && rawmsg.id) {
          const a = Object.assign({ id: rawmsg.id },tracelog);

          sem.emitEvent({
            type: "RecordAction",
            message: `Record action ${rawmsg.id}`,
            action: a
          });

          // publish redis event for debugging
          if (f.isDevelopmentVersion() || forceTrace) {
            pclient.publish(Message.MSG_TRACE, JSON.stringify(a));
          }
        }
      } catch (e) {
        log.error("RecordTracelog error", e, rawmsg, obj);
      }
    }

    txHtml(gid, m, beepmsg) {
        var name = this.groupsdb[gid].me.displayName;
        this.eptcloud.sendHtmlToGroup(gid, m, beepmsg, name, (e, r) => {
            log.info("sending html", e, r);
        });
    }

    txQ(gid, m, beepmsg) {
        let msg = JSON.stringify({
            gid: gid,
            m: m,
            beepmsg: beepmsg
        });
        if (this._txQueue.indexOf(msg) > -1 && this.compress == true) {
            return;
        }
        this._txQueue.push(msg);
        this._txQ();
    }
    txQ2(gid, m, beepmsg, beepdata) {
        let msg = JSON.stringify({
            gid: gid,
            m: m,
            beepmsg: beepmsg,
            beepdata: beepdata,
        });
        if (this._txQueue.indexOf(msg) > -1 && this.compress == true) {
            return;
        }
        this._txQueue.push(msg);
        this._txQ();
    }

    _txQ() {
        if (this._txQueueTxing == true) {
            return;
        }
        this._txQueueTxing = true;
        let p = this._txQueue.splice(0, 1)[0];
        if (p) {
            p = JSON.parse(p);
        }
        if (this.compress == true && this.lastmsg != null && p != null) {
            if (p.m == this.lastmsg.m && p.gid == this.lastmsg.gid) {
                this._txQueueTxing = false;
                this._txQ();
                setTimeout(() => {
                    this.lastmsg = null
                }, 3000);
                return;
            }
        }
        if (p != null) {
            var name = this.groupsdb[p.gid].me.displayName;
            setTimeout(() => {
                this.eptcloud.sendTextToGroup2(p.gid, p.m, p.beepmsg, p.beepdata, name, (e, r) => {
                    this._txQueueTxing = false;
                    this.lastmsg = p;
                    this._txQ();
                });
            }, 100);
        } else {
            this._txQueueTxing = false;
        }
    }

    async tx(gid, m, beepmsg) {
        let flag = await this.getConfIncludeName()
        if (flag == "1") {
            beepmsg = { title: `[${this.getDeviceName()}]`, body: beepmsg }
        }

        let group = this.groupsdb[gid];
        if (group) {
            var name = this.groupsdb[gid].me.displayName;
            this.eptcloud.sendTextToGroup2(gid, m, beepmsg, null, name, (e, r) => {
                log.info("sending text", e, r);
            });
        } else {
            log.info("Group " + gid + " doesn't exist");
        }
    }

    async tx2(gid, m, beepmsg, beepdata) {
        let flag = await this.getConfIncludeName()
        if (flag == "1" && beepmsg.title)
            beepmsg.title = `[${this.getDeviceName()}] ${beepmsg.title}`;

        let group = this.groupsdb[gid];
        if (group) {
            var name = this.groupsdb[gid].me.displayName;
            this.eptcloud.sendTextToGroup2(gid, m, beepmsg, beepdata, name, (e, r) => {
                log.info("sending text", e, r);
            });
        } else {
            log.info("Group " + gid + " doesn't exist");
        }
    }

    // check if device name should be included
    // sometimes it is helpful if multiple devices are bound to one app
    getConfIncludeName() {
        return rclient.hgetAsync("sys:config", "includeNameInNotification");
    }
};
