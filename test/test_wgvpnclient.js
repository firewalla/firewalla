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

const fs = require('fs');
let chai = require('chai');
let expect = chai.expect;

const WGVPNClient = require('../extension/vpnclient/WGVPNClient.js');
const exec = require('child-process-promise').exec;
const writeFileAsync = fs.promises.writeFile

const logContent = `Mar  6 11:09:06 localhost kernel: [89348.451922] wireguard: vpn_88f0_D4A50: Interface created
Mar  6 11:09:07 localhost kernel: [89348.726343] wireguard: vpn_88f0_D4A50: Peer 7 created
Mar  6 11:09:07 localhost kernel: [89348.726380] wireguard: vpn_88f0_D4A50: Sending keepalive packet to peer 7 (154.21.90.81:51820)
Mar  6 11:09:07 localhost kernel: [89348.726649] wireguard: vpn_88f0_D4A50: Sending handshake initiation to peer 7 (154.21.90.81:51820)
Mar  6 11:09:12 localhost kernel: [89353.833469] wireguard: vpn_88f0_D4A50: Handshake for peer 7 (154.21.90.81:51820) did not complete after 5 seconds, retrying (try 2)
Mar  6 11:09:38 localhost kernel: [89380.209124] wireguard: vpn_88f0_D4A50: Peer 7 (154.21.90.81:51820) destroyed
Mar  6 11:09:38 localhost kernel: [89380.233192] wireguard: vpn_88f0_D4A50: Interface destroyed
Mar  6 11:10:06 localhost kernel: [89348.451922] wireguard: vpn_88f0_D4A50: Interface created
Mar  6 11:10:07 localhost kernel: [89348.726343] wireguard: vpn_88f0_D4A50: Peer 7 created
Mar  6 11:10:07 localhost kernel: [89348.726380] wireguard: vpn_88f0_D4A50: Sending keepalive packet to peer 7 (154.21.90.81:51820)
Mar  6 11:10:07 localhost kernel: [89348.726649] wireguard: vpn_88f0_D4A50: Sending handshake initiation to peer 7 (154.21.90.81:51820)
Mar  6 11:10:12 localhost kernel: [89353.833469] wireguard: vpn_88f0_D4A50: Handshake for peer 7 (154.21.90.81:51820) did not complete after 5 seconds, retrying (try 2)
Mar  6 11:10:38 localhost kernel: [89380.209124] wireguard: vpn_88f0_D4A50: Peer 7 (154.21.90.81:51820) destroyed
Mar  6 11:10:38 localhost kernel: [89380.233192] wireguard: vpn_88f0_D4A50: Interface destroyed
Mar  6 11:22:06 localhost kernel: [89348.451922] wireguard: vpn_88f0_D4A50: Interface created
Mar  6 11:22:07 localhost kernel: [89348.726343] wireguard: vpn_88f0_D4A50: Peer 7 created
Mar  6 11:22:07 localhost kernel: [89348.726380] wireguard: vpn_88f0_D4A50: Sending keepalive packet to peer 7 (154.21.90.81:51820)
Mar  6 11:22:07 localhost kernel: [89348.726649] wireguard: vpn_88f0_D4A50: Sending handshake initiation to peer 7 (154.21.90.81:51820)
Mar  6 11:22:12 localhost kernel: [89353.833469] wireguard: vpn_88f0_D4A50: Handshake for peer 7 (154.21.90.81:51820) did not complete after 5 seconds, retrying (try 2)
Mar  6 11:22:38 localhost kernel: [89380.209124] wireguard: vpn_88f0_D4A50: Peer 7 (154.21.90.81:51820) destroyed
Mar  6 11:22:38 localhost kernel: [89380.233192] wireguard: vpn_88f0_D4A50: Interface destroyed
Mar  6 11:33:06 localhost kernel: [89348.451922] wireguard: vpn_88f0_D4A50: Interface created
Mar  6 11:33:07 localhost kernel: [89348.726343] wireguard: vpn_88f0_D4A50: Peer 7 created
Mar  6 11:33:07 localhost kernel: [89348.726380] wireguard: vpn_88f0_D4A50: Sending keepalive packet to peer 7 (154.21.90.81:51820)
Mar  6 11:33:07 localhost kernel: [89348.726649] wireguard: vpn_88f0_D4A50: Sending handshake initiation to peer 7 (154.21.90.81:51820)
Mar  6 11:33:12 localhost kernel: [89353.833469] wireguard: vpn_88f0_D4A50: Handshake for peer 7 (154.21.90.81:51820) did not complete after 5 seconds, retrying (try 2)
Mar  6 11:33:38 localhost kernel: [89380.209124] wireguard: vpn_88f0_D4A50: Peer 7 (154.21.90.81:51820) destroyed
Mar  6 11:33:38 localhost kernel: [89380.233192] wireguard: vpn_88f0_D4A50: Interface destroyed`;

