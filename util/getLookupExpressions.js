/*    Copyright 2016-2019 Firewalla INC
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

var StringCursor = require('./StringCursor');

var HOSTNAME_IP_PATTERN = /\d+\.\d+\.\d+\.\d+/;
var HOSTNAME_SEPARATOR = '.';
var MAX_HOSTNAME_SEGMENTS = 5;

var PATH_SEPARATOR = '/';
var MAX_PATH_SEGMENTS = 4;

function getHostnameExpressions(hostname) {
  if (HOSTNAME_IP_PATTERN.test(hostname)) {
    return [hostname];
  }

  var baseExpression = hostname
    .split(HOSTNAME_SEPARATOR)
    .reverse()
    .slice(0, MAX_HOSTNAME_SEGMENTS)
    .reverse();

  var numExpressions = Math.min(MAX_HOSTNAME_SEGMENTS, baseExpression.length) - 1;
  var expressions = [hostname];

  for (var i = 0; i < numExpressions; i++) {
    expressions.push(baseExpression.slice(i).join('.'));
  }

  return expressions;
}

function getPathExpressions(pathname, search) {
  var baseExpression = pathname
    .split(PATH_SEPARATOR)
    .slice(0, MAX_PATH_SEGMENTS);
  var numExpressions = Math.min(MAX_PATH_SEGMENTS, baseExpression.length);
  var expressions = [
    pathname + search,
    pathname
  ];

  for (var i = 0; i < numExpressions; i++) {
    expressions.push(baseExpression.slice(0, i).join('/'));
  }

  return expressions.sort();
}

function getLookupExpressions(canonicalized) {
  var cursor = new StringCursor(canonicalized);

  // Drop the scheme.
  cursor.chompUntil(':');
  cursor.skip(2);

  var hostname = cursor.chompUntil('/');
  var pathname = cursor.chompUntil('?');
  var search = cursor.chompRemaining();

  var hostnames = getHostnameExpressions(hostname);
  var paths = getPathExpressions(pathname, search && '?' + search);

  return hostnames.reduce(function(exprs, hostname) {
    return exprs.concat(paths.map((path) => hostname + '/' + path));
  }, []);
}

module.exports = getLookupExpressions;
