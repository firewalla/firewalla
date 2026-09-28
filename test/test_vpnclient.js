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

let log = require('../net2/logger.js')(__filename, 'info');

const VPNClient = require('../extension/vpnclient/VPNClient.js');
const OpenVPNClient = require('../extension/vpnclient/OpenVPNClient.js');
const WGVPNClient = require('../extension/vpnclient/WGVPNClient.js');
const OCDockerClient = require('../extension/vpnclient/docker/OCDockerClient.js');

describe('Test vpnClient getAttributes', function(){
    this.timeout(30000);

    beforeEach((done) => {
      done();
    });
  
    afterEach((done) => {
      done();
    });

    it('should get openvpn attrs', async()=> {
        const profileIds = await OpenVPNClient.listProfileIds();
        for (const profileId of profileIds) {
          const attrs = await new OpenVPNClient({ profileId }).getAttributes()
          log.debug(`profile ${profileId}:`, attrs)
          expect(attrs.dnsServers).to.not.be.null;
        }
    });

    it('should get wgvpn attrs', async()=> {
        const profileIds = await WGVPNClient.listProfileIds();
        for (const profileId of profileIds) {
          const attrs = await new WGVPNClient({ profileId }).getAttributes()
          log.debug(`profile ${profileId}:`, attrs)
          expect(attrs.dnsServers).to.not.be.null;
        }
    });

    it('should get sslvpn attrs', async()=> {
        const profileIds = await OCDockerClient.listProfileIds();
        for (const profileId of profileIds) {
          const attrs = await new OCDockerClient({ profileId }).getAttributes()
          log.debug(`profile ${profileId}:`, attrs)
          expect(attrs.dnsServers).to.not.be.null;
        }
    });

  });

  describe('Test vpnClient getAttributes', function(){
    this.timeout(30000);

    it('should run ping test', async()=> {
      const profileIds = await WGVPNClient.listProfileIds();
      for (const profileId of profileIds) {
        const client = new WGVPNClient({ profileId });
        const attrs = await client.getAttributes();
        if (!attrs.status) {
          continue
        }
        for (const target of attrs.dnsServers){
          log.debug("pingTest", await client._runPingTest(target));
        }
      }
    });

    it('should run _isInternetAvailable', async() => {
      const profileIds = await WGVPNClient.listProfileIds();
      for (const profileId of profileIds) {
        const client = new WGVPNClient({ profileId });
        const attrs = await client.getAttributes();
        if (!attrs.status) {
          continue
        }
        client._started = true;
        await client._isInternetAvailable();
      }

    })
  });

describe('Test vpnClient connectivity state cache race', function() {
  this.timeout(3000);

  it('should not overwrite stopped client cached state with stale true result', async() => {
    const client = Object.create(VPNClient.prototype);
    client.profileId = `test_${Date.now()}`;
    client.settings = { overrideDefaultRoute: false };
    client._started = true;
    client._restarting = false;
    client._lastStartTime = null;

    const cachedStates = [];
    client._setCachedState = async(state) => cachedStates.push(state);

    let releaseLinkCheck;
    const linkCheckStarted = new Promise((resolve) => {
      client._isLinkUp = async() => {
        resolve();
        await new Promise((release) => {
          releaseLinkCheck = release;
        });
        return true;
      };
    });

    const checkPromise = client._checkConnectivity();
    await linkCheckStarted;

    client._started = false;
    releaseLinkCheck();
    await checkPromise;

    expect(cachedStates).to.eql([false]);
  });
});
