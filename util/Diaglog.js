'use strict'

exports.log = function(event,message) {
  let pcmd = "sh -c '/home/pi/firewalla/scripts/diaglog -e "+event+" -m \""+message+"\" '"
  require('child_process').exec(pcmd,(err)=>{
  });
} 

