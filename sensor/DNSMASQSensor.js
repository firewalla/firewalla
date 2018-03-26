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

let log = require('../net2/logger.js')(__filename);

let Sensor = require('./Sensor.js').Sensor;

let sem = require('../sensor/SensorEventManager.js').getInstance();

let bonjour = require('bonjour')();
let ip = require('ip');

let async = require('async');

let DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
let dnsmasq = new DNSMASQ();

let Promise = require('bluebird');

let Mode = require('../net2/Mode.js');

let flowControl = require('../util/FlowControl');

class DNSMASQSensor extends Sensor {
  constructor() {
    super();

    this.dhcpMode = false;
    this.dnsMode = false;
    this.registered = false;
  }

  _start() {
    return new Promise((resolve, reject) => {
      dnsmasq.install((err) => {
        if(err) {
          log.error("Fail to install dnsmasq: " + err);
          return;
        }

        // no force update
        dnsmasq.start(false, (err) => {
          if(!err) {
            log.info("dnsmasq service is started successfully");
            resolve();
          } else {
            log.error("Failed to start dnsmasq: " + err);
            reject(err);
          }
        })
      })
    });
  }

  _stop() {
    return new Promise((resolve, reject) => {
      dnsmasq.stop((err) => {
        if(!err) {
          log.info("dnsmasq service is stopped successfully");
          require('../util/delay.js').delay(1000)
          .then(() => {
            resolve();
          })
        } else {
          log.error("Failed to stop dnsmasq: " + err);
          reject(err);
        }
      })
    });
  }

  reload() {
    dnsmasq.needRestart = new Date() / 1000
    //return flowControl.reload(dnsmasq.reload, dnsmasq);
  }

  run() {
    sem.once('IPTABLES_READY', () => {
      this._run();
    })
  }

  _run() {
    // always start dnsmasq
    return Mode.getSetupMode()
      .then((mode) => {
        if(mode === "dhcp") {
          dnsmasq.setDHCPFlag(true);
        }

        return this._start()
          .then(() => {
            if(!this.registered) {
              sem.on("StartDNS", (event) => {
                // NO NEED TO RELOAD DNSMASQ if it's gone, it's going to be managed by systemctl
                // dnsmasq.checkStatus((status) => {
                //   if(!status) {
                //     this.reload();
                //   }
                // })
              });

              sem.on("StopDNS", (event) => {
                // ignore StopDNS, as now it will always start as daemon process
              });

              sem.on("StartDHCP", (event) => {
                log.info("Starting DHCP")
                dnsmasq.enableDHCP();
              });

              sem.on("StopDHCP", (event) => {
                dnsmasq.disableDHCP();
              });

              sem.on("ReloadDNSRule", (event) => {
                this.reload();
              });


              this.registered = true;
            }
          })
      })
  }
}

module.exports = DNSMASQSensor;
