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
router.get('/filter',
  passport.authenticate('bearer', { session: false }),
  function(req, res, next) {
    d.readFilter((err, obj) => {
      res.json(obj);
    });
  });

router.post('/filter/renew',
  passport.authenticate('bearer', { session: false }),
  function(req, res, next) {
    d.updateFilter();
    res.status(200).send('');
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

router.post('/:action',
  passport.authenticate('bearer', { session: false }),
  function(req, res, next) {
    var action = req.params.action;
    if (action === "start") {
      d.start(function(err, result) {
        if(err) {
          res.status(500).send('');
        } else {
          res.status(200).send('');
        }
      });
    } else if (action === "stop") {
      d.stop(function(err, result) {
        if(err) {
          res.status(500).send('');
        } else {
          res.status(200).send('');
        }
      });
    } else if (action === "install") {
      d.install(function(err, result) {
        if(err) {
          res.status(500).send('');
        } else {
          res.status(200).send('');
        }
      })
    }
  });

module.exports = router;
