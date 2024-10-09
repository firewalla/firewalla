/*    Copyright 2020 Firewalla Inc.
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

'use strict';

const crypto = require('crypto');
const exec = require('child-process-promise').exec;
const _ = require('lodash');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const cipher = require('./_cipher.js');
var key = require('../common/key.js');
const f = require('../../net2/Firewalla.js');
const log = require('../../net2/logger.js')(__filename);
const util = require('../../util/util.js');

const dockerDir = `${f.getRuntimeInfoFolder()}/docker/freeradius`

let instance = null;

const TEMP_CLIENT_NETWORK = `
client %NAME% {
	ipaddr		= %IPADDR%
	secret		= %SECRET%
	require_message_authenticator = %REQUIRE_MSG_AUTH%
}
`

const TEMP_USER = `
%USERNAME%	NT-Password := "%PASSWD%"
	Reply-Message := "Hello, %{User-Name}"
`

class FreeRadius {
  constructor(config) {
    if(instance === null) {
      instance = this;
      this.config = config || {};
      this.running = false;
      this.watcher = null;

      // TODO: persistent encrypt and save passwords
      this._passwd = {};
      this._cfile = `${dockerDir}/../../.freeradius.pass`
      this._loadPasswd();
    }
    return instance;
  }

  async _savePasswd() {
    await cipher.encrypt(JSON.stringify(this._passwd), this._cfile);
  }

  async _loadPasswd() {
    const plain = await cipher.decrypt(this._cfile);
    if (plain) {
      try {
        this._passwd = JSON.parse(plain);
      } catch (err) {
        log.warn("parse passwd error, invalid format");
      }
    }
  }

  async _cleanPasswd(users) {
    for (const key in this._passwd) {
      if (users.indexOf(key) == -1 ) delete this._passwd[key];
    }
  }

  getPass(username) {
    return this._passwd[username];
  }

  async prepare() {
    await this.watchContainer();
    this.startDockerDaemon();
  }

  async watchContainer(interval){
    if (this.watcher) {
      clearInterval(this.watcher);
    }
    await exec("netstat -an  | egrep -q ':1812'").then(() => {this.running = true}).catch((err) => {this.running = false});
    this.watcher = setInterval( () => {
      exec("netstat -an  | egrep -q ':1812'").then(() => {this.running = true}).catch((err) => {this.running = false});
    }, interval * 1000 || 60000); // every 60s by default
  }

  // prepare config directory
  async prepareContainer(options={}) {
    try {
      await exec(`rm -rf ${dockerDir}`);
      await exec(`mkdir -p ${dockerDir}`);
      await exec(`touch ${f.getUserHome()}/.forever/radius.log`).catch(err=>null); // systemd permission required
      await exec(`cp ${__dirname}/docker-compose${options.ssl ? '.ssl' : ''}.yml ${dockerDir}/docker-compose.yml`);
      await exec(`cp ${__dirname}/raddb/eap ${dockerDir}/`);
      if (options.ssl) {
        await exec(`cp ${__dirname}/raddb/ca.cnf ${dockerDir}/`);
        await exec(`bash ${__dirname}/genssl.sh`);
      }
      return true;
    } catch(err) {
      log.warn("cannot prepare freeradius-server environment,", err.message);
    }
  }

  static rand(size = 8) {
    return Math.random().toString(36).substring(size);
  }

  _replaceClientConfig(clientConfig) {
    if (!clientConfig.ipaddr) {
      log.warn("invalid freeradius client config ipaddr", clientConfig);
      return "";
    }
    let content = TEMP_CLIENT_NETWORK.replace(/%NAME%/g, clientConfig.name || "nw_" + FreeRadius.rand());
    content = content.replace(/%IPADDR%/g, clientConfig.ipaddr);
    content = content.replace(/%SECRET%/g, clientConfig.secret || key.randomPassword(10));
    content = content.replace(/%REQUIRE_MSG_AUTH%/g, clientConfig.require_msg_auth || "auto");
    return content;
  }

  async _replaceUserConfig(userConfig) {
    if (!userConfig.username) {
      log.warn("invalid freeradius config username", userConfig);
      return "";
    }
    let content = TEMP_USER.replace(/%USERNAME%/g, userConfig.username);
    if (userConfig.passwd === "") { // empty string
      userConfig.passwd = key.randomPassword(10);
    } else if (!userConfig.passwd) {
      if (this._passwd[userConfig.username]) {
        userConfig.passwd = this._passwd[userConfig.username];
      } else {
        userConfig.passwd = key.randomPassword(10); // new user generate random pass
      }
    }

    const sslver = await exec(`openssl version | awk -F" " '{print $2}'`).then(r=>r.stdout.trim()).catch( (err) => {
      log.error("Failed to get openssl version", err.message);
      return "";
    });
    const legacy = sslver.match(/^1\./) ? "" : "-provider legacy";
    userConfig.hash = await exec(`echo -n "${userConfig.passwd}" | iconv -f ASCII -t utf16le | openssl md4 ${legacy} | cut -d ' ' -f2`).then(r=>r.stdout.trim()).catch( (err) => {
      log.error("Failed to generate ntlm hash", err.message);
      return "";
    });
    this._passwd[userConfig.username] = userConfig.passwd;
    await this._savePasswd();
    content = content.replace(/%PASSWD%/g, userConfig.hash);

    return content;
  }

  async _genClientsConfFile(clientConfig) {
    const clientConf = [];
    for (const client of clientConfig) {
      clientConf.push(this._replaceClientConfig(client));
    }
    const clientConfigStr = clientConf.join("\n");
    const content = await fs.readFileAsync(`${__dirname}/raddb/clients.conf.tmplt`, {encoding: "utf8"}).catch((err) => null);
    if (!content) {
      return;
    }
    await fs.writeFileAsync(`${dockerDir}/clients.conf`, content.replace(/%CLIENT_NETWORK_LIST%/g, clientConfigStr));
  }

  async _genUsersConfFile(usersConfig) {
    const userConf = [];
    this._cleanPasswd(usersConfig.map(i => i.username));
    for (const user of usersConfig) {
      userConf.push(await this._replaceUserConfig(user));
    }
    const usersConfStr = userConf.join("\n");
    const content = await fs.readFileAsync(`${__dirname}/raddb/users.tmplt`, {encoding: "utf8"}).catch((err) => null);
    if (!content) {
      return;
    }
    await fs.writeFileAsync(`${dockerDir}/users`, content.replace(/%RADDB_USERS%/g, usersConfStr));
  }

  async prepareRadiusConfig(config) {
    try {
      await this._loadPasswd();
      await this._genClientsConfFile(config.clients);
      if (!await fs.accessAsync(`${dockerDir}/clients.conf`, fs.constants.F_OK).then(() => true).catch((err) => false)){
        log.warn("Failed to generate clients.conf");
        return;
      }
      await this._genUsersConfFile(config.users);
      if (!await fs.accessAsync(`${dockerDir}/users`, fs.constants.F_OK).then(() => true).catch((err) => false)){
        log.warn("Failed to generate users");
        return;
      }
      return true;
    } catch(err) {
      log.warn("cannot prepare freeradius-server config", err.message);
    }
    return
  }

  async startDockerDaemon() {
    let dockerRunning = false;
    if (await exec(`sudo systemctl -q is-active docker`).then(() => true).catch((err) => false)) {
      dockerRunning = true;
      return true;
    }
    log.info("Starting docker service...")
    const watcher = setInterval( () => {
      exec(`sudo systemctl -q is-active docker`).then(() => {dockerRunning = true}).catch((err) => {dockerRunning = false});
    }, 10000);
    await exec(`sudo systemctl start docker`).catch((err) => {});
    await util.waitFor( _ => dockerRunning === true , 30000).then(() => true).catch((err) => false);
    clearInterval(watcher);
    return dockerRunning
  }

  async startServer(radiusConfig, options={}) {
    this.watchContainer(5);
    await this._startServer(radiusConfig, options);
    this.watchContainer(60);
  }

  async _startServer(radiusConfig, options={}) {
    if (!radiusConfig) {
      log.warn("Abort starting radius-server, radius config must be specified.")
      return
    }
    if (this.running) {
      log.warn("Abort starting radius-server, server is already running.")
      return;
    }
    log.info("Starting container freeradius-server...");
    try {
      if (!await this.prepareContainer(options)) {
        log.warn("abort starting radius-server, fail to prepare environment");
        return;
      }
      if (!await this.prepareRadiusConfig(radiusConfig)) {
        log.warn("abort starting radius-server, configuration not ready");
        return;
      }
      await this._start();
      await util.waitFor(  _ => this.running === true, options.timeout * 1000 || 30000).catch((err) => {});
      if (!this.running) {
        log.warn("Container freeradius-server is not started.")
      }
    } catch (err) {
      log.warn("Failed to start radius-server,", err.message);
    }
  }

  async _start() {
    if (!await this.startDockerDaemon()) {
      log.error("Docker daemon is not running.");
      return;
    }
    await exec("sudo systemctl start docker-compose@freeradius").catch((e) => {
      log.warn("cannot start freeradius,", e.message)
    });
  }

  async stopServer(options={}) {
    this.watchContainer(5);
    await this._stopServer(options);
    this.watchContainer(60);
  }

  async _stopServer(options={}) {
    try {
      log.info("Stopping container freeradius-server...");
      await exec("sudo systemctl stop docker-compose@freeradius").catch((e) => {
        log.warn("cannot stop freeradius,", e.message)
      });
      await util.waitFor(  _ => this.running === false, options.timeout*1000 || 30000).catch((err) => {});
      if (this.running) {
        log.warn("Container freeradius-server is not stopped.")
      }
    } catch (err) {
      log.warn("Failed to stop radius-server,", err.message);
    }
  }

  async reconfigServer(radiusConfig, options={}) {
    this.watchContainer(5);
    await this._stopServer(options);
    await this._startServer(radiusConfig, options);
    this.watchContainer(60);
  }

  // radius listens on 1812-1813
  async isListening() {
    return await exec("netstat -an | egrep -q ':1812'").then(() => true).catch((err) => false);
  }

  getStatus() {
    return {running: this.running};
  }

}

module.exports = new FreeRadius();
