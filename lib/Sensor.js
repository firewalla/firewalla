/*    Copyright 2016 - 2019 Firewalla INC 
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

/* 
 * Base sensor class
 */

'use strict'

var debugging = false;
var log = function () {
    if (debugging) {
        console.log(Array.prototype.slice.call(arguments));
    }
};

module.exports = class {
    constructor(device, sensorConfig, debug) {
        this.name = sensorConfig.name;
        this.type = sensorConfig.type;
        if (device) {
            this.id = device.id + "." + sensorConfig.id;
        } else {
            this.id = sensorConfig.id;
        }
        this.sensorConfig = sensorConfig;
        this.private = sensorConfig.private;
        this.external = sensorConfig.external;
        if (this.external != null && this.sensorConfig.external != null && this.sensorConfig.external == 1) {
            this.gid = sensorConfig.gid;
            this.eid = sensorConfig.eid;
            this.timestamp = sensorConfig.timestamp;
        }
        debugging = debug;
        this.device = device;

        this.state = 'idle';
        if (sensorConfig.value === undefined) {
            this.value = 0;
        } else {
            this.value = sensorConfig.value;
        }
        this.unit = sensorConfig.unit;
        this.timestamp = 0;
        this.history = [];
        console.log('Initalize Sensor', this.type, this.name, this.id);
    }

    /* "idle", "activating", "active", and "errored" */

    json() {
        if (this.external == null) {
            return {
                'type': this.type,
                'id': this.id,
                'timestamp': this.timestamp,
                'value': this.value,
                'unit': this.unit,
                'name': this.name
            };
        } else {
            return {
                'gid': this.gid,
                'eid': this.eid,
                'type': this.type,
                'id': this.id,
                'timestamp': this.timestamp,
                'value': this.value,
                'unit': this.unit,
                'name': this.name
            };
        }
    }

    start() {}

    stop() {}
};
