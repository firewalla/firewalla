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
const { exec } = require('child-process-promise');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const FreeRadiusSensor = require("../sensor/FreeRadiusSensor.js")
const rclient = require('../util/redis_manager.js').getRedisClient();

process.title = "FireMain";
let freeradius = require("../extension/freeradius/freeradius.js");
const f = require('../net2/Firewalla.js');
const log = require('../net2/logger.js')(__filename);

const result1 = `
client test1 {
	ipaddr		= 172.16.0.0/12
	secret		= 123
	require_message_authenticator = yes
}
`
const result2 = `
jack	NT-Password := "e0fba38268d0ec66ef1cb452d5885e53"
       Reply-Message := "Hello, %{User-Name}"
`

const radiusConfig = {
  clients: [
    { name: "test1", ipaddr: "172.16.0.0/12", secret: "123", require_msg_auth: "yes" },
    {},
  ],
  users: [{ username: "jack", passwd: "e0fba38268d0ec66ef1cb452d5885e53", vlan: "11", tag: "admin" }, { username: "tom", passwd: "ABC", tag: "common" }, {}],
}

const radiusConfig2 = {
  clients: [
    { name: "test1", ipaddr: "172.16.0.0/12", secret: "test123-3", require_msg_auth: "yes" },
    { name: "test2", ipaddr: "192.168.0.0/16", secret: "test123-3", require_msg_auth: "yes" },
  ],
  users: [{ username: "jack", passwd: "hello", vlan: "12", tag: "admin" }, { username: "tom", passwd: "pass123", tag: "common" }],
}

describe('Test freeradius prepare container', function () {
  this.timeout(30000);

  beforeEach(async () => {
    await exec(`rm -rf ${f.getRuntimeInfoFolder()}/docker/freeradius.bak`).catch(e => { });
    await exec(`mv ${f.getRuntimeInfoFolder()}/docker/freeradius ${f.getRuntimeInfoFolder()}/docker/freeradius.bak`).catch(e => { });
    await exec(`mkdir -p ${f.getRuntimeInfoFolder()}/docker/freeradius/wpa3`).catch(e => { });
  });

  afterEach(async () => {
    await exec(`rm -rf ${f.getRuntimeInfoFolder()}/docker/freeradius`).catch(e => { });
    await exec(`mv ${f.getRuntimeInfoFolder()}/docker/freeradius.bak ${f.getRuntimeInfoFolder()}/docker/freeradius`).catch(e => { });
  });

  it('should prepare container', async () => {
    expect(await freeradius.prepareContainer({})).to.be.true;;
  });

  it('should prepare ssl', async () => {
    expect(await freeradius.prepareContainer({ ssl: true })).to.be.true;;
  });
});

