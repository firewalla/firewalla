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
let should = chai.should;
let expect = chai.expect;
let assert = chai.assert;


let sysInfo = require('../extension/sysinfo/SysInfo.js');

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}

describe.skip('SysInfo', () => {

  describe('.getSysInfo', () => {

    it('should return the right sys infos', (done) => {

      (async() =>{
        sysInfo.startUpdating();
        await delay(1000);
        let info = await sysInfo.getSysInfo();
        let threadInfo = info.threadInfo;
        expect(threadInfo.count).to.below(400);
        expect(threadInfo.mainCount).to.below(20);
        expect(threadInfo.monitorCount).to.below(20);
        expect(threadInfo.apiCount).to.below(20);
        //expect(info.releaseType).to.equal('dev');
        done();
      })();
    })

  });

});
