'use strict';
var _ = require('underscore');
var chai = require('chai');
var expect = chai.expect;

let FlowManager = require('../net2/FlowManager.js');
let flowManager = new FlowManager();

flowManager.recordLast24HoursStats(new Date() / 1000 - 7200, 123450001, 678900001)
  .then(() => {
    console.log("finished record hourly stats");
  });


let stats = {
  3: '{"bytes":12345000,"ts":1494817200}',
  4: '{"bytes":12345000,"ts":1494820800}'
};

let orderedStats = flowManager.getOrderedStats(stats);
expect(orderedStats[1494817200] === 12345000).to.be.true;
expect(orderedStats[1494820800] === 12345000).to.be.true;
console.log(orderedStats);

let flow1 = {};
flow1[1494817200] = 1234;
flow1[1494820800] = 4000;
let flow2 = {};
flow2[1494817200] = 1234;
flow2[1494820800] = 4000;

let sum = flowManager.sumFlows([flow1, flow2]);
expect(sum[1494817200] === 2468).to.be.true;
expect(sum[1494820800] === 8000).to.be.true;

console.log(flowManager.flowToLegacyFormat(sum));

setTimeout(() => process.exit(0), 3000);

     
