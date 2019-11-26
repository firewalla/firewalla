
/*    Copyright 2016 - 2019 Firewalla INC
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

let instance = null;
const log = require("../../net2/logger.js")(__filename);

const firewalla = require('../../net2/Firewalla.js');

const fHome = firewalla.getFirewallaHome()

const FRP = require('./frp.js')

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}

module.exports = class {
  constructor() {
    if (instance == null) {
      instance = this;
      this.frpSession = {}
    }
    return instance;
  }

  getSupportFRP() {
    if(!this.frpSession.support) {
      this.frpSession.support = new FRP("support")
    }

    return this.frpSession.support
  }

  getVPNRelayFRP() {
    if(!this.frpSession.vpnRelay) {
      let vpnRelay = new FRP("vpnRelay")
      vpnRelay.templateFilename = "vpnRelay.ini.template"
      this.frpSession.vpnRelay = vpnRelay
    }

    return this.frpSession.vpnRelay
  }  

}
