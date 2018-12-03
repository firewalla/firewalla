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

let proServer = require('../bin/pro');
let tokenManager = require('../middlewares/TokenManager').getInstance();

router.get("/server", (req, res, next) => {
    proServer.startProServer((started) => {
        if (started) {
            res.status(200).send('started');
        } else {
            res.status(400).send('server is already running')
        }
    })
});

router.delete("/server", (req, res, next) => {
    proServer.stopProServer((stopped) => {
        if (stopped) {
            res.status(200).send('stopped');
        } else {
            res.status(400).send('server was not running')
        }
    })
});

router.get("/token/:gid", (req, res, next) => {
    res.status(200).send(tokenManager.getToken(req.params.gid));
});

router.post("/token/:gid", (req, res, next) => {
    res.status(200).send(tokenManager.generateToken(req.params.gid));
});

router.post("/revoke/:gid", (req, res, next) => {
    tokenManager.revokeToken(req.params.gid);
    res.status(204).send('');
});

module.exports = router;