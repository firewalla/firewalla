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
'use strict';

module.exports =  class {
    constructor(name, expirelimit) {
        this.cache = {};
        this.name = name;
        this.expirelimit = expirelimit;
        return this;
    }

    expireCache() {
        let now = new Date()/1000;
        let expiredKeys = [];
        for (let key in this.cache) {
            if (this.cache[key].expire < now) {
                expiredKeys.push(key);
            }
        }
        for (let key in expiredKeys) {
            //console.log("SimpleCache:",this.name," Expiring Key: ",key,this.cache[expiredKeys[key]]);
            delete this.cache[expiredKeys[key]]; 
        }
    }

    insert(key,data) {
        this.cache[key] = {
           'expire':new Date()/1000+this.expirelimit,
           'data': data
        }
        //console.log("SimpleCache:",this.name," inserted ",key,data);
        this.expireCache();
    }

    lookup(key) {
        this.expireCache();
        let obj = this.cache[key];
        //console.log("SimpleCache:",this.name," lookup ",key,obj);
        if (obj) {
            return obj.data;
        }
    }
};