describe('Test freeradius prepare radius config files', function () {
  this.timeout(30000);

  beforeEach(async () => {
    await exec(`rm -rf ${f.getRuntimeInfoFolder()}/docker/freeradius.bak`).catch(e => { });
    await exec(`mv ${f.getRuntimeInfoFolder()}/docker/freeradius ${f.getRuntimeInfoFolder()}/docker/freeradius.bak`).catch(e => { });
    await freeradius.prepareContainer({ ssl: true });

  });

  afterEach(async () => {
    await exec(`rm -rf ${f.getRuntimeInfoFolder()}/docker/freeradius`).catch(e => { });
    await exec(`mv ${f.getRuntimeInfoFolder()}/docker/freeradius.bak ${f.getRuntimeInfoFolder()}/docker/freeradius`).catch(e => { });
  });

  it('should replace template', () => {
    expect(freeradius._replaceClientConfig({ name: "test1", ipaddr: "172.16.0.0/12", secret: "123", require_msg_auth: "yes" })).to.equal(result1);
    expect(freeradius._replaceUserConfig({ username: "jack", passwd: "e0fba38268d0ec66ef1cb452d5885e53" })).to.equal(result2);
  });

  it('should replace user policy config correctly', () => {
    // Test case 1: User with vlan and tag
    const userConfig1 = {
      username: "testuser1",
      vlan: "11",
      tag: "admin"
    };
    const result1 = freeradius._replaceUserPolicyConfig(userConfig1);
    expect(result1).to.include('if (&User-Name == "testuser1")');
    expect(result1).to.include('if (1) {');
    expect(result1).to.include('Filter-Id := "admin"');
    expect(result1).to.include('Tunnel-Private-Group-ID := "11"');

    // Test case 2: User without vlan and tag
    const userConfig2 = {
      username: "testuser2"
    };
    const result2 = freeradius._replaceUserPolicyConfig(userConfig2);
    expect(result2).to.equals('');

    // Test case 3: User with vlan but no tag
    const userConfig3 = {
      username: "testuser3",
      vlan: "12"
    };
    const result3 = freeradius._replaceUserPolicyConfig(userConfig3);
    expect(result3).to.include('if (&User-Name == "testuser3")');
    expect(result3).to.include('if (1) {');
    expect(result3).to.include('Tunnel-Private-Group-ID := "12"');

    // Test case 4: User with tag but no vlan
    const userConfig4 = {
      username: "testuser4",
      tag: "common"
    };
    const result4 = freeradius._replaceUserPolicyConfig(userConfig4);
    expect(result4).to.include('if (&User-Name == "testuser4")');
    expect(result4).to.include('if (1) {');
    expect(result4).to.include('Filter-Id := "common"');

    // Test case 5: User with empty vlan and tag
    const userConfig5 = {
      username: "testuser5",
      vlan: "",
      tag: ""
    };
    const result5 = freeradius._replaceUserPolicyConfig(userConfig5);
    expect(result5).to.equals('');

    // Test case 6: User with null/undefined values
    const userConfig6 = {
      username: "testuser6",
      vlan: null,
      tag: undefined
    };
    const result6 = freeradius._replaceUserPolicyConfig(userConfig6);
    expect(result6).to.equals('');
  });

  it.skip('should handle invalid user config in _replaceUserPolicyConfig', async () => {
    // Test case 1: Missing username
    const invalidConfig1 = {
      vlan: "11",
      tag: "admin"
    };
    const result1 = freeradius._replaceUserPolicyConfig(invalidConfig1);
    expect(result1).to.equal("");

    // Test case 2: Empty username
    const invalidConfig2 = {
      username: "",
      vlan: "11",
      tag: "admin"
    };
    const result2 = freeradius._replaceUserPolicyConfig(invalidConfig2);
    expect(result2).to.equal("");

    // Test case 3: Null username
    const invalidConfig3 = {
      username: null,
      vlan: "11",
      tag: "admin"
    };
    const result3 = freeradius._replaceUserPolicyConfig(invalidConfig3);
    expect(result3).to.equal("");

    // Test case 4: Undefined username
    const invalidConfig4 = {
      username: undefined,
      vlan: "11",
      tag: "admin"
    };
    const result4 = freeradius._replaceUserPolicyConfig(invalidConfig4);
    expect(result4).to.equal("");
  });

  it('should generate user policy config file', async () => {
    const userConfig = [
      { username: "user1", vlan: "11", tag: "admin" },
      { username: "user2", tag: "common" },
      { username: "user3", vlan: "12" }
    ];

    try {
      await freeradius._genUserPolicyConfFile(userConfig);
    } catch (e) {
      log.error("failed to generate user policy config file", e.message);
    }

    log.debug('freeradius wpa3 files:', await exec(`ls -lh ${f.getRuntimeInfoFolder()}/docker/freeradius/wpa3`).then(r => r.stdout.trim()).catch(e => { }));

    expect(await fs.accessAsync(`${f.getRuntimeInfoFolder()}/docker/freeradius/wpa3/users-policy`, fs.constants.F_OK).then(() => true).catch((err) => {
      log.error("failed to access users-policy file", err.message);
      return false;
    })).to.be.true;

    const content = await fs.readFileAsync(`${f.getRuntimeInfoFolder()}/docker/freeradius/wpa3/users-policy`, { encoding: "utf8" });
    expect(content).to.include('if (&User-Name == "user1")');
    expect(content).to.include('Filter-Id := "admin"');
    expect(content).to.include('Tunnel-Private-Group-ID := "11"');
    expect(content).to.include('if (&User-Name == "user2")');
    expect(content).to.include('Filter-Id := "common"');
    expect(content).to.include('if (&User-Name == "user3")');
    expect(content).to.include('Tunnel-Private-Group-ID := "12"');
  });

  it('should generate config file', async () => {
    await freeradius._genClientsConfFile(radiusConfig.clients);
    expect(await fs.accessAsync(`${f.getRuntimeInfoFolder()}/docker/freeradius/clients.conf`, fs.constants.F_OK).then(() => true).catch((err) => false)).to.be.true;
    await freeradius._genUsersConfFile(radiusConfig.users);
    expect(await fs.accessAsync(`${f.getRuntimeInfoFolder()}/docker/freeradius/wpa3/users`, fs.constants.F_OK).then(() => true).catch((err) => false)).to.be.true;
    await freeradius._genUserPolicyConfFile(radiusConfig.users);
    expect(await fs.accessAsync(`${f.getRuntimeInfoFolder()}/docker/freeradius/wpa3/users-policy`, fs.constants.F_OK).then(() => true).catch((err) => false)).to.be.true;
  });

  it('should prepare config', async () => {
    expect(await freeradius.prepareRadiusConfig(radiusConfig)).to.be.true;
    log.debug("===== clients.conf =====\n", await fs.readFileAsync(`${f.getRuntimeInfoFolder()}/docker/freeradius/clients.conf`, { encoding: "utf8" }).catch((err) => null));
    log.debug("===== users =====\n", await fs.readFileAsync(`${f.getRuntimeInfoFolder()}/docker/freeradius/wpa3/users`, { encoding: "utf8" }).catch((err) => null));
    log.debug("===== users-policy =====\n", await fs.readFileAsync(`${f.getRuntimeInfoFolder()}/docker/freeradius/wpa3/users-policy`, { encoding: "utf8" }).catch((err) => null));
  });

});

