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
const yaml = require('../../api/dist/lib/js-yaml.min.js');

const dockerDir = `${f.getRuntimeInfoFolder()}/docker/freeradius`

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let instance = null;

const TEMP_CLIENT_NETWORK = `
client %NAME% {
	ipaddr		= %IPADDR%
	secret		= %SECRET%
	require_message_authenticator = %REQUIRE_MSG_AUTH%
}
`

/*
https://www.rfc-editor.org/rfc/rfc3580.html

Tunnel-Type=VLAN (13)
Tunnel-Medium-Type=802 (6)
Tunnel-Private-Group-ID=VLANID

e.g.
testuser  NT-Password := "******"
    Tunnel-Type = 13,
    Tunnel-Medium-Type = 6,
    Tunnel-Private-Group-Id = "2",
    Reply-Message := "Hello, %{User-Name}"
*/
const TEMP_USER = `
%USERNAME%	NT-Password := "%PASSWD%"
       Reply-Message := "Hello, %{User-Name}"
`

const TEMP_USER_POLICY = `
if (&User-Name == "%USERNAME%") {
    # If it matches, add a "tag" to the reply packet.
    update reply {
        # Filter-Id is often used to assign a user/device to a
        # pre-defined group or policy on the NAS.

        Reply-Message := "Hello, %{User-Name}. Device %{Calling-Station-ID} is connected to %{Called-Station-ID}."
    }

    if (%USER_TAG%) {
        update reply {
            Filter-Id := "%USER_TAG_VALUE%"
        }
    }

    if (%USER_VLAN%) {
        update reply {
            Tunnel-Type := 13
            Tunnel-Medium-Type := 6
            Tunnel-Private-Group-ID := "%USER_VLAN_ID%"
        }
    }
}

`

class FreeRadius {
  constructor(config) {
    if (instance === null) {
      instance = this;
      this.config = config || {};
      this.running = false;
      this.watcher = null;
      this.pid = null;
    }
    return instance;
  }

  async prepare() {
    await this.watchContainer();
    this.startDockerDaemon();
  }

  async _watchStatus() {
    await exec("netstat -an  | egrep -q ':1812'").then(() => { this.running = true }).catch((err) => { this.running = false });
  }

  async watchContainer(interval) {
    if (this.watcher) {
      clearInterval(this.watcher);
    }
    await exec("netstat -an  | egrep -q ':1812'").then(() => { this.running = true }).catch((err) => { this.running = false });
    this.watcher = setInterval(() => {
      exec("netstat -an  | egrep -q ':1812'").then(() => { this.running = true }).catch((err) => { this.running = false });
    }, interval * 1000 || 60000); // every 60s by default
  }

  async generateComposeConfig(options = {}) {
    try {
      const templateFile = `${__dirname}/docker-compose${options.ssl ? '.ssl' : ''}.yml`;
      const content = await fs.readFileAsync(templateFile);
      const template = yaml.safeLoad(content);
      if (options.debug) {
        if (template.services && template.services.freeradius) {
          template.services.freeradius.command = `bash -c "bash /root/boot.sh && freeradius -X -f > /var/log/freeradius/freeradius.log 2>&1"`
        }
      }
      const output = yaml.safeDump(template);

      await fs.writeFileAsync(`${dockerDir}/docker-compose.yml`, output);
    } catch (err) {
      log.warn("Failed to generate customized radius docker compose yml, use default template");
      await exec(`cp ${__dirname}/docker-compose${options.ssl ? '.ssl' : ''}.yml ${dockerDir}/docker-compose.yml`);
    }
  }

  // prepare config directory
  async prepareContainer(options = {}) {
    try {
      await exec(`rm -rf ${dockerDir}`);
      await exec(`mkdir -p ${dockerDir}`);
      await exec(`mkdir -p ${f.getUserHome()}/.forever/freeradius`).catch(err => null); // systemd permission required
      await exec(`mkdir -p ${dockerDir}/wpa3`).catch(err => null);
      await this.generateComposeConfig(options);
      await exec(`cp ${__dirname}/raddb/eap ${dockerDir}/`);
      await exec(`cp ${__dirname}/raddb/users ${dockerDir}/`);
      await exec(`cp ${__dirname}/raddb/default ${dockerDir}/`);
      await exec(`cp ${__dirname}/raddb/inner-tunnel ${dockerDir}/`);
      await exec(`cp ${__dirname}/raddb/json_accounting ${dockerDir}/`);
      await exec(`cp ${__dirname}/raddb/status ${dockerDir}/`);
      await exec(`cp ${__dirname}/raddb/boot.sh ${dockerDir}/`);
      if (options.ssl) {
        await exec(`cp ${__dirname}/raddb/ca.cnf ${dockerDir}/`);
        await exec(`bash ${__dirname}/genssl.sh`);
      }
      return true;
    } catch (err) {
      log.warn("Cannot prepare freeradius-server environment,", err.message);
    }
  }

