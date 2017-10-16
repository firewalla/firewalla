'use strict'

var io2 = require('socket.io-client');
//var socket = io2.connect('https://iox.encipher.io/');
//var socket = io2.connect('https://firewalla.encipher.io/socketio');
//var socket = io2.connect('https://firewalla.encipher.io/socket.io');
//working//var socket = io2('https://firewalla.encipher.io',{path: '/socket.io'});
//var socket = io2('https://firewalla.encipher.io',{path: '/socket'});
//var socket = io2('https://firewalla.encipher.io');
var socket = io2('https://firewalla.encipher.io',{path: '/socket',transports:['websocket'],'upgrade':false});

console.log("Connecting");
var msg2 = "hello";

socket.on('connect', ()=>{
    console.log("Connected");
    socket.emit('glisten', msg2);
});
socket.on('notify', (data)=>{
    console.log("Received",data);
});
socket.on('disconnect', (reason)=>{
    console.log("Discounnted",reason);
});
socket.on('connect_error', (error)=>{
    console.log("Connect Error",error);
});
socket.on('connect_timeout', (error)=>{
    console.log("Connect Timeout",error);
});
socket.on('error', (error)=>{
    console.log("Error",error);
});
socket.on('reconnect', (error)=>{
    console.log("Reconnet ",error);
});
