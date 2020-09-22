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

const log = require('../../net2/logger.js')(__filename);
const bone = require("../../lib/Bone");

const IntelTool = require('../../net2/IntelTool');
const intelTool = new IntelTool();

const express = require('express');
const router = express.Router();

const _ = require('lodash');

router.get('/:ip',
  (req, res, next) => {
    let ip = req.params.ip
    let useLocal = req.query.useLocal

    let options = {skipReadLocalCache: useLocal ? false : true };

    let DestIPFoundHook = require('../../hook/DestIPFoundHook');
    let destIPFoundHook = new DestIPFoundHook();

    destIPFoundHook.processIP(ip, options) // do not store result in redis
      .then((json) => {
        res.json(json);
      }).catch((err) => {
        res.status(500).json({
          error: err
        });
      });
  });

router.get('/domain/:domain', async (req, res, next) => {
  let domain = req.params.domain;
  log.info("/intel/domain/" + domain);

  let result;
  try {
    result = await intelTool.checkIntelFromCloud(null, domain);
  } catch (err) {
    log.error("Error when intel", err);
  }

  if (!result) {
    log.info("invalid result:", domain);
    res.status(500).send();
    return;
  }

  res.json(result).send();
});

router.get('/finger/:target', async (req, res, next) => {
  let target = req.params.target;
  log.info("/intel/finger/" + target);
  let result;
  try {
    result = await bone.intelFinger(target);
  } catch (err) {
    log.error("Error when intel finger", err);
  }

  if (!result) {
    log.info("invalid result:", target);
    res.status(500).send();
    return;
  }

  res.json(result).send();
});


module.exports = router;
