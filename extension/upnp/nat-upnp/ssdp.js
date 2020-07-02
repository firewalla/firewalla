var dgram = require('dgram');
var util = require('util');
var os = require('os');
var EventEmitter = require('events').EventEmitter;
var ssdp = exports;

function Ssdp(opts) {
  EventEmitter.call(this);

  this._opts = opts || {};
  this._sourcePort = this._opts.sourcePort || 0;
  this.multicast = '239.255.255.250';
  this.port = 1900;
  this._bound = false;
  this._boundCount = 0;
  this._closed = false;
  this._queue = [];
  this.listenAddr = this._opts.listenAddr || null;
  this.type = this._opts.type || 'udp4';

  // Create sockets on all external interfaces
  this.createSockets();
}
util.inherits(Ssdp, EventEmitter);

ssdp.create = function create(opts) {
  return new Ssdp(opts);
};

Ssdp.parseMimeHeader = function (headerStr) {
  var lines = headerStr.split(/\r\n/g);

  // Parse headers from lines to hashmap
  return lines.reduce(function(headers, line) {
    line.replace(/^([^:]*)\s*:\s*(.*)$/, function (a, key, value) {
      headers[key.toLowerCase()] = value;
    });
    return headers;
  }, {});
};

Ssdp.prototype.createSockets = function createSockets() {
  var self = this;
  var interfaces = os.networkInterfaces();

  if (this.listenAddr) {
    // os.networkInterfaces() will not return interface without carrier, even with an address configured on it
    const socket = self.createSocket(this.listenAddr, this.type);
    this.sockets = [socket];
  } else {
    this.sockets = Object.keys(interfaces).reduce(function(a, key) {
      return a.concat(interfaces[key].filter(function(item) {
        return !item.internal;
      }).map(function(item) {
        return self.createSocket(item.address, item.family === "IPv4" ? 'udp4' : 'udp6');
      }));
    }, []);
  }
};

Ssdp.prototype.search = function search(device, promise) {
  if (!promise) {
    promise = new EventEmitter();
    promise._ended = false;
    promise.once('end', function() {
      promise._ended = true;
    });
  }

  if (!this._bound) {
    this._queue.push({ action: 'search', device: device, promise: promise });
    return promise;
  }

  // If promise was ended before binding - do not send queries
  if (promise._ended) return;

  var self = this;
  var query = Buffer.from('M-SEARCH * HTTP/1.1\r\n' +
                          'HOST: ' + this.multicast + ':' + this.port + '\r\n' +
                          'MAN: "ssdp:discover"\r\n' +
                          'MX: 1\r\n' +
                          'ST: ' + device + '\r\n' +
                          '\r\n');

  // Send query on each socket
  this.sockets.forEach(function(socket) {
    socket.send(query, 0, query.length, this.port, this.multicast);
  }, this);

  function ondevice(info, address) {
    if (promise._ended) return;
    if (info.st !== device) return;

    promise.emit('device', info, address);
  }
  this.on('_device', ondevice);

  // Detach listener after receiving 'end' event
  promise.once('end', function() {
    self.removeListener('_device', ondevice);
  });

  return promise;
};

Ssdp.prototype.createSocket = function createSocket(address, type = "udp4") {
  var self = this;
  var socket = dgram.createSocket({
    type: type,
    reuseAddr: true
  });

  socket.on('message', function (message, info) {
    // Ignore messages after closing sockets
    if (self._closed) return;

    // Parse response
    self.parseResponse(message.toString(), socket.address, info);
  });

  // Bind in next tick (sockets should be me in this.sockets array)
  process.nextTick(function() {
    // Unqueue this._queue once all sockets are ready
    function onready() {
      if (self._boundCount < self.sockets.length) return;

      self._bound = true;
      self._queue.forEach(function(item) {
        return self[item.action](item.device, item.promise);
      });
    }

    socket.on('listening', function() {
      self._boundCount += 1;
      onready();
    });

    // On error - remove socket from list and execute items from queue
    socket.once('error', function() {
      self.sockets.splice(self.sockets.indexOf(socket), 1);
      onready();
    });

    socket.address = address;
    socket.bind(self._sourcePort, address);
  });

  return socket;
};

// TODO create separate logic for parsing unsolicited upnp broadcasts,
// if and when that need arises
Ssdp.prototype.parseResponse = function parseResponse(response, addr, remote) {
  // Ignore incorrect packets
  if (!/^(HTTP|NOTIFY)/m.test(response)) return;

  var headers = Ssdp.parseMimeHeader(response);

  // We are only interested in messages that can be matched against the original
  // search target
  if (!headers.st) return;

  this.emit('_device', headers, addr);
};

Ssdp.prototype.close = function close() {
  this.sockets.forEach(function(socket) {
    socket.close();
  });
  this._closed = true;
};
