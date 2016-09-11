'use strict'

var io2 = require('socket.io-client');
//var socket = io2.connect('https://iox.encipher.io/');
var socket = io2.connect('https://firewalla.encipher.io/');

var msg2 = "hello";

socket.on('connect', ()=>{
    console.log("Connected");
    socket.emit('glisten', msg2);
});
socket.on('notify', (data)=>{
    console.log("Received",data);
});
socket.on('disconnect', ()=>{
});
