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

let HostManager = require('../../net2/HostManager.js');
let hostManager = new HostManager();

let FlowManager = require('../../net2/FlowManager.js');
let flowManager = new FlowManager();

// router.get('/list', (req, res, next) => {
//   am2.loadActiveAlarms((err, list) => {
//     if(err) {
//       res.status(500).send('');
//     } else {
//       res.json({list: list});
//     }  
//   });
// });

// create application/json parser 
// let jsonParser = bodyParser.json()

// router.post('/create',
//             jsonParser,
//             (req, res, next) => {
//               am2.createAlarmFromJson(req.body, (err, alarm) => {
//                 if(err) {
//                   res.status(400).send("Invalid alarm data");
//                   return;
//                 }
                
//                 am2.checkAndSave(alarm, (err, alarmID) => {
//                   if(err) {
//                     res.status(500).send('Failed to create json: ' + err);
//                   } else {
//                     res.status(201).json({alarmID:alarmID});
//                   }
//                 });
//               });
//             });

router.get('/:host',
           (req, res, next) => {
             let host = req.params.host;

             if(host === "system") {
               hostManager.toJson(true, (err, json) => {
                 if(err) {
                   res.status(500).send("");
                   return;
                 } else {
                   res.json(json);
                   return;
                 }
               });
             } else {
               hostManager.getHost(host, (err, h) => {
                 flowManager.getStats2(h).then(() => {
                   res.json(h.toJson());
                 }).catch((err) => {
                   res.status(404);
                   res.send("");
                 });
               });
             }
           });

module.exports = router;
