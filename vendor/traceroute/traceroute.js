/*
    Reference npm package: https://www.npmjs.com/package/traceroute
*/

'use strict';
const log = require('../../net2/logger.js')(__filename, 'info');
const Child = require('child_process');
const Dns = require('dns');
const Net = require('net');
const f = require('../../net2/Firewalla.js');
const tracerouteBinary = `${f.getFirewallaHome()}/vendor/traceroute/traceroute`;
const internals = {};

module.exports = internals.Traceroute = {};


internals.Traceroute.trace = function (host, callback) {
    Dns.lookup(host.toUpperCase(), (err) => {
        if (err && Net.isIP(host) === 0) {
            return callback(new Error('Invalid host'));
        }
        const command = `${tracerouteBinary}.${f.getPlatform()}`;
        const args = ['-q', 1, '-n', host];
        const traceroute = Child.spawn(command, args);
        const hops = [];
        let destination = null;
        let isDestinationCaptured = false;
        traceroute.stdout.on('data', (data) => {
            let lines = data.toString().split("\n");
            for (const hopData of lines) {
                if (!isDestinationCaptured) {
                    destination = internals.parseDestination(hopData);
                    if (destination !== null) {
                        isDestinationCaptured = true;
                    }
                } else {
                    let hop = internals.parseHop(hopData);
                    hop && hops.push(hop);
                }
            }
        });
        traceroute.on('close', (code) => {
            if (callback) {
                callback(null, hops, destination);
            }
        });
    });
};


internals.parseHop = function (hopData) {
    const regex = /^\s*(\d+)\s+(?:([a-zA-Z0-9:.]+)\s+([0-9.]+\s+ms)|(\*))/;
    const parsedData = new RegExp(regex, '').exec(hopData);
    let result = null;
    if (parsedData !== null) {
        if (parsedData[4] === undefined) {
            result = {
                hop: parseInt(parsedData[1], 10),
                ip: parsedData[2],
                rtt1: parsedData[3]
            };
        }
        else {
            result = {
                hop: parseInt(parsedData[1], 10),
                ip: parsedData[4],
                rtt1: parsedData[4]
            };
        }
    }
    return result;
};
internals.parseDestination = function (data) {
    const regex = /^traceroute\sto\s(?:[a-zA-Z0-9:.]+)\s\(([a-zA-Z0-9:.]+)\)/;
    const parsedData = new RegExp(regex, '').exec(data);
    let result = null;
    if (parsedData !== null) {
        result = parsedData[1];
    }
    return result;
}
