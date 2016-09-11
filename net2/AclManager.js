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

var instance = null;
var log = null;
var SysManager = require('./SysManager.js');
var sysManager = new SysManager('info');

var redis = require("redis");
var rclient = redis.createClient();

var later = require('later');

var iptables = require('./Iptables.js');
var ip6tables = require('./Ip6tables.js');


/*
 *  persist:  
 *    policy:acl:<hostid> 
 */

module.exports = class {
    constructor(loglevel) {
        if (instance == null) {
            log = require("./logger.js")("acl", loglevel);
            instance = this;
            this.activeAcl = {};
            this.loadAndRunSaved();
            // flush all ACL
            // should restore block here
        }
        return instance;
    }

    loadAndRunSaved() {}

    findById(id, callback) {
        rclient.
    }

    findByFlow(ipVersion, src, dst, srcPort, dstPort, callback) {}

    run(aclObj, callback) {}

    // add(id,allowOrDrop,ipVersion,, protocol, src,dst,srcPort,dstPort,cron,timezone,duration,options,expires,notes) {
    remove(aclObj, save, callback) {

    }

    modify(aclObj, save, callback) {}

    add(aclObj, save, callback) {
        let key = "acl:flow:" + aclObj.ipVersion + ":" + aclObj.protocol + ":" + aclObj.src + ":" + aclObj.dst + ":" + aclObj.srcPort + ":" + aclObj.dstPort;
        if (this.activeAcl[key] != null) {
            callback(null, null);
            return;
        }

        this.findByFlow(aclObj.ipVersion, aclObj.protocol, aclObj.src, aclObj.dst, aclObj.srcPort, aclObj.dstPort, (err, flow) {
            if (err != null || flow != null) {
                callback(err, flow)
                return;
            }

            if (save == true) {
                rclient.hmset(key, aclObj, callback(err, flow) {
                    let ikey = "acl:id:" + aclObj.id;
                    aclObj.saved == true;
                    rclient.hmset(ikey, aclObj, callback(err, flow) {

                    });
                });
            } else {


            }
        });
    }

}