describe('Test getSessionLog', function(){
  this.timeout(3000);

  beforeEach((done) => {
    (async() => {
      const profileId = `${Math.floor(Math.random()*1000)}`;
      await writeFileAsync(`./vpn_${profileId}.log`, logContent, 'utf8')

      this.wgclient =  new WGVPNClient({profileId});
      this.wgclient.logDir = ".";
      this.wgclient.profileId = profileId;
      done();
    })();
  });

  afterEach((done) => {
    (async() => {
      await exec(`rm -f ./vpn_${this.wgclient.profileId}.log`)
      done();
    })();
   });
  
  it('should get 3 session log', async() => {
    const lines = await this.wgclient.getLatestSessionLog();
    expect(lines.split("\n").length).to.equal(21);
  });
    
});

describe('Test _getLastNSession', function(){
  this.timeout(3000);

  beforeEach((done) => {
    done();
  })

  afterEach((done) => {
    done();
  });

  it('should get 1 session log', (done) => {
    const content = `Mar  6 11:33:12 localhost kernel: [89353.833469] wireguard: vpn_88f0_D4A50: Handshake for peer 7 (154.21.90.81:51820) did not complete after 5 seconds, retrying (try 2)
Mar  6 11:33:38 localhost kernel: [89380.209124] wireguard: vpn_88f0_D4A50: Peer 7 (154.21.90.81:51820) destroyed
Mar  6 11:33:38 localhost kernel: [89380.233192] wireguard: vpn_88f0_D4A50: Interface destroyed
Mar  6 11:33:06 localhost kernel: [89348.451922] wireguard: vpn_88f0_D4A50: Interface created
Mar  6 11:33:07 localhost kernel: [89348.726343] wireguard: vpn_88f0_D4A50: Peer 7 created
Mar  6 11:33:07 localhost kernel: [89348.726380] wireguard: vpn_88f0_D4A50: Sending keepalive packet to peer 7 (154.21.90.81:51820)
Mar  6 11:33:07 localhost kernel: [89348.726649] wireguard: vpn_88f0_D4A50: Sending handshake initiation to peer 7 (154.21.90.81:51820)
Mar  6 11:33:12 localhost kernel: [89353.833469] wireguard: vpn_88f0_D4A50: Handshake for peer 7 (154.21.90.81:51820) did not complete after 5 seconds, retrying (try 2)
Mar  6 11:33:38 localhost kernel: [89380.209124] wireguard: vpn_88f0_D4A50: Peer 7 (154.21.90.81:51820) destroyed
Mar  6 11:33:38 localhost kernel: [89380.233192] wireguard: vpn_88f0_D4A50: Interface destroyed`
    const logs = WGVPNClient._getLastNSession(content, "Interface created", 3);
    expect(logs.split("\n").length).to.equal(7);
    done();
  });

  it('should get last 9 lines (no match)', (done) => {
    const content = `Mar  6 11:33:12 localhost kernel: [89353.833469] wireguard: vpn_88f0_D4A50: Handshake for peer 7 (154.21.90.81:51820) did not complete after 5 seconds, retrying (try 2)
Mar  6 11:33:38 localhost kernel: [89380.209124] wireguard: vpn_88f0_D4A50: Peer 7 (154.21.90.81:51820) destroyed
Mar  6 11:33:38 localhost kernel: [89380.233192] wireguard: vpn_88f0_D4A50: Interface destroyed
Mar  6 11:33:07 localhost kernel: [89348.726343] wireguard: vpn_88f0_D4A50: Peer 7 created
Mar  6 11:33:07 localhost kernel: [89348.726380] wireguard: vpn_88f0_D4A50: Sending keepalive packet to peer 7 (154.21.90.81:51820)
Mar  6 11:33:07 localhost kernel: [89348.726649] wireguard: vpn_88f0_D4A50: Sending handshake initiation to peer 7 (154.21.90.81:51820)
Mar  6 11:33:12 localhost kernel: [89353.833469] wireguard: vpn_88f0_D4A50: Handshake for peer 7 (154.21.90.81:51820) did not complete after 5 seconds, retrying (try 2)
Mar  6 11:33:38 localhost kernel: [89380.209124] wireguard: vpn_88f0_D4A50: Peer 7 (154.21.90.81:51820) destroyed
Mar  6 11:33:38 localhost kernel: [89380.233192] wireguard: vpn_88f0_D4A50: Interface destroyed`
    const logs = WGVPNClient._getLastNSession(content, "Interface created", 3);
    expect(logs.split("\n").length).to.equal(9);
    done();
  });

  it('should get empty string)', (done) => {
    const logs = WGVPNClient._getLastNSession("", "Interface created", 3);
    expect(logs).to.equal('');
    done();
  });
});