  static rand(size = 8) {
    return Math.random().toString(36).substring(2, size + 2);
  }

  _replaceClientConfig(clientConfig) {
    if (!clientConfig.ipaddr) {
      log.warn("invalid freeradius client config ipaddr", clientConfig);
      return "";
    }
    if (!clientConfig.secret) {
      log.warn("invalid freeradius client config secret", clientConfig);
      return "";
    }
    let content = TEMP_CLIENT_NETWORK.replace(/%NAME%/g, clientConfig.name || "nw_" + FreeRadius.rand());
    content = content.replace(/%IPADDR%/g, clientConfig.ipaddr);
    content = content.replace(/%SECRET%/g, clientConfig.secret);
    content = content.replace(/%REQUIRE_MSG_AUTH%/g, clientConfig.require_msg_auth || "auto");
    return content;
  }

  _replaceUserPolicyConfig(userConfig) {
    if (!userConfig.username) {
      log.warn("Invalid freeradius user config username", userConfig);
      return "";
    }
    if (!userConfig.vlan && !userConfig.tag) {
      log.warn("Skip generating freeradius user policy config, vlan and tag is not set", userConfig);
      return "";
    }
    let content = TEMP_USER_POLICY.replace(/%USERNAME%/g, userConfig.username);
    content = content.replace(/%USER_VLAN%/g, userConfig.vlan ? "1" : "0");
    content = content.replace(/%USER_VLAN_ID%/g, userConfig.vlan || "0");
    content = content.replace(/%USER_TAG%/g, userConfig.tag ? "1" : "0");
    content = content.replace(/%USER_TAG_VALUE%/g, userConfig.tag || "-");
    return content;
  }

  _replaceUserConfig(userConfig) {
    if (!userConfig.username) {
      log.warn("Invalid freeradius user config username", userConfig);
      return "";
    }
    if (!userConfig.passwd) {
      log.warn("invalid freeradius user config passwd", userConfig);
      return "";
    }
    let content = TEMP_USER.replace(/%USERNAME%/g, userConfig.username);
    content = content.replace(/%PASSWD%/g, userConfig.passwd);

    return content;
  }

  async _genClientsConfFile(clientConfig) {
    const clientConf = [];
    for (const client of clientConfig) {
      const content = this._replaceClientConfig(client);
      if (content) {
        clientConf.push(content);
      }
    }
    const clientConfigStr = clientConf.join("\n");
    const content = await fs.readFileAsync(`${__dirname}/raddb/clients.conf.tmplt`, { encoding: "utf8" }).catch((err) => null);
    if (!content) {
      log.warn("Not found client.conf.template to generate clients.conf");
      return;
    }
    await fs.writeFileAsync(`${dockerDir}/clients.conf`, content.replace(/%CLIENT_NETWORK_LIST%/g, clientConfigStr));
  }

  async _genUsersConfFile(usersConfig) {
    const userConf = [];
    for (const user of usersConfig) {
      const content = this._replaceUserConfig(user);
      if (content) {
        userConf.push(content);
      }
    }
    const usersConfStr = userConf.join("\n");
    await fs.writeFileAsync(`${dockerDir}/wpa3/users`, usersConfStr);
  }

  async _genUserPolicyConfFile(usersConfig) {
    const userPolicyConf = [];
    for (const policy of usersConfig) {
      const content = this._replaceUserPolicyConfig(policy);
      if (content) {
        userPolicyConf.push(content);
      }
    }
    const userPolicyConfStr = userPolicyConf.join("\n");
    await fs.writeFileAsync(`${dockerDir}/wpa3/users-policy`, userPolicyConfStr);
  }

