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
const log = require("../../net2/logger.js")(__filename);

const firewalla = require('../../net2/Firewalla.js');

const fHome = firewalla.getFirewallaHome()
const frpDirectory = __dirname
const configTemplateFile = `${frpDirectory}/frpc.ini.template`  // default template
const serviceTemplateFile = `${frpDirectory}/frpc.service.template`;

const rclient = require('../../util/redis_manager.js').getRedisClient()
const sclient = require('../../util/redis_manager.js').getSubscriptionClient()
const sem = require('../../sensor/SensorEventManager.js').getInstance()

const bone = require("../../lib/Bone.js");

//const spawn = require('child-process-promise').spawn;
const spawn = require('child_process').spawn
const spawnSync = require('child_process').spawnSync
const execSync = require('child_process').execSync

const util = require('util');

const fs = require('fs')
const readFile = util.promisify(fs.readFile)
const writeFile = util.promisify(fs.writeFile)

const supportTimeout = 7 * 86400; // support session keeps alive for at most 7 days

const FRPERRORCODE = 1
const FRPSUCCESSCODE = 0
const FRPINITCODE = -1
const FRPCONNECTERRORREJECT = 3
const FRPTRYCOUNT = 3

const startFailWord = "connection refused"

const supportStartTimeKey = "frpc_support_start_time";
const supportEndTimeKey = "frpc_support_end_time";

function delay(t) {
  return new Promise(function (resolve) {
    setTimeout(resolve, t)
  });
}

function getLastServiceLogTime(serviceName) {
  let str = execSync(
    `sudo journalctl -u ${serviceName} | tail -n 1`
  ).toString('utf8').substring(0, 15);

  try {
    return new Date(str)
  } catch (err) {
    return null
  }
}

function getLastSystemLogTime(serviceName) {
  let str = execSync(
    `sudo grep ${serviceName} /var/log/syslog | tail -n 1`
  ).toString('utf8').substring(0, 15);

  try {
    return new Date(str)
  } catch (err) {
    return null
  }
}

