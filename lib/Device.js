/* 
 * Device abstraction  
 *
 */

/*    Copyright 2019 Firewalla LLC 
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

var Sensor = require('./Sensor.js')

var debugging = false;
var log = function () {
    if (debugging) {
        console.log(Array.prototype.slice.call(arguments));
    }
};

module.exports = class {
    constructor(controller, deviceConfig, debug) {
        this.id = controller.id + '.' + deviceConfig.id;
        this.name = deviceConfig.name;
        this.type = deviceConfig.type;

        this.deviceConfig = deviceConfig;
        this.controller = controller;
        this.state = 'down';
        this.adminstate = 'down';
        this.sensordb = {};
        this.sensordbByType = {};

        debugging = debug;

        if (deviceConfig.sensors) {
            for (let i in deviceConfig.sensors) {
                let sensorConfig = deviceConfig.sensors[i];
                let sensor = new Sensor(this, sensorConfig, debug);
                this.addSensor(sensor);
            }
        }

        console.log("Initializeing Device ", this.name, this.type, this.id);
    }

    getSensor(type) {
        return this.sensordbByType[type];
    }

    addSensor(sensor) {
        if (this.sensordbByType[sensor.type] == null) {
            this.sensordbByType[sensor.type] = [sensor];
        } else {
            this.sensordbByType[sensor.type].push(sensor);
        }
        this.sensordb[sensor.id] = sensor;

        /*
        sensor.onChangeCallback = (s,oldvalue,timestamp)=> {
            this.onSensorChangeCallback(s,oldvalue,timestamp);
        }
        */
    }

    removeSensor(sensor) {}

    start() {
        this.adminstate = up;
    }

    stop() {
        this.adminstate = down;
    }

    discover(callback) {}

};
