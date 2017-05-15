'use strict';
var _ = require('underscore');
var chai = require('chai');
var expect = chai.expect;

let FlowManager = require('../net2/FlowManager.js');
let flowManager = new FlowManager();

flowManager.recordLast24HoursStats(new Date() / 1000 + 7200, 123450001, 678900001)
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

setTimeout(() => process.exit(0), 3000);

     
