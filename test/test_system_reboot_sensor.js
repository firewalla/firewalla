/*    Copyright 2016-2024 Firewalla Inc.
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

let chai = require('chai');
const exec = require('child-process-promise').exec;
let expect = chai.expect;
const os = require('os');

const log = require('../net2/logger.js')(__filename);
const SystemRebootSensor = require('../sensor/SystemRebootSensor.js');

describe('Test internet speedtest', function(){
    this.timeout(3000);

    before((done) => {
      (async() =>{
        this.plugin = new SystemRebootSensor();
        done();
      })();
    });

    after((done) => {
      (async() =>{
        await exec("sudo touch /dev/shm/system_reboot.touch").catch((err) => {});
        done();
      })();
    });

    it('should not outage', async()=> {
        await this.plugin.setLastHeartbeatTime( Date.now() - os.uptime()*1000 - 1000);
        await exec("sudo rm -f /dev/shm/system_reboot.touch").catch((err) => {log.error("cannot rm reboot file,", err.message)});
        await this.plugin.checkReboot();
    });

    it('should outage', async()=> {
        await this.plugin.setLastHeartbeatTime( Date.now() - os.uptime()*1000 - 400000);
        await exec("sudo rm -f /dev/shm/system_reboot.touch").catch((err) => {log.error("cannot rm reboot file,", err.message)});
        await this.plugin.checkReboot();
    });

  });
