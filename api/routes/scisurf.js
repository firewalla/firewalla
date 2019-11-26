/*    Copyright 2016 - 2019 Firewalla INC 
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

let ss_client = require('../../extension/ss_client/ss_client.js');

router.get("/config",
           (req, res, next) => {
             ss_client.loadConfig((err, config) => {
               if(err) {
                 res.status(500).send({error: err});
                 return;
               }
               res.json(config);
             });
           });

let jsonParser = bodyParser.json();

router.post("/config",
            jsonParser,
            (req, res, next) => {
              ss_client.saveConfig(req.body, (err) => {
                if(err) {
                  res.status(500).send({error: err});
                  return;
                }
                res.status(200).send('');
              });
            });

module.exports = router;
