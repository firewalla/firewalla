/*    Copyright 2016-2022 Firewalla Inc.
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

const log = require('../../net2/logger.js')(__filename, 'info');
let express = require('express');
let router = express.Router();
let bodyParser = require('body-parser')
const asyncHandler = require('../../util/asyncNative.js').expressAsyncHandler

let AM2 = require('../../alarm/AlarmManager2.js');
let am2 = new AM2();

router.get('/list', (req, res, next) => {
  am2.loadActiveAlarms((err, list) => {
    if(err) {
      res.status(500).send('');
    } else {
      res.json({list: list});
    }
  });
});

router.get('/archive_list', (req, res, next) => {
  (async() => {
    let alarms = await am2.loadArchivedAlarms()
    res.json({list: alarms})
  })().catch((err) => {
    res.status(500).send('');
  })
});

router.get('/:id', asyncHandler(async (req, res, next) => {
  const alarmID = req.params.id;

  const basic = await am2.getAlarm(alarmID)
  const detail = await am2.getAlarmDetail(alarmID)
  res.json(Object.assign(basic, detail || {}))
}))

// create application/json parser 
let jsonParser = bodyParser.json()

router.post('/create',
            jsonParser,
            (req, res, next) => {
              am2.createAlarmFromJson(req.body, (err, alarm) => {
                if(err) {
                  log.error(err)
                  res.status(400).send("Invalid alarm data");
                  return;
                }

                am2.checkAndSave(alarm, (err, alarmID) => {
                  if(err) {
                    log.error(err)
                    res.status(500).send('Failed to create json: ' + err);
                  } else {
                    res.status(201).json({alarmID:alarmID});
                  }
                });
              });
            });

module.exports = router;
