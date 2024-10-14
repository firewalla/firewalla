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
let expect = chai.expect;

const AlarmManager2 = require('../alarm/AlarmManager2.js');
const { device } = require('../lib/Bone.js');
const rclient = require('../util/redis_manager.js').getRedisClient()
const delay = require('../util/util.js').delay;
const am2 = new AlarmManager2();


describe('Test localization', function(){
    this.timeout(30000);
  
    before((done) => {
      (
        async() => {
        }
      )();
      done();
    });
  
    after((done) => {
      (
        async() => {
        }
      )();
      done();
    });
  
    it('test customized security by msp', async() => {
        const alarm = am2._genAlarm({"p.event.ts":"1721710424.77783","p.device.ip":"192.168.3.124","p.msp.decision":"create","device":"20:6D:31:61:CC:24","type":"customized_security","p.dest.ip":"52.88.2.1","p.device.name":"Janie AP",
            "p.utag.names":[{"uid":"6","name":"Janie"}],"p.utag.ids":["6"],"p.dtag.names":[{"uid":"44","name":"desktop"}],"p.dtag.ids":["44"],"p.tag.ids":["7"],"alarmTimestamp":"1721710545.902","p.showMap":"false","timestamp":"1721710545.901",
            "p.device.mac":"20:6D:31:61:CC:24","p.description":"intel:alarm:20:6D:31:61:CC:24:fwdev.fake.io","p.dest.name":"fwdev.fake.io","aid":"24816","p.event.timestampTimezone":"12:53 PM","p.device.type":"Firewalla AP","p.dest.port":"443",
            "p.protocol":"tcp","p.device.id":"20:6D:31:61:CC:24","state":"active"});
        expect(alarm.localizedNotificationContentKey()).to.be.equal("notif.content.ALARM_CUSTOMIZED_SECURITY.user");
        expect(alarm.localizedNotificationContentArray()).to.be.eql(['Janie AP','fwdev.fake.io','12:53 PM','Janie']);
    });
});
