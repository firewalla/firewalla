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

let EM = require('../../alarm/ExceptionManager.js');
let em = new EM();

let AM2 = require('../../alarm/AlarmManager2');
let am2 = new AM2();

router.get('/list', (req, res, next) => {
  em.loadExceptions((err, list) => {
    if(err) {
      res.status(500).send('');
    } else {
      let alarmIDs = list.map((p) => p.aid);

      am2.idsToAlarms(alarmIDs, (err, alarms) => {
        if (err) {
          log.error("Failed to get alarms by ids:", err);
          reject(err);
          return;
        }
        
        for (let i = 0; i < list.length; i++) {
          if (list[i] && alarms[i]) {
            list[i].alarmMessage = alarms[i].localizedInfo();
            list[i].alarmTimestamp = alarms[i].timestamp;
          }
        }

        res.json({list: list});
      });
    }  
  });
});

router.get('/:exception', (req, res, next) => {
  let exceptionID = req.params.exception;

  em.getException(exceptionID)
    .then((exception) => res.json(exception))
    .catch((err) => res.status(400).send(err + ""));
});


// create application/json parser 
let jsonParser = bodyParser.json()

router.post('/create',
            jsonParser,
            (req, res, next) => {
              em.createExceptionFromJson(req.body, (err, exception) => {
                if(err) {
                  res.status(400).send("Invalid exception data");
                  return;
                }
                
                em.saveException(exception, (err, exceptionID) => {
                  if(err) {
                    res.status(500).send('Failed to create json: ' + err);
                  } else {
                    res.status(201).json({exceptionID:exceptionID});
                  }
                });
              });
            });

router.post('/delete',
            (req, res, next) => {
              let id = req.query.id;

              em.deleteException(id)
                .then(() => {
                  res.status(200).json({status: "success"});
                }).catch((err) => {
                  res.status(400).send('Failed to delete exception: ' + err);
                });
            });

router.post('/match',
           (req, res, next) => {
             let alarmID = req.query.alarmID
             let exceptionID = req.query.exceptionID
             
             (async() =>{
               let alarm = await am2.getAlarm(alarmID)
               let exception = await em.getException(exceptionID)
               if(exception.match(alarm)) {
                 res.json({matched: true})
               } else {
                 res.json({matched: false})
               }
             })()
           })

module.exports = router;
