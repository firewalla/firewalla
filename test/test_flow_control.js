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
'use strict'

let _ = require('underscore');
let chai = require('chai');
let expect = chai.expect;
let should = chai.should;
let assert = chai.assert;

let log = require('../net2/logger.js')(__filename, 'info');

let fs = require('fs');
let cp = require('child_process');

let Promise = require('bluebird');

//let Bootstrap = require('../net2/Bootstrap');

let flowControl = require('../util/FlowControl');

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}

function getSimulatedJob(o) {
  return function() {
    return delay(1000)
      .then(() => {
        o.v++;
        return Promise.resolve();
      })
  };
}
describe('FlowControl reload function', function() {
  this.timeout(10000);

  beforeEach((done) => {
    done();
  });

  afterEach((done) => {
    done();
  });

  it('should only run once if one job is scheduled', (done) => {
    let o = {v: 0};

    let job1 = getSimulatedJob(o);

    flowControl.reload(job1)
      .then(() => {
        expect(o.v).to.equal(1);
        done();
      })

  });

  it('should only run twice if two jobs are scheduled at the same time', (done) => {
    let o = {v: 0};

    let job1 = getSimulatedJob(o);

    flowControl.reload(job1)
      .then(() => {
        expect(o.v).to.equal(1);
        done();
      }).catch((err) => {
      assert.fail()
    })

    flowControl.reload(job1)

  })

  it('should only run once if three jobs are scheduled at the same time', (done) => {
    let o = {v: 0};

    let job1 = getSimulatedJob(o);

    flowControl.reload(job1)
      .then(() => {
        expect(o.v).to.equal(1);
        done();
      }).catch((err) => {
      assert.fail()
    })

    flowControl.reload(job1)
    flowControl.reload(job1)

  })

  it('should only run once if multiple jobs are scheduled at the same time', (done) => {
    let o = {v: 0};

    let job1 = getSimulatedJob(o);

    flowControl.reload(job1)
      .then(() => {
        expect(o.v).to.equal(1);
        done();
      }).catch((err) => {
      assert.fail()
    })

    flowControl.reload(job1)
    flowControl.reload(job1)
    flowControl.reload(job1)
    flowControl.reload(job1)
    flowControl.reload(job1)
    flowControl.reload(job1)
  })

  it('should only run twice if a second batch of jobs are scheduled in two seconds', (done) => {
    let o = {v: 0};

    let job1 = getSimulatedJob(o);

    flowControl.reload(job1)
      .catch((err) => {
        log.error("", err, err.stack);
        assert.fail()
      })
      .then(() => {
        expect(o.v).to.equal(2);
      })

    flowControl.reload(job1)
    flowControl.reload(job1)
    flowControl.reload(job1)
    flowControl.reload(job1)
    flowControl.reload(job1)
    flowControl.reload(job1)

    delay(1500)
      .then(() => {
        let job1 = getSimulatedJob(o);

        flowControl.reload(job1)
          .catch((err) => {
            log.error(err);
            assert.fail()
          })
          .then(() => {
            expect(o.v).to.equal(0);
          });

        flowControl.reload(job1)
        flowControl.reload(job1)
        flowControl.reload(job1)
        flowControl.reload(job1)
        flowControl.reload(job1)
        flowControl.reload(job1)
      })

    delay(5000)
      .then(() => {
      expect(o.v).to.equal(2);
      done();
      })
  })

});
