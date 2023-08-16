/*    Copyright 2020-2022 Firewalla Inc.
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

var CloudWrapper = require('../lib/CloudWrapper');
var cloudWrapper = new CloudWrapper();

let log = require('../../net2/logger.js')(__filename, "info");

let sc = require('../lib/SystemCheck.js');

const delay = require('../../util/util.js').delay;

const util = require('util')
const jsonfile = require('jsonfile');
const jsReadFile = util.promisify(jsonfile.readFile)

router.post('/message/:gid',

  sc.debugInfo,

  (req, res, next) => {

    const localIPs = ["127.0.0.1", "::ffff:127.0.0.1"];

    if(!localIPs.includes(req.connection.remoteAddress)) { // this api can only be used for local access
      res.status(404).send("");
      return;
    }

    let gid = req.params.gid;

    (async() =>{
      let controller = await cloudWrapper.getNetBotController(gid)
      let response = await controller.msgHandlerAsync(gid, req.body)
      res.body = JSON.stringify(response);
      next();
    })()
      .catch((err) => {
        // netbot controller is not ready yet, waiting for init complete
        log.error(err);
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

const simple = (req, res, next) => {
  const command = req.query.command || "init"
  const item = req.query.item || ""
  const content = req.body || {}
  const target = req.query.target || "0.0.0.0"
  const streaming = req.query.streaming || false;

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
  body.message.obj.id = req.query.id || body.message.obj.id
  const data = body.message.obj.data
  if (req.query.start) data.start = parseInt(req.query.start)
  if (req.query.end) data.end = parseInt(req.query.end)
  if (req.query.hourblock) data.hourblock = parseInt(req.query.hourblock)
  if (req.query.direction) data.direction = req.query.direction

  try {
//    const c = JSON.parse(content)
    if (content) body.message.obj.data.value = content;

    // make a reference to this object, because res.socket will be gone after close event on res.socket
    const resSocket = res.socket;

    res.socket.on('close', () => {
      log.info("connection is closed:", resSocket._peername);
      res.is_closed = true;
    });

    (async() => {

      const gid = (await jsReadFile("/home/pi/.firewalla/ui.conf")).gid

      if(streaming) {
        res.set({
          'Cache-Control': 'no-cache',
          'Content-Type': 'text/event-stream',
          'Connection': 'keep-alive'
        });
        res.flushHeaders();

        body.message.obj.data.value.streaming = {id: body.message.obj.id};

        while(streaming && !res.is_closed) {
          try {
            let controller = await cloudWrapper.getNetBotController(gid);
            let response = await controller.msgHandlerAsync(gid, body, "streaming");

            const reply = `id: ${body.message.obj.id}\nevent: ${item}\ndata: ${JSON.stringify(response)}\n\n`;
            res.write(reply);
            await delay(1500); // self protection
            body.message.suppressLog = true; // suppressLog after first call
          } catch(err) {
            log.error("Got error when handling request, err:", err);
            break;
          }
        }
      } else {
        let controller = await cloudWrapper.getNetBotController(gid);
        let response = await controller.msgHandlerAsync(gid, body);
        res.body = JSON.stringify(response);
        res.type('json');
        res.send(res.body);
      }

    })()
      .catch((err) => {
        // netbot controller is not ready yet, waiting for init complete
        log.error(err);
        res.status(503);
        res.json({error: 'Initializing Firewalla Device, please try later'});
      });

  } catch(err) {
    res.status(400).send({
      error: err.message,
      stack: err.stack
    })
  }
};

router.post('/simple', simple);
router.get('/simple', simple);

router.post('/complex', (req, res, next) => {
  const command = req.query.command || "init"
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
  body.message.obj.target = target
  body.message.obj.data = content;

  try {
    (async() =>{
      const gid = (await jsReadFile("/home/pi/.firewalla/ui.conf")).gid;

      let controller = await cloudWrapper.getNetBotController(gid)
      let response = await controller.msgHandlerAsync(gid, body)
      res.body = JSON.stringify(response);
      res.type('json');
      res.send(res.body);
    })()
      .catch((err) => {
        // netbot controller is not ready yet, waiting for init complete
        log.error(err);
        res.status(503);
        res.json({error: 'Initializing Firewalla Device, please try later'});
      });

  } catch(err) {
    res.status(400).send({
      error: err.message,
      stack: err.stack
    })
  }
})

module.exports = router;
