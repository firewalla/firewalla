#!/usr/bin/env node

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

// TODO Need to check argument, a null appid work ... shouldn't
'use strict';

let log2 = require('../net2/logger.js')(__filename, 'info');
let log = log2.info;
const Trace = require('../util/audit.js');
const rclient = require('../util/redis_manager.js').getRedisClient()

module.exports = class {
    // config is the controller json file + the controller section of fullConfig
    constructor(config, fullConfig, eptcloud, groups, gid, debug, apiMode) {
        this.type = config.controller.type;
        this.id = eptcloud.eid + "." + config.controller.id;
        this.name = config.controller.name;

        this.config = config;
        this.groups = groups;
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

        if (apiMode) {
            log2.info("Skipping eptcloud feature during API mode");
            return; // skip eptcloud stuff when in API Mode
        }

        log2.info("Initializeing Controller", this.name, this.type, this.id);

        //        log("Processing Config: ", config, fullConfig, gid, debug);
        log2.info("Groups Counter : ", groups.length, gid);
        for (let g in groups) {
            let group = groups[g];
            log2.debug("Processing Groups : ", group);
            //if (group['me'] == null || group['me']['disiplayName'] == null) {
            if (group.me == null) {
                /*
                if (groups[g]['me'] == null) {
                    log("Group Error: ",groups[g]['me']);
                } else if (groups[g]['me']['displayName'] == null) {
                    log("Group Error 2: ",groups[g]['me']);
                }
              */
                continue;
            }
            //            log("GROUP ID: ", group.gid, " Known as: ", group.me.displayName);
            log2.info("Group ID: ", groups[g].gid, " Known as: ", groups[g].me.displayName);
            this.groupsdb[group['gid']] = group;
            if (fullConfig.listen == "all" || group.gid == gid) {
                log("Listening to group ", group.gid, groups[g].name, "members count", group['symmetricKeys'].length);
                if (group['symmetricKeys'].length > 2) {
                    this.tx(group['gid'], "Please use @" + group.me.displayName + " to talk to me");
                }
                eptcloud.pullMsgFromGroup(groups[g].gid, 4, (e, r) => {
                    //log2.info(" - ----- Received :",r.length," msgs",r);
                    let myname = groups[g].me.displayName;
                    if (e == null && r != null && r.length > 0) {
                        for (let i = 0; i < r.length; i++) {
                            let lmsg = r[i].message.msg.toLowerCase();
                            if (lmsg.indexOf('@' + myname) == -1 && group['symmetricKeys'].length > 2) {
                                continue;
                            }
                            let msg = r[i].message.msg.toLowerCase();
                            this.msgHandler(group.gid, r[i]);
                        }
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
        for (let g in this.groups) {
            let group = this.groups[g];
            if (group.gid === this.primarygid) {
                return group.name;
            }
        }

        return "Unknown"; // should not reach this line, every device should belong to a group
    }

    msgHandler(gid, msg, callback) { }

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
                log2.info("Error Sending file", e);
            } else {
                log("Message is sent successfully");
            }
        });
    }

    txData(gid, msg, obj, type, beepmsg, whisper, callback, rawmsg) {
        if (rawmsg && rawmsg.appInfo && rawmsg.appInfo.eid && rawmsg.mtype != "init") {
            const appInfo = rawmsg.appInfo;
            //subscribe trace if command from app
            const filterItems = ["ping"]
            const item = rawmsg.data && rawmsg.data.item;
            if (filterItems.indexOf(item) == -1) {
                let tracelog = {
                    target: rawmsg.target,
                    action: rawmsg.data,
                    appInfo: {
                        deviceName: appInfo.deviceName,
                        eid: appInfo.eid,
                        appID: appInfo.appID,
                        platform: appInfo.platform,
                        version: appInfo.version
                    },
                    success: obj.code == 200,
                    mtype: rawmsg.mtype
                }
                if (!tracelog.success) tracelog.error = obj.message
                Trace(tracelog)
            }            
        }
        if (typeof callback === 'function') { //direct callback mode
            callback(null, obj);
            return;
        }

        if (typeof callback === 'object') {
            if (callback.compressMode) {
                obj.compressMode = true;
            }
        }

        var name = this.groupsdb[gid].me.displayName;
        this.eptcloud.sendDataToGroup(gid, msg, obj, type, name, beepmsg, whisper, (e, r) => {
            if (e) {
                log2.info("Error Sending data", e, JSON.stringify(msg).length);
            } else {
                log2.info("Success Sending", r);
            }
        });
    }

    txHtml(gid, m, beepmsg) {
        var name = this.groupsdb[gid].me.displayName;
        this.eptcloud.sendHtmlToGroup(gid, m, beepmsg, name, (e, r) => {
            log2.info("sending html", e, r);
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
                log2.info("sending text", e, r);
            });
        } else {
            log("Group " + gid + " doesn't exist");
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
                log2.info("sending text", e, r);
            });
        } else {
            log("Group " + gid + " doesn't exist");
        }
    }

    // check if device name should be included
    // sometimes it is helpful if multiple devices are bound to one app
    getConfIncludeName() {
        return rclient.hgetAsync("sys:config", "includeNameInNotification");
    }
};
