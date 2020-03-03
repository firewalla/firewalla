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

const express = require('express');
const path = require('path');
const router = express.Router();
const bodyParser = require('body-parser')

let cache;

router.get('/empty', function (req, res) {
    res.sendStatus(200);
});

router.post('/empty', function (req, res) {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.set("Cache-Control", "post-check=0, pre-check=0");
    res.set("Pragma", "no-cache");
    res.sendStatus(200);
});

router.get('/garbage', function (req, res) {
//    res.set('Content-Description', 'File Transfer');
//    res.set('Content-Type', 'application/octet-stream');
//    res.set('Content-Disposition', 'attachment; filename=random.dat');
//    res.set('Content-Transfer-Encoding', 'binary');
//    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
//    res.set('Cache-Control', 'post-check=0, pre-check=0', false);
//    res.set('Pragma', 'no-cache');
    const requestedSize = (req.query.ckSize || 100);
    
    const send = () => {
        for (let i = 0; i < requestedSize; i++)
            res.write(cache);
        res.end();
    }
    
    if (cache) {
        send();
    } else {
        require('crypto').randomBytes(1048576, (error, bytes) => {
            cache = bytes;
            send();
        });
    }

});

module.exports = router;
