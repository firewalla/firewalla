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

var SysManager = require('../../net2/SysManager.js');
var sysManager = new SysManager('info');

let sysInfo = require('../../extension/sysinfo/SysInfo.js');

let zlib = require('zlib');

/* system api */
router.get('/info', 
//    passport.authenticate('bearer', { session: false }),
           function(req, res, next) {             
             res.json({
               ip_address: sysManager.myIp(),
               mac_address: sysManager.myMAC(),
               gateway: sysManager.myGateway(),
               subnet: sysManager.mySubnet(),
               dns: sysManager.myDNS(),
               ddns: sysManager.myDDNS(),
             });
           });

router.get('/status',
           (req, res, next) => {
             let HostManager = require('../../net2/HostManager.js');
             let hm = new HostManager('system_api', 'client', 'info');
             let compressed = req.query.compressed;

             hm.toJson(true, (err, json) => {               
               if(err) {
                 res.status(500).send({error: err});
                 return;
               }

               if(compressed) {
                 let jsonString = JSON.stringify(json);
                 zlib.deflate(new Buffer(jsonString, 'utf8'), (err, output) => {
                   if(err) {
                     res.status(500).send({error: err});
                     return;
                   }

                   res.json({
                     payload: output.toString('base64')
                   });
                 });
               } else {
                 res.json(json);
               }

             });
           });

router.get('/flow',
    function(req, res, next) {
        
    });

router.get('/perfstat',
          function(req, res, next) {
            sysInfo.getPerfStats((err, stat) => {
              if(err) {
                res.status(500);
                res.send('server error');
                return;
              }
              
              res.json(stat);
            });
          });

module.exports = router;
