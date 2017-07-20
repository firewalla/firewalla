/**
 * Created by Melvin Tu on 05/01/2017.
 */

'use strict';
let _ = require('underscore');
let chai = require('chai');
let expect = chai.expect,
    exec  = require('child_process').exec;

let UPNP = require('../extension/upnp/upnp');
let upnp = new UPNP();

let mappingDescription = "a good port mapping";

upnp.getLocalPortMappings(mappingDescription, (err, results) => {
   console.log(results);
});

console.log("xx2");
upnp.addPortMapping("tcp", 28831, 28831, mappingDescription, (err) => {
    console.log("xx3");
    expect(err).to.equal(undefined);

    // console.log("xx");
    // upnp.hasPortMapping("tcp", 8831, 8831, mappingDescription, (err, result) => {
    //     expect(err).to.equal(null);
    //     expect(result).to.equal(true);
    //
    //     console.log("xx");
    //
    //     upnp.getLocalPortMappings(mappingDescription, (err, results) => {
    //         expect(results.length).to.equal(1);
    //         let r = results[0];
    //         expect(r.public.port).to.equal(8831);
    //         expect(r.private.port).to.equal(8831);
    //         // upnp.removePortMapping("tcp", 8831, 8831, (err) => {
    //         //     expect(err).to.equal(undefined);
    //         //     process.exit();
    //         // })
    //     })
    // });
});

setTimeout(function() {
    process.exit();
}, 100000);

