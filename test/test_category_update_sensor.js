/*    Copyright 2016-2024 Firewalla Inc.
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

let chai = require('chai');
let expect = chai.expect;
const bone = require('../lib/Bone.js');
const rclient = require('../util/redis_manager.js').getRedisClient();

const CategoryUpdateSensor = require('../sensor/CategoryUpdateSensor.js');

describe('Test category update sensor', function(){
    this.timeout(30000);
    before(async () => {
      this.sensor = new CategoryUpdateSensor();
      bone.setEndpoint(await rclient.getAsync('sys:bone:url'));
      const jwt = await rclient.getAsync('sys:bone:jwt');
      bone.setToken(jwt);
    })

    it('should get category hashset', async () => {
      expect(this.sensor.getCategoryHashset('porn_bf')).to.be.equal("app.porn_bf");
      expect(this.sensor.getCategoryHashset('games')).to.be.equal("app.gaming");
      expect(this.sensor.getCategoryHashset('games_bf')).to.be.equal("app.games_bf");
      expect(this.sensor.getCategoryHashset('av')).to.be.equal("app.video");
      expect(this.sensor.getCategoryHashset('av_bf')).to.be.equal("app.av_bf");
    });

    it('should update category', async () => {
      await this.sensor.updateCategory('porn_bf');
      await this.sensor.updateCategory('porn');
      await this.sensor.updateCategory('av_bf');
      await this.sensor.updateCategory('av');
      await this.sensor.updateCategory('games_bf');
      await this.sensor.updateCategory('games');
    });


  });