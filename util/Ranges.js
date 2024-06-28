/*    Copyright 2019 Firewalla INC
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

var _ = require('lodash');

function getRangesForNumbers(numbers) {
  return _.reduce(numbers, function(list, item) {
    if (_.isEmpty(list)) {
      return [item];
    }

    var last = _.last(list);
    var initial = _.initial(list);

    if (_.isNumber(last) && last + 1 === item) {
      return initial.concat([[last, item]]);
    } else if (_.isArray(last) && last[1] + 1 === item) {
      return initial.concat([[last[0], item]]);
    }
    
    return list.concat(item);
  }, []);
}

function getNumbersForRanges(ranges) {
  return _.reduce(ranges, function(list, numberOrRange) {
    if (_.isNumber(numberOrRange)) {
      return list.concat([numberOrRange]);
    }

    if (_.isArray(numberOrRange)) {
      return list.concat(_.range(
        numberOrRange[0], 
        numberOrRange[1] + 1
      ));
    } 
  }, []);
}

function formatRanges(ranges) {
  return ranges.map(function(numberOrRange) {
    if (_.isArray(numberOrRange)) {
      return numberOrRange.join('-');
    }
    return numberOrRange;
  }).join(',');
}

function parseRanges(formatted) {
  return formatted.split(',').reduce(function(ranges, formattedSection) {
    var section = formattedSection.split('-');

    if (section.length === 1) {
      var possibleNumber = parseInt(section[0], 10);
      return isNaN(possibleNumber) ? ranges : ranges.concat([possibleNumber]);
    }

    var range = section.map((number) => parseInt(number, 10));
    return ranges.concat([range]);
  }, []);
}


function limitInternalScanResult(tasks, maxResult=100) {
  let count = 0;
  let overlimit = false;
  let limitedTasks = {};
  for (const key in tasks) {
    if ( !tasks[key] || !_.isArray(tasks[key].results)) {
      continue;
    }
    for (let i = 0; i < tasks[key].results.length; i++) {
      if (!tasks[key].results[i].result || !_.isArray(tasks[key].results[i].result)) {
        continue;
      }

      if (count + tasks[key].results[i].result.length >= maxResult) {
        overlimit = true;
        tasks[key].results[i].result = tasks[key].results[i].result.splice(0, maxResult - count);
        tasks[key].results = tasks[key].results.splice(0, i+1);
        break;
      }
      count += tasks[key].results[i].result.length;
    }
    limitedTasks[key] = tasks[key];
    if (overlimit) {
      limitedTasks[key].overlimit = true;
      break;
    }
  }
  return limitedTasks;
}

var Ranges = {
  limitInternalScanResult,
  getRangesForNumbers,
  getNumbersForRanges,
  formatRanges,
  parseRanges
};

module.exports = Ranges;
