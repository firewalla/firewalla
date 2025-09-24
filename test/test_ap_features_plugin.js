/*    Copyright 2016-2025 Firewalla Inc.
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

const APFeaturesPlugin = require('../sensor/APFeaturesPlugin.js');
const log = require('../net2/logger.js')(__filename);
const exec = require('child-process-promise').exec;

describe('Test apc block message', function(){
    this.timeout(30000);

    before(async() => {
      this.plugin = new APFeaturesPlugin({});
      await this.plugin._aclIptables("-D");
    });

    after(async () => {
      await this.plugin._aclIptables("-D");
    });

    it('should set ap acl', () => {
      const config = {"interface":{},"dhcp":{},"version":1,"ts":1546675029100,"ncid":"xx","apc":{"assets":{"00":{"uid":"00","ip":"192.168.1.2","sysConfig":{}}}}};
      let changed = this.plugin._setApAcl(config, true);
      expect(config.apc.assets["00"].sysConfig.disableAcl).to.be.equal(true);
      expect(changed).to.be.equal(true);

      changed = this.plugin._setApAcl(config, true);
      expect(config.apc.assets["00"].sysConfig.disableAcl).to.be.equal(true);
      expect(changed).to.be.equal(false);

      changed = this.plugin._setApAcl(config, false);
      expect(config.apc.assets["00"].sysConfig.disableAcl).to.be.equal(false);
      expect(changed).to.be.equal(true);
    });

    it.skip('should set firewalla acl', async () => {
      await this.plugin._aclIptables("-I");
      const output = await exec(`sudo ip6tables -L | grep "ap acl off" | wc -l`);
      expect(Number(output.stdout.trim())).to.be.equal(4);
      await this.plugin._aclIptables("-D");
    });

  });
