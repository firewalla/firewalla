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

let express = require('express');
const passport = require('passport');
let router = express.Router();

let DNSMASQ = require('../../extension/dnsmasq/dnsmasq.js');
let dnsmasq = new DNSMASQ('info');

/* dnsmasq api */

router.post('/filter/renew',
  passport.authenticate('bearer', { session: false }),
  function(req, res, next) {
    dnsmasq.updateFilter(true)
      .then(result => res.status(200).send(''))
      .catch(err => res.status(500).send(''));
  });

router.post('/iptables/add',
  passport.authenticate('bearer', { session: false }),
  function(req, res, next) {
    dnsmasq.add_iptables_rules()
      .then(result => res.status(200).send(''))
      .catch(err => res.status(500).send(''));
  });

router.post('/iptables/remove',
  passport.authenticate('bearer', { session: false }),
  function(req, res, next) {
    dnsmasq.remove_iptables_rules()
      .then(result => res.status(200).send(''))
      .catch(err => res.status(500).send(''));
  });

router.get('/detail_status',
  passport.authenticate('bearer', {session: false}),
  function (req, res, next) {
    dnsmasq.checkStatus()
      .then(result => res.status(200).send(''))
      .catch(err => {
        console.error('Error when check status:', err);
        res.status(500).send('');
      });
  }
);

router.get('/status',
  passport.authenticate('bearer', {session: false}),
  function (req, res, next) {
    dnsmasq.checkStatus()
      .then(result => res.json({status: result}))
      .catch(err => {
        console.error('Error when check status:', err);
        res.status(500).send('');
      });
  }
);

router.post('/:action',
  passport.authenticate('bearer', { session: false }),
  function(req, res, next) {
    let action = req.params.action;
    if (action === "start") {
      dnsmasq.start(true)
        .then(result => res.status(200).send(''))
        .catch(err => res.status(500).send(''));
    } else if (action === "stop") {
      dnsmasq.stop()
        .then(result => res.status(200).send(''))
        .catch(err => res.status(500).send(''));
    } else if (action === "install") {
      dnsmasq.install((err, result) => {
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
