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
var express = require('express');
var router = express.Router();
const passport = require('passport')

var Encryption = require('../lib/Encryption'); // encryption middleware
var encryption = new Encryption();

var CloudWrapper = require('../lib/CloudWrapper');
var cloudWrapper = new CloudWrapper();

let f = require('../../net2/Firewalla.js');

let log = require('../../net2/logger.js')(__filename, "info");

let sc = require('../lib/SystemCheck.js');

let async = require('asyncawait/async');
let await = require('asyncawait/await');

const jsonfile = require('jsonfile')

router.post('/message/:gid',

  sc.debugInfo,

  (req, res, next) => {

    let gid = req.params.gid;

    async(() => {
      let controller = await(cloudWrapper.getNetBotController(gid));
      let response = await(controller.msgHandlerAsync(gid, req.body));
      res.body = JSON.stringify(response);
      next();
    })()
      .catch((err) => {
        // netbot controller is not ready yet, waiting for init complete
        log.error(err, {})
        res.status(503);
        res.json({error: 'Initializing Firewalla Device, please try later'});
      });
  },

  sc.compressPayloadIfRequired,

  (req, res, next) => {
    res.type('json');
    res.send(res.body);
  }
);


//  {
//   "message": {
//     "from": "iRocoX",
//     "obj": {
//       "mtype": "set",
//       "id": "DA45C7BE-9029-4165-AD56-7860A9A3AE6B",
//       "data": {
//         "value": {
//           "language": "zh"
//         },
//         "item": "language"
//       },
//       "type": "jsonmsg",
//       "target": "0.0.0.0"
//     },
//     "appInfo": {
//       "appID": "com.rottiesoft.circle",
//       "version": "1.25",
//       "platform": "ios"
//     },
//     "msg": "",
//     "type": "jsondata",
//     "compressMode": 1,
//     "mtype": "msg"
//   },
//   "mtype": "msg"
// }

router.post('/simple', (req, res, next) => {
  const command = req.query.command || "init"
  const item = req.query.item || ""
  const content = req.body || {}
  const target = req.query.target || "0.0.0.0"

  let body = {
    "message": {
      "from": "iRocoX",
      "obj": {
        "mtype": "set",
        "id": "DA45C7BE-9029-4165-AD56-7860A9A3AE6B",
        "data": {
          "value": {
            "language": "zh"
          },
          "item": "language"
        },
        "type": "jsonmsg",
        "target": "0.0.0.0"
      },
      "appInfo": {
        "appID": "com.rottiesoft.circle",
        "version": "1.25",
        "platform": "ios"
      },
      "msg": "",
      "type": "jsondata",
      "compressMode": 1,
      "mtype": "msg"
    },
    "mtype": "msg"
  }

  body.message.obj.mtype = command
  body.message.obj.data.item = item
  body.message.obj.target = target

  
  try {
    const gid = jsonfile.readFileSync("/home/pi/.firewalla/ui.conf").gid

//    const c = JSON.parse(content)
    body.message.obj.data.value = content

    async(() => {
      let controller = await(cloudWrapper.getNetBotController(gid));
      let response = await(controller.msgHandlerAsync(gid, body));
      res.body = JSON.stringify(response);
      res.type('json');
      res.send(res.body);
    })()
      .catch((err) => {
        // netbot controller is not ready yet, waiting for init complete
        log.error(err, {})
        res.status(503);
        res.json({error: 'Initializing Firewalla Device, please try later'});
      });

  } catch(err) {
    res.status(400).send({error: err})
  }  
})

module.exports = router;
