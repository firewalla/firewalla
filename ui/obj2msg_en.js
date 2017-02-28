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
var log;
var config;


function intelNotice(host, obj) {
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
   if (obj.intel != null && obj.intel['reason'] != null) {
       reason = obj.intel.reason;
   }
   if (obj['seen.indicator_type'] == "Intel::DOMAIN") {
       msg = reason + ". Device " + host.name() + ": " + obj['id.orig_h'] + " talking to " + obj['seen.indicator'] + ":" + obj['id.resp_p'] + ". (Reported by " + obj.intel.count + " sources)";
   } else {
       msg = reason + " " + host.name() + ": " + obj['id.orig_h'] + " talking to " + obj['id.resp_h'] + ":" + obj['id.resp_p'] + ". (Reported by " + obj.intel.count + " sources)";
   }
   if (obj.intel && obj.intel.summary) {
        //msg += "\n" + obj.intelurl;
   }
   return msgl
}

function flowMsg(host, obj) {
}

function obj2msg(host, type, obj) {
    if (type == 'notice') {
        return intelNotice(host, obj);
    } else if (type == 'intel') {
        return intelMsg(host, obj);
    } else if (type == 'flow') {
        return flowMsg(host, obj);
    }
}

module.exports = {
  obj2msg: obj2msg,
}

