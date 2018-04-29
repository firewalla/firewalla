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

let express = require('express');
const passport = require('passport');
let router = express.Router();

let Mode = require('../../net2/Mode.js');

const redis = require('redis');
const rclient = require('../../util/redis_manager.js').getRedisClient()

let modeManager = require('../../net2/ModeManager.js');

// this is only for debugging purpose
router.post('/apply',
  (req, res, next) => {
    modeManager.apply()
      .then(() => res.json({
        status: "success"
      }))
      .catch((err) => res.status(500).send(err))
  });

router.post('/dhcp',
  (req, res, next) => {
    modeManager.setDHCPAndPublish();
    res.json({
      status: "success"
    });
  });

router.post('/spoof',
  (req, res, next) => {
    modeManager.setSpoofAndPublish();
    res.json({
      status: "success"
    });
  });

router.post('/autospoof',
  (req, res, next) => {
    modeManager.setAutoSpoofAndPublish();
    res.json({
      status: "success"
    });
  });

router.post('/manualspoof',
  (req, res, next) => {
    modeManager.setManualSpoofAndPublish();
    res.json({
      status: "success"
    });
  });

router.post('/none',
  (req, res, next) => {
    modeManager.setNoneAndPublish();
    res.json({
      status: "success"
    });
  });

router.get('/mode',
  (req, res, next) => {
    modeManager.mode()
      .then((mode) => res.json({
        mode: mode
      }))
      .catch((err) => res.status(500).send(err))
  });



module.exports = router;
