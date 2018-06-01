#!/usr/bin/env node
/*    Copyright 2016 Firewalla LLC / Firewalla LLC
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

const instance = null;
const log = require("../../net2/logger.js")(__filename);

let alexa = null

async function getRank(domain) {
  if(!alexa) {
    alexa = require('alexarank');
  }
  
  if(alexa) {
    return new Promise((resolve, reject) => {
      alexa(domain, (err, result) => {
        if (!err) {
          if(result && result.rank) {
            resolve(result.rank);
          } else {
            resolve(null);  
          }
        } else {
          log.error(`Failed to get alexa info for domain ${domain}, err: ${err}`);
          reject(err);
        }
      });
    })
  } else {
    return null;
  }
}

module.exports = {
  getRank: getRank
};
