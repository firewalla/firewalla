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


  if (pathname || search) {
    // url
    return [hostname + '/' + pathname + (search ? ('?' + search) : "")];
  } else {
    // domain name or ip
    const hostnames = getHostnameExpressions(hostname);
    return hostnames.map((hostname) => hostname + "/");
  }
}

module.exports = getLookupExpressions;
