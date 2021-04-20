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

let fConfig = require('../../net2/config.js').getConfig();

router.post("/run/:sensor",
           (req, res, next) => {
             let sensor = req.params.sensor;
             let TheSensor = require(`../../sensor/${sensor}.js`);
             let s = new TheSensor(fConfig.sensors[sensor]);
             s.run()

             res.json({});
           });

module.exports = router;
