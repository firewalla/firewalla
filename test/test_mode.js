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

var _ = require('underscore');
var chai = require('chai');
var expect = chai.expect;

let log = require('../net2/logger.js')(__filename, 'info');

let Mode = require('../net2/mode.js');

Mode.getSetupMode()
  .then((mode) => {    
    expect(mode).to.equal('spoof');

    Mode.isSpoofModeOn()
      .then((result) => {
        expect(result).to.be.true;

        Mode.dhcpModeOn()
          .then((newMode) => {
            expect(newMode).to.equal('dhcp');

            Mode.isDHCPModeOn()
              .then((result2) => {
                expect(result2).to.be.true;

                Mode.spoofModeOn()
                  .then((newMode2) => {
                    expect(newMode2).to.equal('spoof');
                  });
              });                        
          });
      });
  });


setTimeout(() => {
  process.exit(0);
}, 3000);