describe.skip('Test freeradius service', function () {
  this.timeout(30000);

  beforeEach(async () => {
    await exec(`rm -rf ${f.getRuntimeInfoFolder()}/docker/freeradius.bak`).catch(e => { });
    await exec(`mv ${f.getRuntimeInfoFolder()}/docker/freeradius ${f.getRuntimeInfoFolder()}/docker/freeradius.bak`).catch(e => { });
    await exec(`mkdir -p ${f.getRuntimeInfoFolder()}/docker/freeradius/wpa3`).catch(e => { });
  });

  afterEach(async () => {
    await exec(`rm -rf ${f.getRuntimeInfoFolder()}/docker/freeradius`).catch(e => { });
    await exec(`mv ${f.getRuntimeInfoFolder()}/docker/freeradius.bak ${f.getRuntimeInfoFolder()}/docker/freeradius`).catch(e => { });
  });

  it('should start docker', async () => {
    expect(await freeradius.startDockerDaemon()).to.be.true;
  });

  it('should start radius container', async () => {
    await freeradius.startServer(radiusConfig);
    expect(freeradius.running).to.be.true;
    expect(await freeradius.isListening()).to.be.true;
  });

  it('should reconfigure radius container', async () => {
    await freeradius.reconfigServer(radiusConfig2, {});
    expect(await freeradius.isListening()).to.be.true;
  });

  it('should stop radius container', async () => {
    await freeradius.stopServer();
    expect(await freeradius.isListening()).to.be.false;
  });
});

describe('Test freeradius sensor', function () {
  this.timeout(1200000);
  this.plugin = new FreeRadiusSensor({});
  before(async () => {
    this.policy = await this.plugin.loadPolicyAsync();
    log.debug("current freeradius_server policy", this.policy);
  });

  after(async () => {
    if (this.policy) {
      await rclient.hsetAsync('policy:system', 'freeradius_server', JSON.stringify(this.policy));
    }
  });

  it('should global on/off', async () => {
    await this.plugin.globalOn();
    expect(this.plugin.featureOn).to.be.true;

    await this.plugin.globalOff();
    expect(this.plugin.featureOn).to.be.false;
  });

  it.skip('should apply policy', async () => {
    await this.plugin.applyPolicy("0.0.0.0", "", { radius: radiusConfig2 });

    await this.plugin.globalOn();
    await this.plugin.applyPolicy("network:uuid", "", { radius: radiusConfig2 });

    await this.plugin.applyPolicy("0.0.0.0", "", { radius: radiusConfig2, options: { ssl: true } });

    await this.plugin.applyPolicy("0.0.0.0", "", { radius: radiusConfig2, options: { ssl: true } });
  });
});