module.exports = class {
  constructor(name) {
    this.name = name || "support";
    this.started = false
    this.serviceTag = "SSH"
    this.configComplete = false;
    this.startCode = FRPINITCODE;

    // if frp service is started during execution of async block, inconsistency may occur?
    (async () => {
      if (this._isUp()) {
        // need to refresh config
        await this._loadConfigFile();
        this.started = true;
        this.configComplete = true;
        if (this.name === "support" && firewalla.isApi()) {
          this.startTime = await rclient.getAsync(supportStartTimeKey).then((value) => value && Number(value)) || Math.floor(Date.now() / 1000);
          this.endTime = await rclient.getAsync(supportEndTimeKey).then((value) => value && Number(value)) || (this.startTime + supportTimeout);
          const timeRemaining = this.endTime - Math.floor(Date.now() / 1000);
          if (timeRemaining > 0) {
            log.info(`Support session will be closed in ${timeRemaining} seconds`);
            if (this.supportTimeoutTask)
              clearTimeout(this.supportTimeoutTask);
            this.supportTimeoutTask = setTimeout(() => {
              log.info("Support session is closed due to timeout");
              this.stop();

            }, timeRemaining * 1000);
          } else {
            log.info(`Current support session is already expired, stop it ...`);
            this.stop();
          }
        }
      }
    })();
    sclient.on("message", (channel, message) => {
      if (channel === "System:RemoteSupport") {
        try {
          message = JSON.parse(message) || {}
          this.startCode = message.code
          sem.emitEvent({
            type: "RemoteSupport"
          })
        } catch (err) {
          log.warn("System:RemoteSupport error:", err)
        }
      }
    })
    sclient.subscribe("System:RemoteSupport");
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

    if (!config) {
      log.warn(`Missing config information for frp ${this.name}`);
      return;
    }

    const genericTemplate = `${frpDirectory}/frpc.generic.ini.template`
    const port = config.port || this._getRandomPort(config.portBase, config.portLength)
    this.port = port;

    let templateData = await readFile(genericTemplate, 'utf8');

    if (config.name) {
      templateData = templateData.replace(/FRP_SERVICE_NAME/g, config.name)
    }

    if (port) {
      templateData = templateData.replace(/FRP_SERVICE_PORT/g, port)
    }

    if (config.token) {
      templateData = templateData.replace(/FRP_SERVICE_TOKEN/g, config.token)
    }

    if (config.server) {
      templateData = templateData.replace(/FRP_SERVER_ADDR/g, config.server)
    }

    if (config.serverPort) {
      templateData = templateData.replace(/FRP_SERVER_PORT/g, config.serverPort)
    }

    if (config.internalPort) {
      templateData = templateData.replace(/FRP_SERVICE_INTERNAL_PORT/g, config.internalPort)
    }

    if (config.protocol) {
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

  _isUp() {
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

    if (this.templateFilename) {
      templateFile = `${frpDirectory}/${this.templateFilename}`
    }

    this.port = this._getRandomPort();

    let templateData = await readFile(templateFile, 'utf8')
    templateData = templateData.replace(/FRP_SERVICE_NAME/g, `${this.serviceTag}${this.port}`)
    templateData = templateData.replace(/FRP_SERVICE_PORT/g, this.port)

    let token = await rclient.hgetAsync("sys:config", "frpToken")
    if (userToken) {
      token = userToken
    }
    if (this.token) {
      token = this.token
    }
    if (token) {
      templateData = templateData.replace(/FRP_SERVICE_TOKEN/g, token)
    }

    if (this.server) {
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
      user: this.user(),
      startCode: this.startCode
    }
  }

  _getRandomPort(base, length) {
    base = base || 9000
    length = length || 3000
    return Math.floor(Math.random() * length) + base
  }

  async start() {
    const isUp = this._isUp();
    if (!isUp) {
      await this.createConfigFile();
      await this._start();
    } else {
      await this._loadConfigFile();
      this.configComplete = true;
    }
    this.started = true;
  }

  async stop() {
    this._stop();
    this.started = false;
    this.startCode = FRPINITCODE;
    if (this.supportTimeoutTask)
      clearTimeout(this.supportTimeoutTask);
    return delay(500)
  }

  async _start() {
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

    // generate service spec file
    let templateData = await readFile(serviceTemplateFile, 'utf8');
    templateData = templateData.replace(/FRPC_COMMAND/g, frpCmd);
    templateData = templateData.replace(/FRPC_CONF/g, configFilePath);
    await writeFile(serviceFilePath, templateData, 'utf8');

    spawnSync('sudo', ['cp', serviceFilePath, '/etc/systemd/system/']);
    const cp = spawn('sudo', ['systemctl', 'start', serviceName]);
    let hasTimeout = true;
    cp.stderr.on('data', (data) => {
      log.error(data.toString())
    })

    return new Promise((resolve, reject) => {
      cp.on('exit', (code, signal) => {
        if (code === 0) {
          log.info("Service " + serviceName + " started successfully");
          hasTimeout = false;
          // do not support health check temporarily
          // this._startHealthChecker();
          if (this.name == "support") {
            sem.once("RemoteSupport", () => {
              if (checkLogTask) clearInterval(checkLogTask)
              resolve();
            })
            const checkLogTask = setInterval(() => {  
              const syslog = this.getFrpSyslogOutput()
              if (syslog.includes(startFailWord)) {
                this.startCode = FRPCONNECTERRORREJECT
                clearInterval(checkLogTask)
                resolve();
              }
            }, 1 * 1000)
            setTimeout(() => {
              clearInterval(checkLogTask)
              resolve();
            }, 10 * 1000)
          } else {
            resolve();
          }
        } else {
          log.error("Failed to start " + serviceName, code, signal);
        }
      })

      /*
      process.on('exit', () => {
        this._stop();
      });
      */

      // wait for 15 seconds
      delay(15000).then(() => {
        if (hasTimeout) {
          log.error("Timeout, failed to start frp");
          this._boneLog("Timeout, failed to start service.");
          reject(new Error("Failed to start frp"));
        }
      })

    })
  }

  _stop() {
    const serviceName = this._getServiceName();
    log.info("Try to stop FRP service:" + serviceName);
    spawnSync('sudo', ['systemctl', 'stop', serviceName]);
    clearInterval(this.healthChecker);
  }

  _boneLog(message) {
    let syslog = execSync(
      `sudo grep frpc /var/log/syslog | tail -n 20`
    ).toString('utf8');

    bone.logAsync("error", {
      type: this._getServiceName(),
      msg: message,
      stack: syslog
    });
  }


  _startHealthChecker() {
    const CHECK_INTERVAL = 5 * 60 * 1000; // Don't set this too small
    const REPORT_THRESHOLD = 3;
    this.logRefreshCount = 0;
    if (!this.lastLogTime)

      this.healthChecker = setInterval(() => {
        try {
          // systemctl/journalctl won't be able to pick up the service restart log
          let serviceLogTime = getLastServiceLogTime(this._getServiceName());
          let systemLogTime = getLastSystemLogTime(this._getServiceName());

          let logTime = serviceLogTime > systemLogTime ? serviceLogTime : systemLogTime; // could be null
          log.info("logTime", logTime);

          if (!this.lastLogTime) this.lastLogTime = logTime;

          if (logTime && +logTime != +this.lastLogTime) {
            log.info(this._getServiceName(),
              'logRefreshCount:', this.logRefreshCount, 'lastLogTime:', logTime);
            this.lastLogTime = logTime;
            if (++this.logRefreshCount > REPORT_THRESHOLD) {
              throw new Error("Something is wrong!");
            }
          } else {
            this.logRefreshCount = 0;
          }
        } catch (err) {
          log.error(err);
          this._boneLog(err);
          clearInterval(this.healthChecker); // report once
        }

      }, CHECK_INTERVAL);

    log.info(this._getServiceName(), "health checker started");
  }

  getFrpSyslogOutput() {
    const serviceName = this._getServiceName();
    const cmd = `sudo journalctl -u ${serviceName} | tail -n 5`
    const result = execSync(cmd).toString('utf-8')
    return result;
  }

  async remoteSupportStart(timeout) {
    timeout = timeout || supportTimeout;
    let tryStartFrpCount = FRPTRYCOUNT,
      errMsg = [], config;
    do {
      tryStartFrpCount--;
      await this.start();
      config = this.getConfig();
      if (config.startCode == FRPSUCCESSCODE) {
        tryStartFrpCount = 0;
        if (firewalla.isApi()) {
          if (this.supportTimeoutTask)
            clearTimeout(this.supportTimeoutTask);
          this.startTime = Math.floor(Date.now() / 1000);
          this.endTime = this.startTime + timeout;
          await rclient.setAsync(supportStartTimeKey, this.startTime);
          await rclient.setAsync(supportEndTimeKey, this.endTime);
          this.supportTimeoutTask = setTimeout(() => {
            log.info("Support session is closed due to timeout");
            this.stop();
          }, supportTimeout * 1000);
        }
      } else {
        await this.stop();
        if (config.startCode == FRPINITCODE) {
          errMsg.push("Time out.");
        } else if (config.startCode == FRPERRORCODE) {
          errMsg.push(`Port: ${config.port} is already being used.`);
        } else if (config.startCode == FRPCONNECTERRORREJECT) {
          errMsg.push(`Connection was Rejected`);
        } 
      }
    } while (tryStartFrpCount > 0)
    return { config: config, errMsg: errMsg }
  }
}


