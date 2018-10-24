'use strict'

exports.on = function() {
  let pcmd = "sudo sh -c 'echo default-on > /sys/devices/platform/leds/leds/nanopi:green:status/trigger'"
  require('child_process').exec(pcmd,(err)=>{
  });
  pcmd = "sudo sh -c 'echo default-on > /sys/devices/platform/leds/leds/nanopi:green:pwr/trigger'"
  require('child_process').exec(pcmd,(err)=>{
  });
  pcmd = "sudo sh -c 'echo default-on > /sys/devices/platform/leds/leds/nanopi:blue:status/trigger'"
  require('child_process').exec(pcmd,(err)=>{
  });
} 

exports.off = function() {
  let pcmd = "sudo sh -c 'echo none > /sys/devices/platform/leds/leds/nanopi:green:status/trigger'"
  require('child_process').exec(pcmd,(err)=>{
  });
  pcmd = "sudo sh -c 'echo none > /sys/devices/platform/leds/leds/nanopi:green:pwr/trigger'"
  require('child_process').exec(pcmd,(err)=>{
  });
  pcmd = "sudo sh -c 'echo none > /sys/devices/platform/leds/leds/nanopi:blue:status/trigger'"
  require('child_process').exec(pcmd,(err)=>{
  });
}

exports.blink = function() {
  let pcmd = "sudo sh -c 'echo heartbeat > /sys/devices/platform/leds/leds/nanopi:green:status/trigger'"
  require('child_process').exec(pcmd,(err)=>{
  });
  pcmd = "sudo sh -c 'echo heartbeat > /sys/devices/platform/leds/leds/nanopi:green:pwr/trigger'"
  require('child_process').exec(pcmd,(err)=>{
  });
  pcmd = "sudo sh -c 'echo heartbeat > /sys/devices/platform/leds/leds/nanopi:blue:status/trigger'"
  require('child_process').exec(pcmd,(err)=>{
  });
}
