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

'use strict';

const log = require("../../net2/logger.js")(__filename, "info");

const express = require('express');
const router = express.Router();

const sysManager = require('../../net2/SysManager.js');

const sysInfo = require('../../extension/sysinfo/SysInfo.js');

const zlib = require('zlib');

const Firewalla = require('../../net2/Firewalla.js');

const NetBotTool = require('../../net2/NetBotTool');
const netBotTool = new NetBotTool();

const flowTool = require('../../net2/FlowTool');


/* system api */
router.get('/info',
//    passport.authenticate('bearer', { session: false }),
           function(req, res, next) {
             res.json({
               ip_address: sysManager.myDefaultWanIp(),
               mac_address: sysManager.mySignatureMac(),
               gateway: sysManager.myDefaultGateway(),
               subnet: sysManager.getDefaultWanInterface() && sysManager.mySubnet(sysManager.getDefaultWanInterface().name),
               dns: sysManager.myDefaultDns(),
               ddns: sysManager.myDDNS(),
               info: sysInfo.getSysInfo()
             });
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
    flowTool.prepareRecentFlows(json, {
      begin: begin,
      end: end
    }).then(() => {
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

router.get('/heapdump',
  (req, res, next) => {
    let process = req.query.process;

    process = process || "FireApi";

    let file = Firewalla.getTempFolder() + "/" + process + "-heapdump-" + new Date() /1000 + ".heapsnapshot";

    switch(process) {
      case "FireApi":
        sysInfo.getHeapDump(file, (err, file) => {
          if(err) {
            res.status(500);
            res.send('server error: ' + err);
            return;
          }

          res.download(file);
        });

        break;
      case "FireMain":
      case "FireMon":
        const sclient = require('../../util/redis_manager.js').getSubscriptionClient()
        const pclient = require('../../util/redis_manager.js').getPublishClient()

        sclient.on("message", (channel, message) => {
          if(channel === "heapdump_done" && message ) {
            try {
              let msg = JSON.parse(message);
              let file = msg.file;
              let title = msg.title;
              if(title === process) {
                res.download(file);
              }
            } catch (err) {
              log.error("Failed to parse payload of heapdump_done message: ", message, err);
            }
          }
        });
        sclient.subscribe("heapdump_done");
        pclient.publish("heapdump", JSON.stringify({
          title: process,
          file: file
        }));

        break;
      default:
        res.status(404).send("");
    }


  });

module.exports = router;
