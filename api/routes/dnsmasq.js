/**
 * Created by Melvin Tu on 11/01/2017.
 */

'use strict';

let express = require('express');
const passport = require('passport');
let router = express.Router();

let dnsmasq = require('../../extension/dnsmasq/dnsmasq.js');
let d = new dnsmasq('info');

/* dnsmasq api */

router.post('/filter/renew',
  passport.authenticate('bearer', { session: false }),
  function(req, res, next) {
    d.updateFilter(true, (err) => {
      if(err) {
        console.log(err);
        res.status(500).send('');
      } else {
        res.status(200).send('');
      }      
    });

  });

router.post('/iptables/add',
  passport.authenticate('bearer', { session: false }),
  function(req, res, next) {
    d.add_iptables_rules((err, result) => {
      if(err) {
        res.status(500).send('');
      } else {
        res.status(200).send('');
      }
    });
  });

router.post('/iptables/remove',
  passport.authenticate('bearer', { session: false }),
  function(req, res, next) {
    d.remove_iptables_rules((err, result) => {
      if(err) {
        res.status(500).send('');
      } else {
        res.status(200).send('');
      }
    });
  });

router.get('/detail_status',
           passport.authenticate('bearer', { session: false } ),
           function(req, res, next) {
             d.checkStatus((err) => {
               if(err) {
                 console.log("Got error when checking dnsmasq status: ", err);
                 res.status(500).send('');
               } else {
                 res.status(200).send('');
               }               
             });
           }
          );

router.get('/status',
           passport.authenticate('bearer', { session: false } ),
           function(req, res, next) {
             d.checkStatus((result) => {
               res.json({ status: result });
             });
           }
          );

router.post('/:action',
  passport.authenticate('bearer', { session: false }),
  function(req, res, next) {
    var action = req.params.action;
    if (action === "start") {
      d.start(true, (err, result) => {
        if(err) {
          console.log(err);
          res.status(500).send('');
        } else {
          res.status(200).send('');
        }
      });
    } else if (action === "stop") {
      d.stop((err, result) => {
        if(err) {
          console.log(err);
          res.status(500).send('');
        } else {
          res.status(200).send('');
        }
      });
    } else if (action === "install") {
      d.install((err, result) => {
        if(err) {
          console.log(err);
          res.status(500).send('');
        } else {
          res.status(200).send('');
        }
      })
    }
  });

module.exports = router;
