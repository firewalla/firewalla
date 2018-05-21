var nat = exports;

nat.utils = require('./nat-upnp/utils');
nat.ssdp = require('./nat-upnp/ssdp');
nat.device = require('./nat-upnp/device');
nat.createClient = require('./nat-upnp/client').create;
