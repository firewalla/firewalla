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

const Tag = require('../net2/Tag.js');
const tagManager = require('../net2/TagManager.js');
const log = require('../net2/logger.js')(__filename);
const rclient = require('../util/redis_manager.js').getRedisClient();



describe('Test InternalScanSensor', function() {
  this.timeout(3000);

  beforeEach((done) => {
    (async() =>{
        const currentTs = Date.now() / 1000;
        tagManager.tags['88']= new Tag({uid: 88, name: '', createTs: currentTs});
        tagManager.tags['99']= new Tag({uid: 99, name: 'tag99', createTs: currentTs});
        await rclient.hsetAsync('policy:tag:88', 'feature1', '{"attr1": "1111"}');
        await rclient.hsetAsync('policy:tag:99', 'feature2', '{');
        done();
    })();
  });

  afterEach((done) => {
    (async() => {
      await rclient.delAsync('policy:tag:88');
      await rclient.delAsync('policy:tag:99');
      done();
    })();
  });

  describe('Test hostManager', async() => {
    it('should get tag', () => {
       expect(tagManager.getTag(88).getUniqueId()).to.be.equal(88);
       expect(tagManager.getTag('tag99').getUniqueId()).to.be.equal(99);
    });

    it('should check has policy', async() => {
       expect(await tagManager.tags['88'].hasPolicyAsync('feature1')).to.be.true;
       expect(await tagManager.tags['88'].hasPolicyAsync('feature2')).to.be.false;
    });

    it('should get policy tags', async() => {
      const tags = await tagManager.getPolicyTags('feature1');
       expect(tags.length).to.be.equal(1);
       expect(tags[0].o.uid).to.be.equal(88);
    });

    it ('should get policy', async() => {
      const feature1 = await tagManager.tags['88'].getPolicyAsync('feature1');
      expect(feature1.attr1).to.be.equal('1111');

      const feature2 = await tagManager.tags['99'].getPolicyAsync('feature1');
      expect(feature2).to.be.null;
    });
  });

});
