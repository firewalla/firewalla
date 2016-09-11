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
var redis = require("redis");
var rclient = redis.createClient();
var sclient = redis.createClient();
sclient.setMaxListeners(0);


/*
 * Channels
 *
 *   DiscoveryEvent
 *     -> Notice:Detected
 *     -> Scan:Done
 *     -> DiscoveryStart 
 *
 */

var instance = null;

module.exports = class {
    constructor(loglevel) {
        if (instance == null) {
            log = require("./logger.js")("MessageBus", loglevel);
            instance = this;
            this.callbacks = {};
            sclient.on("message", (channel, message) => {
                let m = JSON.parse(message);
                console.log("Reciving Msg:", m);
                let notified = 0;
                if (m.ip.length > 3 && this.callbacks[channel + '.' + m.type + "." + m.ip] != null) {
                    this.callbacks[channel + "." + m.type + "." + m.ip](channel, m.type, m.ip, m.msg);
                    notified += 1;
                }
                if (this.callbacks[channel + "." + m.type]) {
                    this.callbacks[channel + "." + m.type](channel, m.type, m.ip, m.msg);
                    notified += 1;
                }
                console.log("Notified ", notified);
            });
        }
        return instance;
    }

    publish(channel, type, ip, msg) {
        let o = {
            type: type,
            ip: ip,
            msg: msg
        };
        log.debug("MBus:Publish", channel, o);
        rclient.publish(channel, JSON.stringify(o));
    }

    subscribe(channel, type, ip, callback) {
        //log.debug("MBus:Subscribe",channel,type,ip);
        sclient.subscribe(channel);
        if (ip == null) {
            this.callbacks[channel + "." + type] = callback;
        } else {
            this.callbacks[channel + "." + type + "." + ip] = callback;
        }

    }
};
