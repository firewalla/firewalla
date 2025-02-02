'use strict'

const log = require('../../../net2/logger.js')(__filename);

var util = require('util')
var EventEmitter = require('events').EventEmitter
var serviceName = require('multicast-dns-service-types')
var dnsEqual = require('dns-equal')
var dnsTxt = require('dns-txt')

var TLD = '.local'
var WILDCARD = '_services._dns-sd._udp' + TLD

module.exports = Browser

util.inherits(Browser, EventEmitter)

/**
 * Start a browser
 *
 * The browser listens for services by querying for PTR records of a given
 * type, protocol and domain, e.g. _http._tcp.local.
 *
 * If no type is given, a wild card search is performed.
 *
 * An internal list of online services is kept which starts out empty. When
 * ever a new service is discovered, it's added to the list and an "up" event
 * is emitted with that service. When it's discovered that the service is no
 * longer available, it is removed from the list and a "down" event is emitted
 * with that service.
 */
function Browser (mdns, opts, onup) {
  if (typeof opts === 'function') return new Browser(mdns, null, opts)

  EventEmitter.call(this)

  this._mdns = mdns
  this._onresponse = null
  this._serviceMap = {}
  this._txt = dnsTxt(opts.txt)

  if (!opts || (!opts.type && !opts.protocol)) {
    this._name = WILDCARD
    this._wildcard = true
  } else {
    this._name = serviceName.stringify(opts.type, opts.protocol || 'tcp') + TLD
    if (opts.name) this._name = opts.name + '.' + this._name
    this._wildcard = false
  }

  this.services = []

  if (onup) this.on('up', onup)

  this.start()
}

Browser.prototype.start = function () {
  if (this._onresponse) return

  var self = this

  // List of names for the browser to listen for. In a normal search this will
  // be the primary name stored on the browser. In case of a wildcard search
  // the names will be determined at runtime as responses come in.
  var nameMap = {}
  if (!this._wildcard) nameMap[this._name] = true

  this._onresponse = function (packet, rinfo) {
    if (self._wildcard) {
      packet.answers.forEach(function (answer) {
        if (answer.type !== 'PTR' || answer.name !== self._name || answer.name in nameMap) return
        nameMap[answer.data] = true
        self._mdns.query(answer.data, 'PTR')
      })
    }

    Object.keys(nameMap).forEach(function (name) {
      // unregister all services shutting down
      goodbyes(name, packet).forEach(self._removeService.bind(self))

      // register all new services
      var matches = buildServicesFor(name, packet, self._txt, rinfo)
      if (matches.length === 0) return

      matches.forEach(function (service) {
        if (self._serviceMap[service.fqdn])
          self._updateService(service)
        else
          self._addService(service)
      })
    })
  }

  this._mdns.on('response', this._onresponse)
  this.update()
}

Browser.prototype.stop = function () {
  if (!this._onresponse) return

  this._mdns.removeListener('response', this._onresponse)
  this._onresponse = null
}

Browser.prototype.update = function () {
  this._mdns.query(this._name, 'PTR')
}

function equalTxt(a, b) {
  if (!a && !b) return true
  if (!a || !b) return false
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if(aKeys.length != bKeys.length) return false
  for(let key of aKeys) {
    if(a[key] != b[key]) return false
  }
  return true
}

Browser.prototype._updateService = function (service) {
  const sIndex = this.services.findIndex(s => dnsEqual(s.fqdn, service.fqdn))
  if (sIndex == -1) return

  let shouldUpdate = false
  if (!equalTxt(service.txt, this.services[sIndex].txt))
    shouldUpdate = true
  if (JSON.stringify(service.addresses) != JSON.stringify(service.addresses))
    shouldUpdate = true

  if (shouldUpdate) {
    this.services[sIndex] = service
    this.emit('up', service);
  }
}

Browser.prototype._addService = function (service) {
  this.services.push(service)
  this._serviceMap[service.fqdn] = true
  this.emit('up', service)
}

Browser.prototype._removeService = function (fqdn) {
  var service, index
  this.services.some(function (s, i) {
    if (dnsEqual(s.fqdn, fqdn)) {
      service = s
      index = i
      return true
    }
  })
  if (!service) return
  this.services.splice(index, 1)
  delete this._serviceMap[fqdn]
  this.emit('down', service)
}

// PTR records with a TTL of 0 is considered a "goodbye" announcement. I.e. a
// DNS response broadcasted when a service shuts down in order to let the
// network know that the service is no longer going to be available.
//
// For more info see:
// https://tools.ietf.org/html/rfc6762#section-8.4
//
// This function returns an array of all resource records considered a goodbye
// record
function goodbyes (name, packet) {
  return packet.answers.concat(packet.additionals)
    .filter(function (rr) {
      return rr.type === 'PTR' && rr.ttl === 0 && dnsEqual(rr.name, name)
    })
    .map(function (rr) {
      return rr.data
    })
}

function buildServicesFor (name, packet, txt, referer) {
  var records = packet.answers.concat(packet.additionals).filter(function (rr) {
    return rr.ttl > 0 // ignore goodbye messages
  })

  return records
    .filter(function (rr) {
      return rr.type === 'PTR' && dnsEqual(rr.name, name)
    })
    .map(function (ptr) {
      var service = {
        addresses: []
      }

      for (const rr of records) {
        if (!['SRV', 'TXT'].includes(rr.type)) continue

        const result = serviceName.parse(rr.name)
        if (rr.type == 'SRV' && dnsEqual(rr.name, ptr.data)) {
          service.name = result.instance
          service.fqdn = rr.name
          service.host = rr.data.target || `${result.instance}.${result.domain}`
          service.referer = referer
          service.port = rr.data.port
          service.type = result.name
          service.protocol = result.protocol
          service.subtype = result.subtype
        } else if (rr.type == 'TXT' && (result.name == '_device-info' || dnsEqual(rr.name, ptr.data))) {
          // service.rawTxt = service.rawTxt ? Buffer.concat([service.rawTxt, rr.data]) : rr.data
          service.txt = Object.assign({}, service.txt, txt.decode(rr.data))
        }
      }

      if (!service.name) return

      records
        .filter(function (rr) {
          return (rr.type === 'A' || rr.type === 'AAAA') && service.host && dnsEqual(rr.name, service.host)
        })
        .forEach(function (rr) {
          service.addresses.push(rr.data)
        })

      service.addresses.sort()
      return service
    })
    .filter(function (rr) {
      return !!rr
    })
}
