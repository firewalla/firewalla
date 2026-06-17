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
const { exec } = require('child-process-promise');
const fs = require('fs').promises;
const FreeRadiusSensor = require("../sensor/FreeRadiusSensor.js")
const rclient = require('../util/redis_manager.js').getRedisClient();

let freeradius = require("../extension/freeradius/freeradius.js");
const f = require('../net2/Firewalla.js');

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

describe.skip('Test freeradius service', function () {
  this.timeout(30000);

  before(async () => {
    await exec(`rm -rf ${f.getRuntimeInfoFolder()}/docker/freeradius.bak`).catch(e => { });
    await exec(`mv ${f.getRuntimeInfoFolder()}/docker/freeradius ${f.getRuntimeInfoFolder()}/docker/freeradius.bak`).catch(e => { });
    await exec(`mkdir -p ${f.getRuntimeInfoFolder()}/docker/freeradius/wpa3`).catch(e => { });
  });

  after(async () => {
    await exec(`rm -rf ${f.getRuntimeInfoFolder()}/docker/freeradius`).catch(e => { });
    await exec(`mv ${f.getRuntimeInfoFolder()}/docker/freeradius.bak ${f.getRuntimeInfoFolder()}/docker/freeradius`).catch(e => { });
  });

  it('should prepare radius image', async () => {
    await freeradius.prepareImage();
  });

  it('should check radius image', async () => {
    await freeradius._checkImage();
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

  it('should terminate radius container', async () => {
    freeradius.watchContainer(5);
    await freeradius._terminateServer();
    expect(await freeradius.isListening()).to.be.false;
  });

  it('should stop radius container', async () => {
    await freeradius.stopServer();
    expect(await freeradius.isListening()).to.be.false;
  });

  it('should check radius container', async () => {
    await freeradius._checkContainer();
  });

  it('should start radius container', async () => {
    await freeradius.startServer(radiusConfig);
    expect(freeradius.running).to.be.true;
    expect(await freeradius.isListening()).to.be.true;
  });

});


describe('Test freeradius certs', function () {
  this.timeout(30000);

  const rootCAContent = `-----BEGIN CERTIFICATE-----
MIICBDCCAYqgAwIBAgIUJMNsSGxaSSyIQn/yxx+ydIBuXBUwCgYIKoZIzj0EAwMw
OTELMAkGA1UEBhMCVVMxEjAQBgNVBAoMCUZpcmV3YWxsYTEWMBQGA1UEAwwNZmly
ZXdhbGxhLmNvbTAeFw0yNjAzMzAxMTEzMTRaFw0zNjAzMjcxMTEzMTRaMDkxCzAJ
BgNVBAYTAlVTMRIwEAYDVQQKDAlGaXJld2FsbGExFjAUBgNVBAMMDWZpcmV3YWxs
YS5jb20wdjAQBgcqhkjOPQIBBgUrgQQAIgNiAARnzF1oSBI73iHD1rdb3BzCrHH6
V6wXReJGyPJLvzwND00Mj8zS0UZkdqldj87UbuCTGbmTa+gteMskfOlP+SaNj47d
Ax/HSp+Uof0c/5mgO1MRld2u45JKrPI2NYp+5dyjUzBRMB0GA1UdDgQWBBSMyIKW
UOYGsg9gLbiZYBXYFxjO8jAfBgNVHSMEGDAWgBSMyIKWUOYGsg9gLbiZYBXYFxjO
8jAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMDA2gAMGUCMQDFPhfJdreja4VV
MwtVchXFnSnaZE6byk1BywJf1bPLIOQivGjLSYbCxiSzCNyYbKECMC2vCt+yEM3T
VQ8t5UrTtcxrQsyChRdw2JHwv59rpHoLZk69QpVzE31/MrhL6aXJfQ==
-----END CERTIFICATE-----`;

  const serverKeyContent = `-----BEGIN EC PARAMETERS-----
BgUrgQQAIg==
-----END EC PARAMETERS-----
-----BEGIN EC PRIVATE KEY-----
MIGkAgEBBDCBxdKvSeH3NXly5lPX2IvtK6/L750sOjnfs13WmU+RhLavqgTsDxCa
XxhXCAvl5xKgBwYFK4EEACKhZANiAAQEEqOEZMSScKE7hIF7MMpROapzBzAbf5PF
95L1Fvi7OvDple0Vj4G8E6aTQtxRmBOr6cI1z1kN/V2o+ld1bbGTNq58qZmaavog
zXAYexS5gYC6EvYCp/9iuKMENAln/qI=
-----END EC PRIVATE KEY-----`;

  const serverCAContent = `-----BEGIN CERTIFICATE-----
MIIB8jCCAXigAwIBAgIUQ4zlSijSWbhjNaX2UyzvObTsy2MwCgYIKoZIzj0EAwMw
OTELMAkGA1UEBhMCVVMxEjAQBgNVBAoMCUZpcmV3YWxsYTEWMBQGA1UEAwwNZmly
ZXdhbGxhLmNvbTAeFw0yNjAzMzAxMTE0MTdaFw0yNzAzMzAxMTE0MTdaMHwxCzAJ
BgNVBAYTAlVTMQswCQYDVQQIDAJDQTERMA8GA1UEBwwIU2FuIEpvc2UxEjAQBgNV
BAoMCUZpcmV3YWxsYTEhMB8GCSqGSIb3DQEJARYSaGVscEBmaXJld2FsbGEuY29t
MRYwFAYDVQQDDA1maXJld2FsbGEuY29tMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE
BBKjhGTEknChO4SBezDKUTmqcwcwG3+TxfeS9Rb4uzrw6ZXtFY+BvBOmk0LcUZgT
q+nCNc9ZDf1dqPpXdW2xkzaufKmZmmr6IM1wGHsUuYGAuhL2Aqf/YrijBDQJZ/6i
MAoGCCqGSM49BAMDA2gAMGUCMH2gNCEsj7BtOG1NU4m4JIYIdnn4uPvq0g55iJIR
YPlf5Ic3nsUheRIFyCciXv2pWwIxAPMTGdKBdN4ktB3Z1CjE/JEPglomiSmEjZfq
vb8caklM8vVkoVYLXmgox/ZyXZhndg==
-----END CERTIFICATE-----`;

  before(async () => {
    await exec(`mkdir -p /tmp/certs`).catch(e => { });
  });

  after(async () => {
    await exec(`rm -rf /tmp/certs`).catch(e => { });
  });


  it('should save certs', async () => {
    const certs = await freeradius._saveCerts({
      ca: rootCAContent,
      serverCA: serverCAContent,
      serverKey: serverKeyContent,
      keypass: "test",
    }, "/tmp/certs");
    expect(certs).to.be.true;
  });

  it('should verify certs', async () => {
    const verified = await freeradius._verifyCerts("/tmp/certs");
    expect(verified).to.be.true;
  });

  it('should get certs', async () => {
    const certs = await freeradius._getCerts("/tmp/certs");
    expect(certs).to.not.be.null;
    expect(certs.keypass).to.be.equal("test");
    expect(certs.ca).to.be.equal(rootCAContent);
    expect(certs.serverCA).to.be.equal(serverCAContent);
    expect(certs.serverKey).to.be.equal(serverKeyContent);
    expect(certs.hash).to.be.equal("9942234dd0fe31771218eb2286fa384739d7187adfb0a4937ebf580dcb0dac57");
  });

});

describe('Test freeradius sensor', function () {
  this.timeout(1200000);
  this.plugin = new FreeRadiusSensor({});
  before(async () => {
    this.policy = await this.plugin.loadPolicyAsync();
    // log.debug("current freeradius_server policy", this.policy);
  });

  after(async () => {
    if (this.policy && this.policy["0.0.0.0"]) {
      await rclient.hsetAsync('policy:system', 'freeradius_server', JSON.stringify(this.policy["0.0.0.0"]));
    }
  });

  it('should global on/off', async () => {
    await this.plugin.globalOn();
    expect(this.plugin.featureOn).to.be.true;
    expect(this.plugin._options).to.not.be.null;
    expect(this.plugin._policy).to.not.be.null;

    await this.plugin.globalOff();
    expect(this.plugin.featureOn).to.be.false;
  });

  it('should generate config', async () => {
    await rclient.hsetAsync('policy:system', 'freeradius_server', JSON.stringify({ radius: radiusConfig2 }));
    await freeradius.generateRadiusConfig();
    const policy = await this.plugin.loadPolicyAsync();
    expect(policy["0.0.0.0"]).to.be.deep.equal({ radius: radiusConfig2 });
  });

  it('should generateOptions', async () => {
    await this.plugin.generateOptions({ ssl: true, debug: true, timeout: 10 });
    const options = await fs.promises.readFile(`${f.getHiddenFolder()}/config/freeradius/.freerc`, { encoding: "utf8" });
    expect(options).to.contains("ssl=true");
    expect(options).to.contains("debug=true");
    expect(options).to.contains("timeout=10");
  });

  it('should revert', async () => {
    await this.plugin.globalOn();
    await this.plugin.revertPolicy();
  });

  it.skip('should apply policy', async () => {
    await this.plugin.applyPolicy("0.0.0.0", "", { radius: radiusConfig2 });

    await this.plugin.globalOn();
    await this.plugin.applyPolicy("network:uuid", "", { radius: radiusConfig2 });

    await this.plugin.applyPolicy("0.0.0.0", "", { radius: radiusConfig2, options: { ssl: true } });

    await this.plugin.applyPolicy("0.0.0.0", "", { radius: radiusConfig2, options: { ssl: true } });
  });
});
