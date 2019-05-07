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

let log = require('../net2/logger.js')(__filename, 'info');

let config = require('../net2/config.js').getConfig();

let hooks = [];

function initHooks() {

  let hookConfigs = config.hooks;

  if(!hookConfigs)
    return;

  Object.keys(hookConfigs).forEach((hookName) => {
    let Hook = require('./' + hookName + '.js');
    let hook = new Hook();
    hook.setConfig(hookConfigs[hookName]);
    hooks.push(hook);
  });
}

function run() {
  hooks.forEach((h) => {
    log.info("Installing Hook:", h.constructor.name);
    h.run()
  });
}

module.exports = {
  initHooks:initHooks,
  run:run
};
