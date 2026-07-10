/*    Copyright 2016-2026 Firewalla Inc.
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

const chai = require('chai');
const expect = chai.expect;

const ControllerBot = require('../lib/ControllerBot.js');

// ignoreRecordTracelog does not use `this`, so it can be exercised via the prototype
// without constructing a full ControllerBot (which needs eptcloud/config/groups).
const ignoreRecordTracelog = (data) => ControllerBot.prototype.ignoreRecordTracelog.call({}, data);

describe('Test ControllerBot.ignoreRecordTracelog', function () {
  const mac = "FA:21:C1:54:36:CC";

  describe('fwapc/dap GET or no method', () => {
    it('should ignore fwapc GET', () => {
      expect(ignoreRecordTracelog({ item: "fwapc", value: { method: "GET", path: "/v1/status/ap" } })).to.be.true;
    });

    it('should ignore dap GET', () => {
      expect(ignoreRecordTracelog({ item: "dap", value: { method: "GET", path: "/anything" } })).to.be.true;
    });

    it('should ignore fwapc with no method (defaults to GET)', () => {
      expect(ignoreRecordTracelog({ item: "fwapc", value: { path: "/v1/status/ap" } })).to.be.true;
    });

    it('should ignore lower-case get', () => {
      expect(ignoreRecordTracelog({ item: "fwapc", value: { method: "get", path: "/v1/status/ap" } })).to.be.true;
    });
  });

  describe('read-only style POSTs are ignored', () => {
    const skipCases = [
      `/v1/station_history/${mac}/stats`,
      `/v1/station_history/${mac}/radio`,
      `/v1/station_history/${mac}/preferred_prop`,
      `/v1/config/validate`,
      `/v1/convert_integrated_ap_config`,
      `/v1/control/ping/some-uid-123`,
    ];
    for (const path of skipCases) {
      it(`should ignore POST ${path}`, () => {
        expect(ignoreRecordTracelog({ item: "fwapc", value: { method: "POST", path } })).to.be.true;
      });
    }

    it('should ignore for dap item as well', () => {
      expect(ignoreRecordTracelog({ item: "dap", value: { method: "POST", path: `/v1/station_history/${mac}/stats` } })).to.be.true;
    });

    it('should ignore lower-case post method', () => {
      expect(ignoreRecordTracelog({ item: "fwapc", value: { method: "post", path: "/v1/config/validate" } })).to.be.true;
    });

    it('should ignore when path has a query string', () => {
      expect(ignoreRecordTracelog({ item: "fwapc", value: { method: "POST", path: "/v1/control/ping/uid?foo=1" } })).to.be.true;
    });

    it('should ignore when path has no v1 prefix', () => {
      expect(ignoreRecordTracelog({ item: "fwapc", value: { method: "POST", path: `station_history/${mac}/stats` } })).to.be.true;
    });
  });

  describe('config-changing POSTs are recorded (not ignored)', () => {
    const keepCases = [
      `/v1/control/monitor/${mac}`,
      `/v1/station_history/${mac}`,
      `/v1/config/apply`,
      `/v1/station_history/${mac}/stats/extra`,
    ];
    for (const path of keepCases) {
      it(`should NOT ignore POST ${path}`, () => {
        expect(ignoreRecordTracelog({ item: "fwapc", value: { method: "POST", path } })).to.be.false;
      });
    }
  });

  describe('non fwapc/dap and malformed input', () => {
    it('should not ignore a non fwapc/dap item', () => {
      expect(ignoreRecordTracelog({ item: "policy", value: { method: "GET" } })).to.be.false;
    });

    it('should not ignore when data is null', () => {
      expect(ignoreRecordTracelog(null)).to.be.false;
    });

    it('should not ignore when value is missing', () => {
      expect(ignoreRecordTracelog({ item: "fwapc" })).to.be.false;
    });

    it('should not ignore a POST without a matching path', () => {
      expect(ignoreRecordTracelog({ item: "fwapc", value: { method: "POST", path: "/v1/config/apply" } })).to.be.false;
    });
  });
});
