/*    Copyright 2020 Firewalla Inc.
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
const publicsuffixlist = require('./publicsuffixlist');
const punycode = require('punycode');
const f = require('../../net2/Firewalla.js');
const fs = require('fs');
let instance = null;

class SuffixList {
    constructor() {
        if (instance === null) {
            instance = this;
            // Suffix list downloaded from https://publicsuffix.org/list/public_suffix_list.dat
            // TODO: suffix list should update schedulely
            const suffixData = fs.readFileSync(`${f.getFirewallaHome()}/vendor_lib/publicsuffixlist/public_suffix_list.dat`, 'utf8');
            publicsuffixlist.parse(suffixData, punycode.toASCII);
            this.getDomain = publicsuffixlist.getDomain.bind(publicsuffixlist);
        }
        return instance;
    }
}

module.exports = new SuffixList();