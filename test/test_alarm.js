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
const am2 = new AlarmManager2();
const Alarm = require('../alarm/Alarm.js')


describe('Test localization', function(){
    this.timeout(30000);

    it('test customized security by msp', async() => {
        const alarm = am2._genAlarm({"p.event.ts":"1721710424.77783","p.device.ip":"192.168.3.124","p.msp.decision":"create","device":"20:6D:31:61:CC:24","type":"customized_security","p.dest.ip":"52.88.2.1","p.device.name":"Janie AP",
            "p.utag.names":[{"uid":"6","name":"Janie"}],"p.utag.ids":["6"],"p.dtag.names":[{"uid":"44","name":"desktop"}],"p.dtag.ids":["44"],"p.tag.ids":["7"],"alarmTimestamp":"1721710545.902","p.showMap":"false","timestamp":"1721710545.901",
            "p.device.mac":"20:6D:31:61:CC:24","p.description":"intel:alarm:20:6D:31:61:CC:24:fwdev.fake.io","p.dest.name":"fwdev.fake.io","aid":"24816","p.event.timestampTimezone":"12:53 PM","p.device.type":"Firewalla AP","p.dest.port":"443",
            "p.protocol":"tcp","p.device.id":"20:6D:31:61:CC:24","state":"active"});
        expect(alarm.localizedNotificationContentKey()).to.be.equal("notif.content.ALARM_CUSTOMIZED_SECURITY.user");
        expect(alarm.localizedNotificationContentArray()).to.be.eql(['Janie AP','fwdev.fake.io','12:53 PM','Janie']);
    });
});

const data = {"p.device.id":"A:BB:CC:DD:EE:FF","p.device.ip":"172.16.1.144","p.protocol":"tcp","p.dest.name":"www.nintendo.co.jp","p.dest.ip":"23.5.1.243","p.dest.id":"www.nintendo.co.jp",
  "p.dest.port":443,"p.intf.id":"0000000","p.dtag.ids":["1"],"p.device.mac":"A:BB:CC:DD:EE:FF", "p.dest.category":"games","p.dest.name.suffix":"nintendo.co.jp"}

describe('Test dedup keys', () => {
    it('test outbound domain suffix key', async() => {
        const gameAlarm = new Alarm.GameAlarm(Date.now()/1000, 'MacBook Air', 'support.nintendo.com', data);
        expect(gameAlarm.getDomainSuffixKey()).to.be.eql("p.dest.name.suffix")
    });

    it('test compare dedup keys', async() => {
      const gameAlarm = new Alarm.GameAlarm(Date.now()/1000, 'MacBook Air', 'support.nintendo.com', data);
      expect(gameAlarm.keysToCompareForDedup()).to.be.eql(["p.device.mac", "p.dest.name.suffix",  "p.intf.id", "p.utag.ids"]);
  });
});

describe('Test generation', () => {
   it('tests alarm dedup', () => {
     const payload = {
       'p.intf.id': '00000000',
       'p.dest.category': 'av',
       'p.dest.ip': '74.125.160.38',
       'p.device.ip': '192.168.1.144',
       'p.dest.port': '443',
       'p.device.mac': 'AA:BB:CC:DD:EE:FF',
       message: 'Reinhard MBP is watching video on googlevideo.com',
       'p.protocol': 'tcp',
       'p.dest.app.id': 'youtube',
       'p.dest.domain': 'googlevideo.com',
       'p.device.name': 'Reinhard MBP',
       'p.dest.id': 'googlevideo.com',
       'p.dest.app': 'YouTube',
       'p.dest.name': 'googlevideo.com',
       'p.device.id': 'AA:BB:CC:DD:EE:FF',
       'p.tag.ids': [ '4' ],
       'p.tag.names': [ { uid: '4', name: 'Reinhard’s Devices' } ],
       'p.utag.ids': [ '3' ],
       'p.utag.names': [ { uid: '3', name: 'Reinhard' } ],
       'p.dtag.ids': [ '8' ],
       'p.dtag.names': [ { uid: '8', name: 'desktop' } ],
     }
     const alarm1 = new Alarm.VideoAlarm(Date.now()/1000, 'Reinhard MBP', 'googlevideo.com', payload)

     payload['p.tag.ids'] = [ '5' ]
     const alarm2 = new Alarm.VideoAlarm(Date.now()/1000, 'Reinhard MBP', 'googlevideo.com', payload)

     expect(alarm1.isDup(alarm2)).to.be.true

     payload['p.utag.ids'] = [ '6' ]
     const alarm3 = new Alarm.VideoAlarm(Date.now()/1000, 'Reinhard MBP', 'googlevideo.com', payload)

     console.log(alarm1['p.utag.ids'])
     console.log(alarm3['p.utag.ids'])
     expect(alarm1.isDup(alarm3)).to.be.false
   })
})
