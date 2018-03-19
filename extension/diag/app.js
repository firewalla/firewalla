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

const SysInfo = require('../sysinfo/SysInfo.js')

const VIEW_PATH = 'view';
const STATIC_PATH = 'static';

class App {
  constructor() {
    this.app = express();

    this.app.engine('mustache', require('mustache-express')());
    this.app.set('view engine', 'mustache');

    this.app.set('views', path.join(__dirname, VIEW_PATH));
    //this.app.disable('view cache'); //for debug only

    this.routes();
  }

  routes() {
    this.router = express.Router();    

    this.app.use('/' + VIEW_PATH, this.router);
    this.app.use('/' + STATIC_PATH, express.static(path.join(__dirname, STATIC_PATH)));

    this.app.use('*', (req, res) => {
      log.info("Got a request in *")
      const info = sysinfo.getSystemInfo()
      log.info(info)

      res.render('diag', {info})
    })
  }

  start() {
    this.app.listen(port, () => log.info(`Httpd listening on port ${port}!`));
  }
}

module.exports = App