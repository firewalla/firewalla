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

'use strict'
var StringCursor = require('./StringCursor');

var PERCENT_ESCAPE = /%([A-Fa-f0-9]{2})/g;
var ESCAPED_CHARCODES = [35, 37];

function hasPercentEscape(url) {
  return PERCENT_ESCAPE.test(url);
}

function getDecodedURI(uri) {
  return uri.replace(PERCENT_ESCAPE, function (match, p1) {
    return String.fromCharCode(parseInt(p1, 16));
  });
}

function getEncodedCharCode(charCode) {
  var hex = charCode.toString(16);
  return hex.length < 2 ? '%0' + hex : '%' + hex;
}

function getEncodedURI(uri) {
  var encodedURI = '';
  for (var i = 0; i < uri.length; i++) {
    var code = uri.charCodeAt(i);
    if (code <= 32 || code >= 127 || ESCAPED_CHARCODES.indexOf(code) !== -1) {
      encodedURI += getEncodedCharCode(code);
    } else {
      encodedURI += uri.charAt(i);
    }
  }
  return encodedURI;
}

function getEntirelyDecodedURI(uri) {
  while (hasPercentEscape(uri)) {
    uri = getDecodedURI(uri);
  }
  return uri;
}

function getCanonicalizedHostname(hostname) {
  return getEncodedURI(
    getEntirelyDecodedURI(hostname.toLowerCase())
      .replace(/^\.+/, '')
      .replace(/\.+$/, '')
      .replace(/\.+/, '.')
  );
}

function getCanonicalizedDomainname(hostname) {
  return hostname.toLowerCase().replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .replace(/\.+/, '.')
    .replace(/[^\w.-]/g, '')
}

function getCanonicalizedPathname(pathname) {
  return getEncodedURI(
    getEntirelyDecodedURI('/' + pathname)
      .replace('/./', '/')
      .replace(/[^\/]+\/\.\./, '')
      .replace(/\/+/, '/')
  );
}

function getCanonicalizedURL(url) {
  url = url.trim();
  url = url.replace(/[\t\r\n]/g, '');

  var cursor = new StringCursor(url);
  var protocol = cursor.chompUntilIfExists(':') || 'http';
  cursor.chompWhile('/');
  var host = cursor.chompUntil('/').split(':');
  var hostname = host[0];
  var port = host[1] || null;

  var localCursor = new StringCursor(cursor.chompRemaining());
  var pathCursor = new StringCursor(localCursor.chompUntil('#'));
  var pathname = pathCursor.chompUntil('#');
  var search = pathCursor.chompRemaining();

  var f = {
    protocol: protocol,
    hostname: getCanonicalizedHostname(hostname),
    port: port,
    pathname: getCanonicalizedPathname(pathname),
    search: search
  };

  return (
    `${f.protocol}://${f.hostname}${f.port ? ':' + f.port : ''}` +
    `${f.pathname}${search ? '?' + search : ''}`
  );
}

module.exports = {
  getCanonicalizedURL: getCanonicalizedURL,
  getCanonicalizedHostname: getCanonicalizedHostname,
  getCanonicalizedDomainname: getCanonicalizedDomainname
};
