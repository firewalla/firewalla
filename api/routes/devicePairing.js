/**
 * Created by Melvin Tu on 22/01/2017.
 */

'use strict';

let express = require('express');
let router = express.Router();

let uuid = require("uuid");

let redis = require('redis');
let rclient = redis.createClient();



router.get('/token',
  function(req, res, next) {
    rclient.get('rid.temp', (err, reply) => {
      if(reply) {
        rclient.hget('sys:ept', 'gid', (err, reply2) => {
          if(reply2) {
            res.json({
              token: reply,
              type: "fb",
              service: "Firewalla Bot",
              mid: uuid.v4(),
              gid: reply2,
              rid: reply,
              rk: {
                r: reply,
                eid: 0
              }
            });
          } else {
            res.status(404).send('Group ID Not Found');
          }
        });
      } else {
        res.status(404).send('RID Not Found');
      }
    });
  });

module.exports = router;
