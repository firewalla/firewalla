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
const configTemplateFile = `${frpDirectory}/frpc.ini.template`
const configFile = `${frpDirectory}/frpc.ini`

const Promise = require('bluebird');

const async = require('asyncawait/async');
const await = require('asyncawait/await');

//const spawn = require('child-process-promise').spawn;
const spawn = require('child_process').spawn

const fs = require('fs')
const readFile = Promise.promisify(fs.readFile)
const writeFile = Promise.promisify(fs.writeFile)

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}

module.exports = class {
  constructor() {
    if (instance == null) {
      instance = this;
      this.cp = null;
      this.started = false;
      this.randomizePort();
    }
    return instance;
  }

  _prepareConfiguration() {
    return async(() => {
      let templateData = await (readFile(configTemplateFile, 'utf8'))
      templateData = templateData.replace(/FRP_SERVICE_NAME/g, `SSH${this.port}`)
      templateData = templateData.replace(/FRP_SERVICE_PORT/g, this.port)
      await(writeFile(configFile, templateData, 'utf8'))
    })()
  }

  configFile() {
    return configFile
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

  randomizePort() {
    // FIXME: possible port conflict
    this.port = Math.floor(Math.random() * 1000) + 9000 // random port between 9000 - 10000
  }

  start() {
    return async(() => {
      this.randomizePort();
      await(this._prepareConfiguration())
      return this._start();
    })()
  }

  stop() {
    this._stop()
    return delay(500)
  }

  _start() {
    const cmd = `./frpc.${firewalla.getPlatform()}`;

    // TODO: ini file needs to be customized before being used
    const args = ["-c", "./frpc.ini"];

    this.cp = spawn(cmd, args, {cwd: frpDirectory, encoding: 'utf8'});

    return new Promise((resolve, reject) => {
      let hasTimeout = true;

      this.cp.stdout.on('data', (data) => {
        log.info(data.toString())
        if(data.toString().match(/start proxy success/)) {
          this.started = true
          hasTimeout = false;
          log.info("frp is started successfully")
          resolve();
        }
      })

      this.cp.stderr.on('data', (data) => {
        log.error(data.toString())
      })

      this.cp.on('exit', (code, signal) => {
        log.info("frp exited with code:", code, signal, {})
      })

      process.on('exit', () => {
        this._stop();
      });

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
    if(this.cp) {
      log.info("Terminating frpc")
      this.cp.kill();
      this.cp = null;
      this.started = false
    }
  }
}
