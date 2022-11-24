const nat = require('../nat-upnp');
const util = require('util')

var client = exports;

function Client(opts) {
  this.ssdp = nat.ssdp.create(opts);
  this.timeout = 1800;
}

client.create = function create(opts) {
  return new Client(opts);
};

function normalizeOptions(options) {
  function toObject(addr) {
    if (typeof addr === 'number') return { port: addr };
    if (typeof addr === 'string' && !isNaN(addr)) return { port: Number(addr) };
    if (typeof addr === 'object') return addr;

    return {};
  }

  return {
    remote: toObject(options.public),
    internal: toObject(options.private)
  };
}

Client.prototype.portMapping = function portMapping(options, callback) {
  if (!callback) callback = function() {};

  this.findGateway(function(err, gateway, address) {
    if (err) return callback(err);

    var ports = normalizeOptions(options);
    var ttl = 60 * 30;
    if (typeof options.ttl === 'number') { ttl = options.ttl; }
    if (typeof options.ttl === 'string' && !isNaN(options.ttl)) { ttl = Number(options.ttl); }

    gateway.run('AddPortMapping', [
      [ 'NewRemoteHost', ports.remote.host ],
      [ 'NewExternalPort', ports.remote.port ],
      [ 'NewProtocol', options.protocol ?
          options.protocol.toUpperCase() : 'TCP' ],
      [ 'NewInternalPort', ports.internal.port ],
      [ 'NewInternalClient', ports.internal.host || address ],
      [ 'NewEnabled', 1 ],
      [ 'NewPortMappingDescription', options.description || 'node:nat:upnp' ],
      [ 'NewLeaseDuration', ttl ]
    ], callback);
  });
};

Client.prototype.portUnmapping = function portMapping(options, callback) {
  if (!callback) callback = function() {};

  this.findGateway(function(err, gateway/*, address*/) {
    if (err) return callback(err);

    var ports = normalizeOptions(options);

    gateway.run('DeletePortMapping', [
      [ 'NewRemoteHost', ports.remote.host ],
      [ 'NewExternalPort', ports.remote.port ],
      [ 'NewProtocol', options.protocol ?
          options.protocol.toUpperCase() : 'TCP' ]
    ], callback);
  });
};

Client.prototype.getMappings = function getMappings(options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = null;
  }

  if (!options) options = {};

  this.findGateway(function(err, gateway, address) {
    if (err) return callback(err);
    var i = 0;
    var end = false;
    var results = [];

    const asyncGatewayRun = util.promisify(gateway.run).bind(gateway);

    (async () => {
      while (!end) {

        let data
        try {
          data = await asyncGatewayRun('GetGenericPortMappingEntry', [
            [ 'NewPortMappingIndex', i++ ]
          ])
        } catch(err) {
          // If we got an error on index 0, ignore it in case this router starts indicies on 1
          if (i !== 1) {
            end = true;
          }
          break
        }

        if(data === null || data === undefined) {
          continue
        }

        try {
          var key;
          var match = Object.keys(data).some(function(k) {
            if (!/:GetGenericPortMappingEntryResponse/.test(k)) return false;

            key = k;
            return true;
          });

          // skip if there is no response in the payload
          if(!match) {
            continue
          }

          data = data[key];

          var result = {
            public: {
              host: typeof data.NewRemoteHost === 'string' &&
              data.NewRemoteHost || '',
              port: parseInt(data.NewExternalPort, 10)
            },
            private: {
              host: data.NewInternalClient,
              port: parseInt(data.NewInternalPort, 10)
            },
            protocol: data.NewProtocol.toLowerCase(),
            enabled: data.NewEnabled === '1',
            description: data.NewPortMappingDescription,
            ttl: parseInt(data.NewLeaseDuration, 10)
          };
          result.local = result.private.host === address;

          results.push(result);
        } catch(e) {
        }
      }

      if (options.local) {
        results = results.filter(function(item) {
          return item.local;
        });
      }

      if (options.description) {
        results = results.filter(function(item) {
          if (typeof item.description !== 'string')
            return;

          if (options.description instanceof RegExp) {
            return item.description.match(options.description) !== null;
          } else {
            return item.description.indexOf(options.description) !== -1;
          }
        });
      }

      callback(null, results)
    })().catch(err => {
      callback(err);
    })
  });
};

Client.prototype.externalIp = function externalIp(callback) {
  this.findGateway(function(err, gateway/*, address*/) {
    if (err) return callback(err);
    gateway.run('GetExternalIPAddress', [], function(err, data) {
      if (err) return callback(err);
      var key;

      if (data) {
        Object.keys(data).some(function(k) {
          if (!/:GetExternalIPAddressResponse$/.test(k)) return false;

          key = k;
          return true;
        });
      }

      if (!key) return callback(Error('Incorrect response'));
      callback(null, data[key].NewExternalIPAddress);
    });
  });
};

Client.prototype.findGateway = function findGateway(callback) {
  var timeout;
  var timeouted = false;
  var p = this.ssdp.search(
        'urn:schemas-upnp-org:device:InternetGatewayDevice:1'
      );

  timeout = setTimeout(function() {
    timeouted = true;
    p.emit('end');
    callback(new Error('timeout'));
  }, this.timeout);

  p.on('device', function (info, address) {
    if (timeouted) return;
    p.emit('end');
    clearTimeout(timeout);

    // Create gateway
    if (info.location)
      callback(null, nat.device.create(info.location), address);
  });
};

Client.prototype.close = function close() {
  this.ssdp.close();
};
