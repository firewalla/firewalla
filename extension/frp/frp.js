
/*    Copyright 2016 Firewalla LLC
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

let instance = null;
let log = require("../../net2/logger.js")(__filename);

const firewalla = require('../../net2/Firewalla.js');

const fHome = firewalla.getFirewallaHome()
const frpDirectory = __dirname
const configTemplateFile = `${frpDirectory}/frpc.ini.template`  // default template
const serviceTemplateFile = `${frpDirectory}/frpc.service.template`;

const Promise = require('bluebird');

const async = require('asyncawait/async');
const await = require('asyncawait/await');

const rclient = require('../../util/redis_manager.js').getRedisClient()


//const spawn = require('child-process-promise').spawn;
const spawn = require('child_process').spawn
const spawnSync = require('child_process').spawnSync

const fs = require('fs')
const readFile = Promise.promisify(fs.readFile)
const writeFile = Promise.promisify(fs.writeFile)
const unlink = Promise.promisify(fs.unlink)

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}

module.exports = class {
  constructor(name) {
    this.name = name || "support";
    this.started = false
    this.serviceTag = "SSH"
    this.configComplete = false;

    // if frp service is started during execution of async block, inconsistency may occur?
    (async () => {
      if (await this._isUp()) {
        // need to refresh config
        await this._loadConfigFile();
        this.started = true;
        this.configComplete = true;
      }
    })();
    return this
  }

  async _loadConfigFile() {
    const configPath = this._getConfigPath();
    const configData = await readFile(configPath, 'utf8');
    let lines = configData.split('\n');
    lines = lines.filter(l => l.includes("remote_port"));
    const remotePort = lines[0].substring(14);  // length of "remote_port = "
    this.port = remotePort;
  }

  async createConfigFile(config) {
    if (this.name === "support") {
      return this._prepareConfiguration(config);
    }

    if(!config) {
      log.warn(`Missing config information for frp ${this.name}`);
      return;
    }

    const genericTemplate = `${frpDirectory}/frpc.generic.ini.template`
    const port = config.port || this._getRandomPort(config.portBase, config.portLength)
    this.port = port;

    let templateData = await readFile(genericTemplate, 'utf8');

    if(config.name) {
      templateData = templateData.replace(/FRP_SERVICE_NAME/g, config.name)
    }

    if(port) {
      templateData = templateData.replace(/FRP_SERVICE_PORT/g, port)
    }

    if(config.token) {
      templateData = templateData.replace(/FRP_SERVICE_TOKEN/g, config.token)
    }

    if(config.server) {
      templateData = templateData.replace(/FRP_SERVER_ADDR/g, config.server)
    }

    if(config.serverPort) {
      templateData = templateData.replace(/FRP_SERVER_PORT/g, config.serverPort)
    }

    if(config.internalPort) {
      templateData = templateData.replace(/FRP_SERVICE_INTERNAL_PORT/g, config.internalPort)
    }

    if(config.protocol) {
      templateData = templateData.replace(/FRP_SERVICE_PROTOCOL/g, config.protocol)
    }

    const filePath = this._getConfigPath();
    await writeFile(filePath, templateData, 'utf8');

    this.configComplete = true;
    return {
      filePath: filePath,
      port: port
    };
  }

  _getConfigPath() {
    return `${frpDirectory}/frpc.${this.name}.ini`;
  }

  _getPidPath() {
    if (this.name !== "support") {
      return `${frpDirectory}/frpc.customized.${this.name}.pid`;
    } else {
      // use default pid file
      return pidFile;
    }
  }

  _getServiceName() {
    return `frpc.${this.name}`;
  }

  _getServiceFilePath() {
    return `${frpDirectory}/frpc.${this.name}.service`;
  }

  async _isUp() {
    const serviceName = this._getServiceName();
    const o = spawnSync('systemctl', ['is-active', '--quiet', serviceName]);
    const exitCode = o.status;
    if (exitCode === 0) {
      log.info(`Service ${serviceName} is already up`);
      return true;
    }

    log.info(`Service ${serviceName} is offline`);
    return false;
  }

  async _prepareConfiguration(config) {
    let templateFile = configTemplateFile // default is the support config template file
    const userToken = null;
    if (config) {
      userToken = config.userToken;
    }

    if(this.templateFilename) {
      templateFile = `${frpDirectory}/${this.templateFilename}`
    }

    this.port = this._getRandomPort();

    let templateData = await readFile(templateFile, 'utf8')
    templateData = templateData.replace(/FRP_SERVICE_NAME/g, `${this.serviceTag}${this.port}`)
    templateData = templateData.replace(/FRP_SERVICE_PORT/g, this.port)

    let token = await rclient.hgetAsync("sys:config", "frpToken")
    if(userToken) {
      token = userToken
    }
    if(this.token) {
      token = this.token
    }
    if(token) {
      templateData = templateData.replace(/FRP_SERVICE_TOKEN/g, token)
    }

    if(this.server) {
      templateData = templateData.replace(/FRP_SERVER/g, this.server)
    }

    const configFilePath = this._getConfigPath();
    await writeFile(configFilePath, templateData, 'utf8')

    this.configComplete = true;
    return {
      filePath: configFilePath,
      port: 22
    };
  }

  configFile() {
    return this._getConfigPath();
  }

  server() {
    return "support.firewalla.com"
  }

  user() {
    return "pi"
  }

  getConfig() {
    
    return {
      started: this.started,
      port: this.port,
      server: this.server(),
      user: this.user()
    }
  }

  _getRandomPort(base, length) {
    base = base || 9000
    length = length || 1000
    return  Math.floor(Math.random() * length) + base
  }

  start() {
    return async(() => {
      const isUp = await(this._isUp());
      if (!isUp) {
        await(this.createConfigFile());
        return this._start();
      } else {
        await(this._loadConfigFile());
        this.started = true;
        this.configComplete = true;
      }
    })()
  }

  stop() {
    (async () => {
      if (await this._isUp()) {
        this._stop();
      }
    })();
    return delay(500)
  }

  _start() {
    const serviceName = this._getServiceName();
    const serviceFilePath = this._getServiceFilePath();
    const configFilePath = this._getConfigPath();
    const frpCmd = `${frpDirectory}/frpc.${firewalla.getPlatform()}`;
    /*
    // TODO: ini file needs to be customized before being used
    const args = ["-c", configFilePath];

    this.cp = spawn(cmd, args, {cwd: frpDirectory, encoding: 'utf8', detached: true});
    this.cp.unref();
    const childPid = this.cp.pid;
    log.info("frp process id: " + childPid);
    */

    return new Promise((resolve, reject) => {
      // generate service spec file 
      let templateData = await(readFile(serviceTemplateFile, 'utf8'));
      templateData = templateData.replace(/FRPC_COMMAND/g, frpCmd);
      templateData = templateData.replace(/FRPC_CONF/g, configFilePath);
      await(writeFile(serviceFilePath, templateData, 'utf8'));

      spawnSync('sudo', ['cp', serviceFilePath, '/etc/systemd/system/']);
      const cp = spawn('sudo', ['systemctl', 'start', serviceName]);
      let hasTimeout = true;

      cp.stderr.on('data', (data) => {
        log.error(data.toString())
      })
      
      cp.on('exit', (code, signal) => {
        if (code === 0) {
          log.info("Service " + serviceName + " started successfully");
          this.started = true;
          hasTimeout = false;
          resolve();
        } else {
          log.error("Failed to start " + serviceName, code, signal, {});
        }
      })
      
      /*
      process.on('exit', () => {
        this._stop();
      });
      */

      // wait for 15 seconds
      delay(15000).then(() => {
        if(hasTimeout) {
          log.error("Timeout, failed to start frp")
          reject(new Error("Failed to start frp"))
        }
      })
    })
  }

  _stop() {
    const serviceName = this._getServiceName();
    log.info("Try to stop FRP service:" + serviceName);
    spawnSync('sudo', ['systemctl', 'stop', serviceName]);
    this.started = false;
  }
}


