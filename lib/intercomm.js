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
var fs = require('fs');
var bonjour = require('bonjour');
var uuid = require('uuid');

let log = require('../net2/logger')(__filename);

/*
 * type: 'devhi'
 *
     var txtfield = {
       'gid':gid,
       'seed':symmetrickey.seed,
       'keyhint':'You will find the key on the back of your device',
       'service':program.service_name,
       'type':program.service_type,
       'mid':uuid.v4(),
       'exp':Date.now()/1000+adminTotalInterval,
      };

 * type: 'devinfo'
 *  
 *    var info = {
 *      'eid': eid,
 *      'gid': gid,
 *      'device':'zwave',
 *      'location': 'something'
 *      'group': 'group name'
 *      'timestamp':'time stamp',
 *      'info':'
 *         {'vstream',{ ... }
            'sensors',{...}
 */

var instance = null;

var intercomm = new class {
    constructor() {
        if (!instance) {
            instance = this;
            this.bonjour = require('bonjour')();
            this.bonjour.unpublishAll();
            this.serviceMap = {};
        }
        return instance;
    }

    bye() {
        try {
            bonjour.unpublishAll();
        } catch (e) {}
    }

    publishInfo(gid, eid, gname, device, location, info, medium) {
        try {
            var txt = {
                'gid': gid,
                'eid': eid,
                'device': device,
                'location': location,
                'timestamp': Date.now() / 1000,
                'info': JSON.stringify(info),
            }
            return this.publish(medium, eid, 'devinfo', 80, 'tcp', txt);
        } catch (e) {
            log.info("Publishing Info error ", e);
        }
    }

    //take uuid  and encode it with base64
    encode_uuid(uid) {
        let buff = new Buffer(uuid.parse(uid));
        let ascii = buff.toString('base64');
        let asciiShort = ascii.slice(0, ascii.length - 2);
        log.info(ascii, asciiShort);
        return asciiShort;
    }

    bcapable() {
        let bleno = require('bleno');
        return bleno.state == 'poweredOn';
    }

    bpublish(gid, rid, typecode) {
        log.info("XX BlueTooth Publishing Started", gid, rid);
        var bleno = require('bleno');
        bleno.on('stateChange', (state) => {
            bleno.stopAdvertising();
            log.info("XX Bluetooth state", state);
            if (state == 'poweredOn') {
                let name = "fb" + typecode + this.encode_uuid(gid); //+gid.splice(19,-1);
                log.info("BlueTooth ", state, "publishing ", name, rid);
                bleno.startAdvertising(name, [rid]);
            } else {
                bleno.stopAdvertising();
            }
        });
    }

    bstop() {
        var bleno = require('bleno');
        bleno.stopAdvertising();
    }

    stop(service) {
        if (service) {
            service.stop();
        }
    }

    unpublish(serviceName, callback) {
        callback();
        return;
        let service = this.serviceMap[serviceName];
        if (service != null) {
            log.info("Unpubishing all");
            service.stop(() => {
                log.info("### UNPIUBLSIHED", serviceName);
                this.serviceMap[serviceName] = null;
                if (callback) {
                    callback();
                }
            });
        } else {
            if (callback) {
                callback();
            }
        }
    }

    publish(medium, name, type, port, protocol, txt) {
        let serviceName = 'eph:' + type + ':' + name;
        let options = {
            name: serviceName,
            type: 'http',
            port: port,
            txt: txt
        };
        let service = this.serviceMap[serviceName];

        this.unpublish(serviceName, () => {
            try {
                if (service) {
                    service.stop(() => {
                        setTimeout(() => {
                            log.forceInfo("Re-Publishing", options.name, {});
                            service = this.bonjour.publish(options);
                            if (service == null) {
                              log.error("Error publishing ========");
                            }
                            this.serviceMap[serviceName] = service;
                        }, 1000);
                    });
                    return null;
                } else {
                    log.forceInfo("Publishing", options.name, {});
                    log.debug(options);
                    service = this.bonjour.publish(options);
                    if (service == null) {
                        log.error("Error publishing ========");
                    }
                    this.serviceMap[serviceName] = service;
                    return service;
                }
            } catch (e) {
                log.info("Publishing error ", options, {});
            }
        });
    }

    discover(medium, type, callback) {
        this.bonjour.find({
            type: 'http'
        }, function (service) {
            if (service.name.startsWith('eph:')) {
                var array = service.name.split(":");
                if (array[1] == "devhi") {
                    log.info(service.name, service.txt);
                } else if (array[1] == 'devinfo') {
                    log.info(array[1], service.name, service.txt);
                }
                if (type.indexOf(array[1]) > -1) {
                    if ('info' in service.txt) {
                        service.txt.info = JSON.parse(service.txt.info);
                    }
                    callback(array[1], service.name, service.txt);
                }
            }
        });
    }
}

module.exports = intercomm;
