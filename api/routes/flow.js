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

let express = require('express');
let router = express.Router();
let bodyParser = require('body-parser')

let FlowManager = require('../../net2/FlowManager.js');
let flowManager = new FlowManager();

let Promise = require('bluebird');

router.get('/stats', (req, res, next) => {
  let download = flowManager.getLast24HoursDownloadsStats();
  let upload = flowManager.getLast24HoursUploadsStats();

  Promise.join(download, upload, (d, u) => {
    res.json({ upload: u, download: d});
  });
});

module.exports = router;
