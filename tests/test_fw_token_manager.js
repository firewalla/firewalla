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

let chai = require('chai');
let should = chai.should;
let expect = chai.expect;
let assert = chai.assert;

let Bootstrap = require('../net2/Bootstrap');

let redis = require('redis');
let rclient = redis.createClient();

let license = require('../util/license');

let sample = require('./sample_data');
let intelSample = require('./sample_data_intel');

let Promise = require('bluebird');

const tokenManager = require('../util/FWTokenManager.js');

const sampleKeyFolder = `${__dirname}/sample_keys`;
tokenManager.localFolder = sampleKeyFolder;

describe('FWTokenManager', function () {
  it('should load local keys successfully', async () => {
    const contents = await tokenManager.loadLocalPublicKeys();
    expect(contents).to.be.not.null;
    expect(contents.length).to.equal(3);
  });

  it('should verify if token is valid with pub keys', async () => {
    await tokenManager.loadPubKeys();
    const result = tokenManager.verify("eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJpZCI6IjFpbXpCVEViUDR6T2h5X0c5ZWdkTWciLCJwcm9kdWN0aW9uIjpmYWxzZSwiaXNzIjoiZmlyZXdhbGxhLmNvbSIsImxpY2Vuc2UiOiJ7XCJPUkdcIjpcImZpcmV3YWxsYVwiLFwiTE9DQVRJT05cIjpcInVzYVwiLFwiTFZFUlNJT05cIjpcIjEuMFwiLFwiQlZFUlNJT05cIjpcIjEuMFwiLFwiQVBQSURcIjpcImNvbS5yb3R0aWVzb2Z0LnBpXCIsXCJBUFBTRUNSRVRcIjpcIjQxMzdmMWQ3LWYyOGUtNDY5ZS1iMDQ1LTcwZTFkMzkzY2E0YlwiLFwiVVVJRFwiOlwiNmIyZTM3NzItZjI3NC00ZjllLTkzMDQtMDU4OTJiODU3MGZmXCIsXCJTVVVJRFwiOlwiNmIyZTM3NzJcIixcIkxJQ0VOU0VcIjpcIkEwXCIsXCJMSURcIjpcImY1NzkyNDNhLTBmZjUtNGJmZi05ZjE3LWUzMzZlNDA1NDZhM1wiLFwiTUFDXCI6XCIwMjo4MTo2NDoxZjo0YzpjMlwiLFwiU0VSSUFMXCI6XCIyYzAwMDgxNjQxZjRjYzJcIixcIlRTXCI6MTUzNTg5ODE4NCxcIkVJRFwiOlwiMWltekJURWJQNHpPaHlfRzllZ2RNZ1wifSIsImlhdCI6MTUzNjcwNzcyMywiZXhwIjoxNTM2Nzk0MTIzfQ.aNWMyw0kxodHoqv-fk4xfQPZ8eKKeUURTVX8HK7objX-K0YV2bHmPj-TIzZ559EpnZkVto5Bpclzmu9mXhRCmAcm5wF1wsYo9sZJTy0h61EWaBhmPFxfxrJFWGMHfIa0FWlFDKlujShUkp7DvFVj5CFXZ0LpKA8ImrJ1cJbVY6_BXkzkwOlzw_TaHQ5AasVHZcUEN-vMFVwDiTG9YBf60rStxPX11ZUkMaHRJLfF61l-_KE6hs8DX3Hd-A3sQWGyybJbJWbMh9s-fYFwvVG-srV2Q9nr7ZwxMQrk7uL9i1dk9OiirCLvuplg1cJsFBnb19XErJ3L8qy0e6AwPrxIsw");
    console.log(result);
  });
});
