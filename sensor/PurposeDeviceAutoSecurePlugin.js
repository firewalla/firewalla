/*    Copyright 2016-2025 Firewalla Inc.
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
const PurposeRulePlugin = require('./PurposeRulePlugin.js');

class PurposeDeviceAutoSecurePlugin extends PurposeRulePlugin {
  constructor(config) {
    super(config);
    this.featureName = 'dap';
    this.policyKey = 'dapAdmin';
  }
}

module.exports = PurposeDeviceAutoSecurePlugin;