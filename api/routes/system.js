/*    Copyright 2016-2025 Firewalla Inc.
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

const log = require("../../net2/logger.js")(__filename, "info");

const express = require('express');
const router = express.Router();

const sysManager = require('../../net2/SysManager.js');

const sysInfo = require('../../extension/sysinfo/SysInfo.js');

const zlib = require('zlib');

const NetBotTool = require('../../net2/NetBotTool');
const netBotTool = new NetBotTool();

const flowTool = require('../../net2/FlowTool');


/* system api */
router.get('/info',
  function(req, res, next) {
    (async() =>{
             res.json({
               ip_address: sysManager.myDefaultWanIp(),
               mac_address: sysManager.mySignatureMac(),
               gateway: sysManager.myDefaultGateway(),
               subnet: sysManager.getDefaultWanInterface() && sysManager.mySubnet(sysManager.getDefaultWanInterface().name),
               dns: sysManager.myDefaultDns(),
               ddns: sysManager.myDDNS(),
               info: await sysInfo.getSysInfo()
             });
    })().catch(err => {
      log.error("Failed to process /info: ", err);
      res.status(500).send({error: err});
    })
  });

router.get('/status',
           (req, res, next) => {
             let HostManager = require('../../net2/HostManager.js');
             let hm = new HostManager();
             let compressed = req.query.compressed;

             hm.toJson(true, (err, json) => {
               if(err) {
                 res.status(500).send({error: err});
                 return;
               }

               if(compressed) {
                 let jsonString = JSON.stringify(json);
                 zlib.deflate(Buffer.from(jsonString, 'utf8'), (err, output) => {
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

router.get('/topDownload',
  (req, res, next) => {
    let now = new Date() / 1000;
    let end = Math.floor(now / 3600) * 3600;
    let begin = end - 3600;
    let json = {};
    netBotTool.prepareTopDownloadFlows(json, {
      begin: begin,
      end: end
    }).then(() => {
      res.json(json);
    }).catch((err) => {
      res.status(500).send({error: err});
    })
  }
);

router.get('/topUpload',
  (req, res, next) => {
    let now = new Date() / 1000;
    let end = Math.floor(now / 3600) * 3600;
    let begin = end - 3600;
    let json = {};
    netBotTool.prepareTopUploadFlows(json, {
      begin: begin,
      end: end
    }).then(() => {
      res.json(json);
    }).catch((err) => {
      res.status(500).send({error: err});
    })
  }
);

router.get('/recent',
  (req, res, next) => {
    let now = new Date() / 1000;
    let end = Math.floor(now / 3600) * 3600;
    let begin = end - 3600;
    let json = {};
    flowTool.prepareRecentFlows({
      begin: begin,
      end: end
    }).then(results => {
      json.flows = { recent: results }
      res.json(json);
    }).catch((err) => {
      res.status(500).send({error: err});
    })
  }
);

router.get('/apps',
  (req, res, next) => {
    let now = new Date() / 1000;
    let end = Math.floor(now / 3600) * 3600;
    let begin = end - 3600;
    let json = {};

    (async() =>{
      await netBotTool.prepareDetailedFlows(json, 'app', {
        begin: begin,
        end: end
      })
      res.json(json)
    })().catch((err) => {
      log.error("Failed to process /apps: ", err, err.stack);
      res.status(500).send({error: err});
    })
  }
);

router.get('/categories',
  (req, res, next) => {
    let now = new Date() / 1000;
    let end = Math.floor(now / 3600) * 3600;
    let begin = end - 3600;
    let json = {};

    (async() =>{
      await netBotTool.prepareDetailedCategoryFlows(json, {
        begin: begin,
        end: end
      })
      res.json(json)
    })().catch((err) => {
      log.error("Failed to process /categories: ", err, err.stack);
      res.status(500).send({error: err});
    })
  }
);

router.get('/perfstat',
          function(req, res, next) {
            sysInfo.getPerfStats().then(stat => {
              res.json(stat);
            }).catch(err => {
              log.error(err);
              res.status(500);
              res.send('server error');
            })
          });

module.exports = router;
