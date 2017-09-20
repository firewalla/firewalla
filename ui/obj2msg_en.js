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
var log;
var config;

/*
 * type:
 *   intel
 *   flowin
 *   flowout
 *   av
 *   porn
 *   gaming ..
 */

function noticeMsg(host, obj) {
   let msg = null;
   if ((obj.note == "Scan::Port_Scan" || obj.note == "Scan::Address_Scan") && this.scanning == false) {
      msg = host.name() + ": " + obj.msg;
   } else if ((obj.note == "Scan::Port_Scan" || obj.note == "Scan::Address_Scan") && this.scanning == true) {
      console.log("Netbot:Notice:Skip due to scanning", obj);
   } else {
      let msg = host.name() + ": " + obj.msg;
   }
   return msg;
}

function intelMsg(host, obj) {
    let msg = null;
    let reason = "";
    if (obj.intel) {
        if (obj.intel.tags != null && obj.intel.tags.length > 0) {
            reason = "Possible: ";
            let first = true;
            for (let i in obj.intel.tags) {
                if (first) {
                    reason += obj.intel.tags[i].tag;
                    first = false;
                } else {
                    reason += " or " + obj.intel.tags[i].tag;
                }
            }
        }
    }

    if (obj['seen.indicator_type'] == "Intel::DOMAIN") {
        msg = reason + ". Device " + host.name() + ": " + obj['id.orig_h'] + " talking to " + obj['seen.indicator'] + ":" + obj['id.resp_p'] + ". (Reported by " + obj.intel.count + " sources)";
    } else {
        msg = reason + " " + host.name() + ": " + obj['id.orig_h'] + " talking to " + obj['id.resp_h'] + ":" + obj['id.resp_p'] + ". (Reported by " + obj.intel.count + " sources)";
    }
   return msg;
}

function FlowToStringShortShort2(obj, type, interest) {
        let sname = obj.sh;
        if (obj.shname) {
            sname = obj.shname;
        }
        let name = obj.dh;
        if (type == 'txdata' || type =='out') {
            if (obj.appr && obj.appr.length > 2) {
                name = obj.appr;
            } else if (obj.dhname && obj.dhname.length > 2) {
                name = obj.dhname;
            }
        } else {
            if (obj.appr && obj.appr.length > 2) {
                name = obj.appr;
            } else if (obj.org && obj.org.length > 2) {
                name = obj.org;
            } else if (obj.dhname && obj.dhname.length > 2) {
                name = obj.dhname;
            }
        }

        //let time = Math.round((Date.now() / 1000 - obj.ts) / 60);
        let time = Math.round((Date.now() / 1000 - obj.ts) / 60);
        let dtime = "";

        if (time>5) {
            dtime = time+" min ago, ";
        }

        if (type == null) {
            return name + "min : rx " + obj.rb + ", tx " + obj.ob;
        } else if (type == "rxdata" || type == "in") {
            if (interest == 'txdata') {
                return dtime+sname + " transferred to " + name + " [" + obj.ob + "] bytes" + " for the duration of " + Math.round(obj.du / 60) + " min.";
            }
            return dtime+sname + " transferred to " + name + " " + obj.ob + " bytes" + " for the duration of " + Math.round(obj.du / 60) + " min.";
        } else if (type == "txdata" || type == "out") {
            if (interest == 'txdata') {
                return dtime+sname + " transferred to " + name + " : [" + obj.rb + "] bytes" + " for the duration of " + Math.round(obj.du / 60) + " min.";
            }
            return dtime+sname + " transferred to " + name + ", " + obj.rb + " bytes" + " for the duration of " + Math.round(obj.du / 60) + " min.";
        }
    }



function flowMsg(host,type, obj) {
            let m = null;
            let n = null;
            console.log("Monitor:Flow:Out", channel, ip, obj, "=====");
            if (ip && obj) {
                if (obj['txRatioRanked'] && obj['txRatioRanked'].length > 0) {
                    let flow = obj['txRatioRanked'][0];
                    if (flow.rank > 0) {
                        return;
                    }
                    m = "Warning: \n\n" + FlowToStringShortShort2(obj['txRatioRanked'][0], obj.direction, 'txdata') + "\n";
                    n = flowManager.toStringShortShort2(obj['txRatioRanked'][0], obj.direction);
                }
            }
            if (m) {
                console.log("MonitorEvent:Flow:Out", m,obj);
                this.tx2(this.primarygid, m, n, {id:obj.id});
            }
   
}

function eventMsg(host,type,obj) {
    if (type == "games") {
         return host.name()+" is likly playing games at "+obj.actionobj.dhname;
    } else if (type=="porn") {
         return host.name()+" is likely watching Porn at "+obj.actionobj.dhname;
    }
}

function obj2msg(host, type, obj) {
    if (type == 'notice') {
        return intelNotice(host, obj);
    } else if (type == 'intel') {
        return intelMsg(host, obj);
    } else if (type == 'flowin' || type == 'flowout') {
        return flowMsg(host, type, obj);
    } else  {
        return eventMsg(host,type,obj);
    }
}

module.exports = {
  obj2msg: obj2msg,
}

