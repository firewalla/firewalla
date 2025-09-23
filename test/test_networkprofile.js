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
const _ = require('lodash');
let expect = chai.expect;

const sysManager = require('../net2/SysManager.js');
const log = require('../net2/logger.js')(__filename);
const fireRouter = require('../net2/FireRouter.js');
const networkProfielManager = require('../net2/NetworkProfileManager.js');


describe('test networkProfile', function(){
    this.timeout(30000);

    before(async() => {
        sysManager.iptablesReady = true;
        await fireRouter.init();
        await sysManager.updateAsync();
    });

    after(async() => {
    });

    it('should refresh network profiles', async() => {
        await networkProfielManager.refreshNetworkProfiles();
        const profiles = networkProfielManager.networkProfiles;
        const eth0 = Object.values(profiles).filter(i => i.o.intf == "eth0");
        const br0 = Object.values(profiles).filter(i => i.o.intf == "br0");
        log.debug("network profile eth0", eth0.o && eth0.o.origDns6);
        log.debug("network profile br0", br0.o && br0.o.origDns);
        expect(eth0).to.be.not.empty
        expect(br0).to.be.not.empty
    });
  });
