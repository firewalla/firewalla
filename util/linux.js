"use strict";

const log   = require("../net2/logger.js")(__filename),
      os    = require('os'),
      exec  = require('child_process').exec,
      execAsync = require('child-process-promise').exec;

function trim_exec(cmd, cb) {
  exec(cmd, function(err, out) {
    if (out && out.toString() != '') {
      cb(null, out.toString().trim())
    } else {
      cb(null)
    }
  })
}

async function trim_exec_async(cmd) {
  try {
    let result = await execAsync(cmd)
    return result.stdout && result.stdout.trim() || null
  } catch(err) {
    log.error('Executing Error', cmd, err)
    return null
  }
}

exports.ping6= function(ipv6addr,cb) {
  let pcmd = "ping6 -c 3 "+ipv6addr;
  require('child_process').exec(pcmd,(err)=>{
      if (cb)
         cb();
  });
};

function trim_exec_sync(cmd) {
  let r;
  try {
    r = require('child_process').execSync(cmd);
  } catch (err) {
    log.error("Error when executing:" + cmd, err);
  }
  if (r) {
    return r.toString().trim();
  }
  return null;
}

// If no wifi, then there is no error but cbed get's a null in second param.
exports.get_active_network_interface_name = function(cb) {
  var cmd = "netstat -rn | grep UG | awk '{print $NF}'";
  exec(cmd, function(err, stdout) {
    if (err) return cb(err);

    var raw = stdout.toString().trim().split('\n');
    if (raw.length === 0 || raw === [''])
      return cb(new Error('No active network interface found.'));

    cb(null, raw[0]);
  });
};

exports.interface_type_for = async function(nic_name) {
  try {
    const result = await execAsync('cat /proc/net/wireless | grep ' + nic_name)
    return 'Wireless'
  } catch(err) {
    return 'Wired'
  }
};

exports.mac_address_for = function(nic_name) {
  // This is a workaround for nodejs bug
  // https://github.com/libuv/libuv/commit/f1e0fc43d17d9f2d16b6c4f9da570a4f3f6063ed
  // eth0:* virtual interface should use same mac address as main interface eth0
  let n = nic_name.replace(/:.*$/, "");
  var cmd = 'cat /sys/class/net/' + n + '/address';
  return trim_exec_async(cmd);
};

exports.gateway_ip_for = function(nic_name) {
  return trim_exec_async("ip r | grep " + nic_name + " | grep default | cut -d ' ' -f 3 | sed -n '1p'");
};

exports.netmask_for = function(nic_name) {
  var cmd = "ifconfig " + nic_name + " 2> /dev/null | egrep 'netmask|Mask:' | awk '{print $4}'";
  return trim_exec_async(cmd);
};

exports.gateway_ip6 = function(cb) {
  var cmd = "/sbin/ip -6 route | awk '/default/ { print $3 }'"
  trim_exec(cmd, cb);
};

exports.gateway_ip6_sync = function() {  
  const cmd = "/sbin/ip -6 route | awk '/default/ { print $3 }' | head -n 1"
  return trim_exec_sync(cmd);
};

/*
[ { name: 'eth0',
    ip_address: '192.168.10.4',
    mac_address: '02:81:05:84:b0:5d',
    ip6_addresses: [ 'fe80::81:5ff:fe84:b05d' ],
    ip6_masks: [ 'ffff:ffff:ffff:ffff::' ],
    gateway_ip: '192.168.10.1',
    netmask: 'Mask:255.255.255.0',
    type: 'Wired' },
  { name: 'eth0:0',
    ip_address: '192.168.218.1',
    mac_address: '02:81:05:84:b0:5d',
    netmask: 'Mask:255.255.255.0',
    type: 'Wired' } ]
*/
exports.get_network_interfaces_list = async function() {

  var count = 0,
    list = [],
    nics = os.networkInterfaces();

  for (var key in nics) {
    if (key != 'lo0' && key != 'lo' && !key.match(/^tun/)) {

      count++;
      var obj = { name: key };

      nics[key].forEach(function(type) {
        if (type.family == 'IPv4') {
          obj.ip_address = type.address;
        }
        if (type.family == 'IPv6') {
          if (obj.ip6_addresses) {
            obj.ip6_addresses.push(type.address);
            if (type.netmask) {
              obj.ip6_masks.push(type.netmask);
            }
          } else {
            obj.ip6_addresses=[type.address];
            obj.ip6_masks=[type.netmask];
          }
        }
        if (type.mac) {
          obj.mac_address = type.mac;
        }
      });

      const results = await Promise.all([
        exports.mac_address_for(obj.name),
        exports.gateway_ip_for(obj.name),
        exports.netmask_for(obj.name),
        exports.interface_type_for(obj.name)
      ])
      if (results[0]) obj.mac_address = results[0];
      if (results[1]) obj.gateway_ip  = results[1];
      if (results[2]) obj.netmask     = results[2];
      if (results[3]) obj.type        = results[3];

      list.push(obj);
    }
  }

  return list
}
