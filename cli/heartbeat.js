'use strict';

const io2 = require('socket.io-client');
const url = "https://api.firewalla.com";
const path = "/socket";

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);


const cp = require('child_process');
const mac =  getSignatureMac();
const memory = getTotalMemory()

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

function isBooted() {
  const fw_hb_file = '/dev/shm/fw_heartbeat';
  try{
    if (fs.existsSync(fw_hb_file)) {
      return false;
    } else {
      log("System was booted.");
      cp.execSync(`touch ${fw_hb_file}`)
      return true;
    }
  } catch (err) {
    return false;
  }
}

function getTotalMemory() {
  const result = exec("free -m | awk '/Mem:/ {print $2}'");
  return result && result.stdout && result.stdout.replace(/\n$/, '')
}

function getSysinfo(status) {
  const booted = isBooted();
  const uptime = require('os').uptime()
  return {booted, mac, memory, status, uptime};
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