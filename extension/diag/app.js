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

'use strict'

const log = require("../../net2/logger")('diag');

const express = require('express');
const https = require('https');
const qs = require('querystring');
const path = require('path');

const port = 8835

const Promise = require('bluebird')

const async = require('asyncawait/async');
const await = require('asyncawait/await');

const sysinfo = require('../sysinfo/SysInfo.js')

const exec = require('child-process-promise').exec

const moment = require('moment')

const VIEW_PATH = 'view';
const STATIC_PATH = 'static';

const errorCodes = {
  "firekick": 101,
  "firemain": 102,
  "fireapi": 103,
  "firemon": 104,
  "memory": 201,
  "database": 301,
  "gid": 401,
  "ip": 501
}

class App {
  constructor() {
    this.app = express();

    this.app.engine('mustache', require('mustache-express')());
    this.app.set('view engine', 'mustache');

    this.app.set('views', path.join(__dirname, VIEW_PATH));
    //this.app.disable('view cache'); //for debug only

    this.routes();
  }

  getSystemTime() {
    return new Date() / 1000
  }

  getSystemServices() {
    const fireKickCmd = "systemctl is-active firekick"
    const fireMainCmd = "systemctl is-active firemain"
    const fireApiCmd = "systemctl is-active fireapi"
    const fireMonCmd = "systemctl is-active firemon"

    return async(() => {
      try {
        await (exec(fireKickCmd))
      } catch(err) {
        return errorCodes.firekick
      }

      try {
        await (exec(fireMainCmd))
      } catch(err) {
        return errorCodes.firemain
      }
      
      try {
        await (exec(fireApiCmd))
      } catch(err) {
        return errorCodes.fireapi
      }

      try {
        await (exec(fireMonCmd))
      } catch(err) {
        return errorCodes.firemon
      }

      return 0
    })()
  }

  getCloudConnectivity() {
    return this.connected
  }

  getSystemMemory() {
    return async(() => {
      const result = exec("free -m")
      const stdout = result.stdout
      const lines = stdout.split(/\n/g)

      for(var i = 0; i < lines.length; i++) {
        lines[i] = lines[i].split(/\s+/)
      }

      allMem = parseInt(lines[1][1])

      if(allMem > 490) {
        return 0
      } else {
        return errorCodes.memory
      }
    })()    
  }

  getNodeVersion() {
    return process.version
  }

  getUptime() {
    return require('os').uptime()
  }

  getDatabase() {
    return async(() => {
      try {
        await (exec("systemctl is-active redis-server"))
      } catch(err) {
        return errorCodes.database
      }

      return 0
    })()
  }

  getGID() {
    return async(() => {
      try {
        await (exec("redis-cli hget sys:ept gid"))
      } catch(err) {
        return errorCodes.gid
      }

      return 0
    })()
  }

  getPrimaryIP() {
    return async(() => {
      try {
        const ip = await (exec("ifconfig eth0 | grep -Eo 'inet (addr:)?([0-9]*\.){3}[0-9]*' | grep -Eo '([0-9]*\.){3}[0-9]*' | grep -v '127.0.0.1'"))        
        return ip
      } catch(err) {
        return ""
      }
    })()
  }
  
  routes() {
    this.router = express.Router();    

    this.app.use('/' + VIEW_PATH, this.router);
    this.app.use('/' + STATIC_PATH, express.static(path.join(__dirname, STATIC_PATH)));

    this.app.use('*', (req, res) => {
      log.info("Got a request in *")
    
      return async(() => {
        const time = this.getSystemTime()
        const ip = await (this.getPrimaryIP())
        const gid = await (this.getGID())
        const database = await(this.getDatabase())
        const uptime = this.getUptime()
        const nodeVersion = this.getNodeVersion()
        const memory = await(this.getSystemMemory())
        const connected = this.getCloudConnectivity()
        const systemServices = await(this.getSystemServices())
        
        if(ip == "" || gid != 0 || database != 0 || memory != 0 || connected != true || systemServices != 0 ) {
          // make sure device local time is displayed on the screen
          res.render('diag', {time, ip, gid, database, uptime, nodeVersion, memory, connected, systemServices})
        } else {
          res.render('welcome', {broadcastInfo: this.broadcastInfo, time: time})
        }
        
      })()
    })
  }

  start() {
    this.app.listen(port, () => log.info(`Httpd listening on port ${port}!`));
  }
}

module.exports = App