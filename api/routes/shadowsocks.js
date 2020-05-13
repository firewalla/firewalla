/*    Copyright 2018-2019 Firewalla INC
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

var express = require('express');
const passport = require('passport')
var router = express.Router();

var shadowsocks = require('../../extension/shadowsocks/shadowsocks.js');
var ss = new shadowsocks('info');

/* shadowsocks api */
router.get('/config', 
    passport.authenticate('bearer', { session: false }),
    function(req, res, next) {
        res.json(
            ss.readConfig()
        );
    });

router.post('/config/renew', 
    passport.authenticate('bearer', { session: false }),
    function(req, res, next) {
        ss.refreshConfig();
        res.status(200).send('');
    });

router.post('/nat/:action', 
    passport.authenticate('bearer', { session: false }),
    function(req, res, next) {
        res.send(req.params.action);
    });

router.post('/:action', 
    passport.authenticate('bearer', { session: false }),
    function(req, res, next) {
        var action = req.params.action;
        if (action === "start") {
            ss.start(function(err, result) {
                if(err) {
                    res.json(err);
                } else {
                    res.json(result);
                }
            });
        } else if (action === "stop") {
            ss.stop(function(err, result) {
                if(err) {
                    res.json(err);
                } else {
                    res.json(result);
                }
            });
        }
    });

module.exports = router;
