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

var instance = null;
var log = null;
var SysManager = require('./SysManager.js');
var sysManager = new SysManager('info');

const rclient = require('../util/redis_manager.js').getRedisClient()

var later = require('later');

module.exports = class {
    constructor(path, loglevel) {
        if (instance == null) {
            log = require("./logger.js")("Device Manager", loglevel);
            rclient.keys("appr:*", (err, keys) => {
                let multiarray = [];
                for (let i in keys) {
                    multiarray.push(['del', keys[i]]);
                }
                rclient.multi(multiarray).exec((err, replies) => {
                    log.debug("Wipped all app signatures");
                    this.rebuild(path);
                });
            });

            instance = this;
        }
        return instance;
    }

    // type:
    //  { 'human': 0-100
    //    'type': 'Phone','desktop','server','thing'
    //    'subtype: 'ipad', 'iphone', 'nest'
    //
    calculateDType(callback) {
        rclient.smembers("host:user_agent:" + this.o.ipv4Addr, (err, results) => {
            if (results != null) {
                let human = results.length / 100.0;
                this.dtype = {
                    'human': human
                };
                this.save();
                if (callback) {
                    callback(null, this.dtype);
                }
            } else {
                if (callback) {
                    callback(err, null);
                }
            }
            this.syncToMac(null);
        });
    }



}