  async prepareRadiusConfig(config) {
    try {
      await this._genClientsConfFile(config.clients || []);
      if (!await fs.accessAsync(`${dockerDir}/clients.conf`, fs.constants.F_OK).then(() => true).catch((err) => {
        log.warn("Failed to generate clients.conf file,", err.message);
        return false;
      })) {
        log.warn("Failed to generate clients.conf");
        return;
      }
      await this._genUsersConfFile(config.users || []);
      if (!await fs.accessAsync(`${dockerDir}/wpa3/users`, fs.constants.F_OK).then(() => true).catch((err) => {
        log.warn("Failed to genearte users file,", err.message);
        return false;
      })) {
        log.warn("Failed to generate users");
        return;
      }
      await this._genUserPolicyConfFile(config.users || []);
      if (!await fs.accessAsync(`${dockerDir}/wpa3/users-policy`, fs.constants.F_OK).then(() => true).catch((err) => {
        log.warn("Failed to genearte users-policy file,", err.message);
      })) {
        log.warn("Failed to generate users-policy");
        return;
      }
      return true;
    } catch (err) {
      log.warn("Cannot prepare freeradius-server config", err.message);
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
    const watcher = setInterval(() => {
      exec(`sudo systemctl -q is-active docker`).then(() => { dockerRunning = true }).catch((err) => { dockerRunning = false });
    }, 10000);
    await exec(`sudo systemctl start docker`).catch((err) => { });
    await util.waitFor(_ => dockerRunning === true, 30000).then(() => true).catch((err) => false);
    clearInterval(watcher);
    return dockerRunning
  }

  async startServer(radiusConfig, options = {}) {
    this.watchContainer(5);
    await this._startServer(radiusConfig, options);
    this.watchContainer(60);
    await this._statusServer();
  }

  async _startServer(radiusConfig, options = {}) {
    if (!radiusConfig) {
      log.warn("Abort starting radius-server, radius config must be specified.")
      return
    }
    if (this.running) {
      log.warn("Abort starting radius-server, server is already running.")
      return;
    }
    log.info("Starting container freeradius-server...", radiusConfig);
    try {
      if (!await this.prepareContainer(options)) {
        log.warn("Abort starting radius-server, fail to prepare environment");
        return;
      }
      if (!await this.prepareRadiusConfig(radiusConfig)) {
        log.warn("Abort starting radius-server, configuration not ready", radiusConfig);
        return;
      }
      await this._start();
      await util.waitFor(_ => this.running === true, options.timeout * 1000 || 30000).catch((err) => { });
      if (!this.running) {
        log.warn("Container freeradius-server is not started.")
        return;
      }
      log.info("Container freeradius-server is started.");
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
      log.warn("Cannot start freeradius,", e.message)
    });
  }

  async reloadServer(radiusConfig, options = {}) {
    this.watchContainer(5);
    await this._reloadServer(radiusConfig, options);
    this.watchContainer(60);
    await this._statusServer();
  }

  async _reloadServer(radiusConfig, options = {}) {
    try {
      if (!radiusConfig) {
        log.warn("Abort reloading radius-server, radius config must be specified.")
        return
      }
      if (!await this.prepareRadiusConfig(radiusConfig)) {
        log.warn("Abort starting radius-server, configuration not ready", radiusConfig);
        return;
      }
      log.info("Reloading container freeradius-server...");

      await exec(`sudo docker-compose -f ${dockerDir}/docker-compose.yml kill -s SIGHUP freeradius`).catch((e) => {
        log.warn("Cannot reload freeradius,", e.message)
      });
      await sleep(3000);
      await util.waitFor(_ => this.running === true, options.timeout * 1000 || 30000).catch((err) => { });
      log.info("Container freeradius-server is reloaded.");
    } catch (err) {
      log.warn("Failed to reload radius-server,", err.message);
    }
  }

  async _statusServer(options = {}) {
    try {
      this.pid = null;
      log.info("Checking status of container freeradius-server...");
      await exec(`sudo docker-compose -f ${dockerDir}/docker-compose.yml ps`).catch((e) => {
        log.warn("Cannot check status of freeradius,", e.message)
      });

      const result = await exec(`sudo docker-compose -f ${dockerDir}/docker-compose.yml exec -T freeradius pidof freeradius`).then(r => r.stdout.trim()).catch((e) => {
        log.warn("Cannot check status of freeradius,", e.message)
        return;
      });
      if (result) {
        log.info("Container freeradius-server is running, pid:", result);
        this.pid = result;
        return;
      }
      log.info("Container freeradius-server is not running.");
    } catch (err) {
      log.warn("Failed to check status of radius-server,", err.message);
    }
  }

  async stopServer(options = {}) {
    this.watchContainer(5);
    await this._stopServer(options);
    this.watchContainer(60);
    await this._statusServer();
  }

  async _stopServer(options = {}) {
    try {
      log.info("Stopping container freeradius-server...");
      await exec("sudo systemctl stop docker-compose@freeradius").catch((e) => {
        log.warn("Cannot stop freeradius,", e.message)
      });
      await util.waitFor(_ => this.running === false, options.timeout * 1000 || 30000).catch((err) => { });
      if (this.running) {
        log.warn("Container freeradius-server is not stopped.")
        return
      }
      log.info("Container freeradius-server is stopped.");
    } catch (err) {
      log.warn("Failed to stop radius-server,", err.message);
    }
  }

  async reconfigServer(radiusConfig, options = {}) {
    this.watchContainer(5);
    if (options.quickReload) {
      await this._reloadServer(radiusConfig, options);
    } else {
      await this._stopServer(options);
      await this._startServer(radiusConfig, options);
      this.watchContainer(60);
    }
  }

  // radius listens on 1812-1813
  async isListening() {
    return await exec("netstat -an | egrep -q ':1812'").then(() => true).catch((err) => false);
  }

  getStatus() {
    return { running: this.running, pid: this.pid };
  }

}

module.exports = new FreeRadius();
