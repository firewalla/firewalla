/*    Copyright 2016-2020 Firewalla Inc.
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

let log = require('../../net2/logger.js')(__filename);

let express = require('express');
let router = express.Router();

let HostManager = require('../../net2/HostManager.js');
let hostManager = new HostManager();

let FlowManager = require('../../net2/FlowManager.js');
let flowManager = new FlowManager();

let FlowTool = require('../../net2/FlowTool');
let flowTool = new FlowTool();

let HostTool = require('../../net2/HostTool');
let hostTool = new HostTool();

let NetBotTool = require('../../net2/NetBotTool');
let netBotTool = new NetBotTool();

router.get('/all',
           (req, res, next) => {
             let json = {};
             hostManager.getHosts(() => {
               hostManager.legacyHostsStats(json)
                 .then(() => {
                   res.json(json);
                 }).catch((err) => {
                   res.status(500).send('');
                 });
             });
           });

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
                 flowManager.getTargetStats(h.o.mac).then((flowsummary) => {
                   h.flowsummary = flowsummary
                   h.loadPolicy((err) => {
                     if(err) {
                       res.status(500).send("");
                       return;
                     }

                     let jsonObj = h.toJson();
                     const options = { mac: h.o.mac }

                     Promise.all([
                       flowTool.prepareRecentFlows(jsonObj, options),
                       netBotTool.prepareTopUploadFlows(jsonObj, options),
                       netBotTool.prepareTopDownloadFlows(jsonObj, options),
                       netBotTool.prepareAppActivityFlows(jsonObj, options),
                       netBotTool.prepareCategoryActivityFlows(jsonObj, options),
                       netBotTool.prepareDetailedFlows(jsonObj, 'app', options),
                       netBotTool.prepareDetailedFlows(jsonObj, 'category', options),
                   ]).then(() => {
                       res.json(jsonObj);
                     });
                   })
                 }).catch((err) => {
                   res.status(404);
                   res.send("");
                 });
               });
             }
           });

router.get('/:host',
  (req, res, next) => {
    let host = req.params.host;


  }
)

router.post('/:host/manualSpoofOn',
           (req, res, next) => {
             let host = req.params.host;
             (async() =>{
               let h = await hostTool.getIPv4Entry(host)
               let mac = h.mac
               await hostTool.updateMACKey({
                 mac: mac,
                 manualSpoof: "1"
               })
               res.json({})
             })().catch((err) => {
             res.status(500).json({error: err});
             })
           })

router.post('/:host/manualSpoofOff',
           (req, res, next) => {
             let host = req.params.host;
             (async() =>{
               let h = await hostTool.getIPv4Entry(host)
               let mac = h.mac
               await hostTool.updateMACKey({
                 mac: mac,
                 manualSpoof: "0"
               })
               res.json({})
             })().catch((err) => {
               res.status(500).json({error: err});
             })
           })


router.get('/:host/recentFlow',
  (req, res, next) => {
    let host = req.params.host;

    flowTool.getRecentOutgoingConnections(host)
      .then((conns) => {
        res.json(conns);
      }).catch((err) => {
      res.status(500).json({error: err});
    })
  });


router.get('/:host/topDownload',
  (req, res, next) => {
    let host = req.params.host;
    let json = {};

    return (async() =>{
      let h = await hostManager.getHostAsync(host);
      let mac = h.o && h.o.mac;
      if(!mac) {
        return;
      }
      await netBotTool.prepareTopDownloadFlows(json, { mac });
    })()
    .then(() => res.json(json))
    .catch((err) => {
      log.error("Got error when calling topDownload:", err);
      res.status(404);
      res.send("");
    })
  });

router.get('/:host/topUpload',
  (req, res, next) => {
    let host = req.params.host;
    let json = {};

    return (async() =>{
      let h = await hostManager.getHostAsync(host);
      let mac = h.o && h.o.mac;
      if(!mac) {
        return;
      }
      await netBotTool.prepareTopUploadFlows(json, { mac });
    })()
    .then(() => res.json(json))
    .catch((err) => {
      log.error("Got error when calling topUpload:", err);
      res.status(404);
      res.send("");
    })
  });

module.exports = router;
