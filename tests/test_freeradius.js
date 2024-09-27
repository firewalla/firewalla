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
    clients:[
        {name:"test1", ipaddr:"172.16.0.0/12", secret:"123", require_msg_auth:"yes"},
        {},
    ],
    users:[{username:"jack", passwd:"abc"}, {username:"tom", passwd:"ABC"}, {}],
}

const radiusConfig2 = {
    clients:[
        {name:"test1", ipaddr:"172.16.0.0/12", secret:"test123-3", require_msg_auth:"yes"},
        {name:"test2", ipaddr:"192.168.0.0/16", secret:"test123-3", require_msg_auth:"yes"},
    ],
    users:[{username:"jack", passwd:"hello"}, {username:"tom", passwd:"pass123"}],
}

describe('Test freeradius prepare container', function(){
    this.timeout(30000);

    beforeEach((done) => {
      (async() =>{
        await exec(`rm -rf ${f.getRuntimeInfoFolder()}/docker/freeradius.bak`).catch(e=>{});
        await exec(`mv ${f.getRuntimeInfoFolder()}/docker/freeradius ${f.getRuntimeInfoFolder()}/docker/freeradius.bak`).catch(e=>{});
        done();
      })();
    });

    afterEach((done) => {
      (async() => {
        await exec(`rm -rf ${f.getRuntimeInfoFolder()}/docker/freeradius`).catch(e=>{});
        await exec(`mv ${f.getRuntimeInfoFolder()}/docker/freeradius.bak ${f.getRuntimeInfoFolder()}/docker/freeradius`).catch(e=>{});
        done();
      })();
    });

    it('should prepare container', async () => {
        expect(await freeradius.prepareContainer({})).to.be.true;;
    });

    it('should prepare ssl', async () => {
        expect(await freeradius.prepareContainer({ssl: true})).to.be.true;;
    });
});

describe('Test freeradius prepare radius config files', function(){
    this.timeout(30000);

    beforeEach((done) => {
      (async() =>{
        await exec(`rm -rf ${f.getRuntimeInfoFolder()}/docker/freeradius.bak`).catch(e=>{});
        await exec(`mv ${f.getRuntimeInfoFolder()}/docker/freeradius ${f.getRuntimeInfoFolder()}/docker/freeradius.bak`).catch(e=>{});
        await freeradius.prepareContainer({ssl: true});
        log.debug('freeradius files:', await exec(`ls -lh ${f.getRuntimeInfoFolder()}/docker/freeradius`).then(r => r.stdout.trim()).catch(e=>{}));
        done();
      })();
    });

    afterEach((done) => {
      (async() => {
        await exec(`rm -rf ${f.getRuntimeInfoFolder()}/docker/freeradius`).catch(e=>{});
        await exec(`mv ${f.getRuntimeInfoFolder()}/docker/freeradius.bak ${f.getRuntimeInfoFolder()}/docker/freeradius`).catch(e=>{});
        done();
      })();
    });

    it('should replace template', async() => {
        expect(freeradius._replaceClientConfig({name:"test1", ipaddr:"172.16.0.0/12", secret:"123", require_msg_auth:"yes"})).to.equal(result1);
        expect(await freeradius._replaceUserConfig({username:"jack", passwd:"abc"})).to.equal(result2);
    });

    it('should generate config file', async () => {
        await freeradius._genClientsConfFile(radiusConfig.clients);
        expect(await fs.accessAsync(`${f.getRuntimeInfoFolder()}/docker/freeradius/clients.conf`, fs.constants.F_OK).then(() => true).catch((err) => false)).to.be.true;
        await freeradius._genUsersConfFile(radiusConfig.users);
        expect(await fs.accessAsync(`${f.getRuntimeInfoFolder()}/docker/freeradius/users`, fs.constants.F_OK).then(() => true).catch((err) => false)).to.be.true;
    });

    it('should prepare config', async() => {
        expect(await freeradius.prepareRadiusConfig(radiusConfig)).to.be.true;
        log.debug("===== clients.conf =====\n", await fs.readFileAsync(`${f.getRuntimeInfoFolder()}/docker/freeradius/clients.conf`, {encoding: "utf8"}).catch((err) => null));
        log.debug("===== users =====\n", await fs.readFileAsync(`${f.getRuntimeInfoFolder()}/docker/freeradius/users`, {encoding: "utf8"}).catch((err) => null));
    });

    it('should save/load passwd', async() => {
      await freeradius._genUsersConfFile([{username:"jack", passwd:"hello"}, {username:"tom", passwd:"pass123"}, {username: "test35"}]);
      await freeradius._loadPasswd();
      expect(freeradius._passwd["jack"]).to.be.equal("hello");
    });

});

describe.skip('Test freeradius service', function(){
    this.timeout(30000);

    beforeEach((done) => {
        (async() =>{
          await exec(`rm -rf ${f.getRuntimeInfoFolder()}/docker/freeradius.bak`).catch(e=>{});
          await exec(`mv ${f.getRuntimeInfoFolder()}/docker/freeradius ${f.getRuntimeInfoFolder()}/docker/freeradius.bak`).catch(e=>{});
          done();
        })();
      });

    afterEach((done) => {
        (async() => {
          await exec(`rm -rf ${f.getRuntimeInfoFolder()}/docker/freeradius`).catch(e=>{});
          await exec(`mv ${f.getRuntimeInfoFolder()}/docker/freeradius.bak ${f.getRuntimeInfoFolder()}/docker/freeradius`).catch(e=>{});
          done();
        })();
    });

    it('should start docker', async() => {
        expect(await freeradius.startDockerDaemon()).to.be.true;
    });

    it('should start radius container', async() => {
        await freeradius.startServer(radiusConfig);
        expect(freeradius.running).to.be.true;
        expect(await freeradius.isListening()).to.be.true;
    });

    it('should reconfigure radius container', async() => {
        await freeradius.reconfigServer(radiusConfig2, {});
        expect(await freeradius.isListening()).to.be.true;
    });

    it('should stop radius container', async() => {
        await freeradius.stopServer();
        expect(await freeradius.isListening()).to.be.false;
    });
});

describe('Test freeradius sensor', function(){
    this.timeout(1200000);
    this.plugin = new FreeRadiusSensor({});
    before((done) => {
      (async() =>{
          this.policy = await this.plugin.loadPolicyAsync();
          log.debug("current freeradius_server policy", this.policy);
          done();
      })();
    });

    after((done) => {
      (async() => {
          if (this.policy) {
            await rclient.hsetAsync('policy:system', 'freeradius_server', JSON.stringify(this.policy));
          }
          done();
      })();
    });

    it('should global on/off', async () => {
        await this.plugin.globalOn();
        expect(this.plugin.featureOn).to.be.true;

        await this.plugin.globalOff();
        expect(this.plugin.featureOn).to.be.false;
    });

    it('should get password', async() => {
      await this.plugin.loadPolicyAsync();
    });

    it('should apply policy', async() => {
        await this.plugin.applyPolicy("0.0.0.0", "", {radius:radiusConfig2});

        await this.plugin.globalOn();
        await this.plugin.applyPolicy("network:uuid", "", {radius:radiusConfig2});

        await this.plugin.applyPolicy("0.0.0.0", "", {radius:radiusConfig2, options:{ssl:true}});

        await this.plugin.applyPolicy("0.0.0.0", "", {radius:radiusConfig2, options:{ssl:true}});
    });
});
