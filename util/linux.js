"use strict";

var os    = require('os'),
    ip    = require('ip'),
    exec  = require('child_process').exec,
    async = require('async');

function trim_exec(cmd, cb) {
  exec(cmd, function(err, out) {
    if (out && out.toString() != '') {
      cb(null, out.toString().trim())
    } else {
      cb(null)
    }
  })
}

exports.ping6= function(intf, ipv6addr,cb) {
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

exports.interface_type_for = function(nic_name, cb) {
  exec('cat /proc/net/wireless | grep ' + nic_name, function(err, out, stderr) {
    return cb(null, err ? 'Wired' : 'Wireless')
  })
};

exports.mac_address_for = function(nic_name, cb) {
  // This is a workaround for nodejs bug
  // https://github.com/libuv/libuv/commit/f1e0fc43d17d9f2d16b6c4f9da570a4f3f6063ed
  // eth0:* virtual interface should use same mac address as main interface eth0
  let n = nic_name.replace(/:.*$/, "");
  var cmd = 'cat /sys/class/net/' + n + '/address';
  trim_exec(cmd, cb);
};

exports.gateway_ip_for = function(nic_name, cb) {
  trim_exec("ip r | grep " + nic_name + " | grep default | cut -d ' ' -f 3 | sed -n '1p'", cb);
};

exports.gateway_ip = function(cb) {
  exports.gateway_ip_for("eth0",cb);
};

exports.netmask_for = function(nic_name, cb) {
  var cmd = "ifconfig " + nic_name + " 2> /dev/null | egrep 'netmask|Mask:' | awk '{print $4}'";
  trim_exec(cmd, cb);
};

exports.gateway_ip6 = function(cb) {
  var cmd = "/sbin/ip -6 route | awk '/default/ { print $3 }'"
  trim_exec(cmd, cb);
};

exports.gateway_ip6_sync = function() {
  var cmd = "/sbin/ip -6 route | awk '/default/ { print $3 }'"
  return trim_exec_sync(cmd);
};

exports.get_network_interfaces_list = function(cb) {

  var count = 0,
      list = [],
      nics = os.networkInterfaces();

  function append_data(obj) {
    async.parallel([
      function(cb) {
        exports.mac_address_for(obj.name, cb)
      },
      function(cb) {
        exports.gateway_ip_for(obj.name, cb)
      },
      function(cb) {
        exports.netmask_for(obj.name, cb)
      },
      function(cb) {
        exports.interface_type_for(obj.name, cb)
      }
    ], function(err, results) {
      if (results[0]) obj.mac_address = results[0];
      if (results[1]) obj.gateway_ip  = results[1];
      if (results[2]) obj.netmask     = results[2];
      if (results[3]) obj.type        = results[3];

      list.push(obj);
      --count || cb(null, list);
    })
  }

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

      append_data(obj);
    }
  }


  if (count == 0)
    cb(new Error('No interfaces found.'))
}
