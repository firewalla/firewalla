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

let PM2 = require('../../alarm/PolicyManager2.js');
let pm2 = new PM2();

let AM2 = require('../../alarm/AlarmManager2');
let am2 = new AM2();


const async = require('asyncawait/async')
const await = require('asyncawait/await')

router.get('/list', (req, res, next) => {
  pm2.loadActivePolicys((err, list) => {
    if(err) {
      res.status(500).send('');
      return;
    } else {

      let alarmIDs = list.map((p) => p.aid);

      am2.idsToAlarms(alarmIDs, (err, alarms) => {
        if(err) {
          log.error("Failed to get alarms by ids:", err, {});
          res.status(500).send('');
          return;
        }

        for(let i = 0; i < list.length; i ++) {
          if(list[i] && alarms[i]) {
            list[i].alarmMessage = alarms[i].localizedInfo();
            list[i].alarmTimestamp = alarms[i].timestamp;
          }
        }

        res.json({list: list});
      });
    }
  });
});

router.get('/:policy', (req, res, next) => {
  let policyID = req.params.policy;

  pm2.getPolicy(policyID)
    .then((policy) => res.json(policy))
    .catch((err) => res.status(400).send(err + ""));
});


// create application/json parser
let jsonParser = bodyParser.json()

router.post('/create',
            jsonParser,
            (req, res, next) => {
              pm2.createPolicyFromJson(req.body, (err, policy) => {
                if(err) {
                  res.status(400).send("Invalid policy data");
                  return;
                }

                pm2.checkAndSave(policy, (err, policyID) => {
                  if(err) {
                    res.status(500).send('Failed to create json: ' + err);
                  } else {
                    res.status(201).json({policyID:policyID});
                  }
                });
              });
            });

router.post('/create/ip_port',
            (req, res, next) => {
              let ip = req.query.ip;
              let protocol = req.query.protocol;
              let port = req.query.port;
              let name = req.query.name;

              let json = {
                target: ip,
                target_protocol: protocol,
                target_port: port,
                target_name: name,
                type: "ip_port"
              };

              pm2.createPolicyFromJson(json, (err, policy) => {
                if(err) {
                  res.status(400).send("Invalid policy data");
                  return;
                }

                pm2.checkAndSave(policy, (err, policyID) => {
                  if(err) {
                    res.status(400).send('Failed to create json: ' + err);
                  } else {
                    res.status(201).json({policyID:policyID});
                  }
                });
              });
            });


router.delete('/:policy',
            (req, res, next) => {
              let id = req.params.policy;

              pm2.disableAndDeletePolicy(id)
                .then(() => {
                  res.status(200).json({status: "success"});
                }).catch((err) => {
                  res.status(400).send('Failed to delete policy: ' + err);
                });
            });

router.post('/:policy/enable',
  (req, res, next) => {
    let id = req.params.policy;

    return async(() => {
      let policy = await (pm2.getPolicy(id))
      await (pm2.enablePolicy(policy))
      res.status(200).json({status: "success"});
    })().catch((err) => {
      res.status(400).send('Failed to enable policy: ' + err);
    })
  })

router.post('/:policy/disable',
  (req, res, next) => {
    let id = req.params.policy;

    return async(() => {
      let policy = await (pm2.getPolicy(id))
      await (pm2.disablePolicy(policy))
      res.status(200).json({status: "success"});
    })().catch((err) => {
      res.status(400).send('Failed to disable policy: ' + err);
    })
  })

module.exports = router;
