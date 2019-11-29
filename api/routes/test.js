/*    Copyright 2016 Firewalla INC
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

/*
 *
 *  Various test routines that may be used to test the system
 * 
 *  /get: test get speed from firewalla.  input &size:
 *
 */

'use strict';

let express = require('express');
let router = express.Router();

router.get('/get',
  (req, res, next) => {
    let size = 1024*1024*2;
    let ts = (new Date())/1000;
    if (req.param('size')) {
      let _size = Number(req.param('size'));
      if (_size > 0 && _size< (1024*1024*5) ) {
         size = _size; 
      }
    }
    let pattern = "FIREWALLAFIREWALLAFIREWALLA";
    let data = "";
    while (data.length<size) {
       data += pattern;
    }
    
    res.status(200).send({delta:(new Date()/1000-ts), size: data.length, data:data});
  });



module.exports = router;
