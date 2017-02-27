#!/bin/env node
'use strict'

let hash = require('../util/Hashes.js');
let util = require('util');
let argv = require('minimist')(process.argv.slice(2));
let blackholeIP = "198.51.100.99";

let domains = argv._;

domains.forEach((domain) => {
  if(!domain.endsWith("/")) {
    domain = domain + "/";
  }
  
  let hashedDomain = hash.getHashObject(domain).hash.toString('base64');
  let output = util.format("hash-address=/%s/%s", hashedDomain.replace(/\//g, '.'), blackholeIP);
  console.log(output);
});



