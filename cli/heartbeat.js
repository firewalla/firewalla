'use strict';

const io2 = require('socket.io-client');
const url = "https://firewalla.encipher.io";
const path = "/socket.v0";
const file = '/dev/shm/fw_heartbeat';

const cp = require('child_process');
const mac =  getSignatureMac();

function getSignatureMac() {
  try {
    const mac = cp.execSync("cat /sys/class/net/eth0/address", { encoding: 'utf8' });
    return mac && mac.trim().toUpperCase();
  } catch(err) {
    return "";
  }
}

const socket = io2(url, { path: path, transports: ['websocket'], 'upgrade': false });

function log(message) {
  console.log(new Date(), message);
}

function getSysinfo(status) {
  return {mac, status};
}

function update(status) {
  const info = getSysinfo(status);
  socket.emit('update', info);
}

const job = setTimeout(() => {
  update("schedule");
}, 30 * 3600 * 1000);

socket.on('connect', () => {
  log("Connected to heartbeat server.");
  update('connect');
});

socket.on('disconnect', () => {
  log("Disconnected from heartbeat server.");
});

socket.on("update", (data) => {
  update("cloud");
});

socket.on('reconnect', () => {
  log("Reconnected to heartbeat server.");
  update('reconnect');
});