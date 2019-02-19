'use strict'

const program = require('commander');
const rclient = require('redis').createClient();
const Promise = require('bluebird');
Promise.promisifyAll(rclient);

program.version('0.0.2')
    .option('--device [mac address]', 'device mac address')
    .option('--ip [ip address]', 'device ip address');

program.parse(process.argv);

if (program.device == null && program.ip == null) {
    console.error("Error: argument device or ip is required");
    process.exit(1);
}

/**
 * object.padding(number, string)
 * Transform the string object to string of the actual width filling by the padding character (by default ' ')
 * Negative value of width means left padding, and positive value means right one
 *
 * @param       number  Width of string
 * @param       string  Padding chacracter (by default, ' ')
 * @return      string
 * @access      public
 */
String.prototype.padding = function(n, c)
{
    var val = this.valueOf();
    if ( Math.abs(n) <= val.length ) {
        return val;
    }
    var m = Math.max((Math.abs(n) - this.length) || 0, 0);
    var pad = Array(m + 1).join(String(c || ' ').charAt(0));
//      var pad = String(c || ' ').charAt(0).repeat(Math.abs(n) - this.length);
    return (n < 0) ? pad + val : val + pad;
//      return (n < 0) ? val + pad : pad + val;
};

function get_key(mac) {
    return `host:mac:${mac}`;
}

async function get_value(mac, hashKey) {
    return rclient.hgetAsync(get_key(mac), hashKey);
}

async function get_ip(mac) {
    return get_value(mac, "ipv4Addr");
}

async function get_mac(ip) {
    return rclient.hgetAsync(`host:ip4:${ip}`, "mac");
}

async function print_device(mac) {
    console.log("Mac Address:".padding(25), mac);

    const name = await get_value(mac, "name") || "";
    console.log("Provisioned Name:".padding(25), name);

    const bname = await get_value(mac, "bname");
    console.log("Discovered Name:".padding(25), bname);

    const v4Addr = await get_value(mac, "ipv4Addr");
    console.log("IP Address:".padding(25), v4Addr);

    const v6Addrs = await get_value(mac, "ipv6Addr");
    try {
        const v6AddrArray = JSON.parse(v6Addrs);
        if(v6AddrArray && v6AddrArray.length > 0) {
            v6AddrArray.forEach((v6Addr) => {
                console.log("IPv6 Address:".padding(25), v6Addr);
            })
        }
    } catch (err) {
        // do nothing
    }

    const lastActiveTimestamp = await get_value(mac, "lastActiveTimestamp");
    const date = new Date(Number(lastActiveTimestamp) * 1000);
    console.log("Last Active Timestamp:".padding(25), date.toLocaleString());
}

async function print_flow(key1, key2) {
    console.log("\n------------ Recent Outgoing Flows -------------");

    console.log("Timestamp".padding(25),
        "Remote IP Address".padding(20),
        "Port".padding(8),
        "Upload".padding(10),
        "Download".padding(10),
        "Duration".padding(10)
    )
    await _print_flow(`flow:conn:in:${key1}`);
    await _print_flow(`flow:conn:in:${key2}`)

    console.log("\n------------ Recent Incoming Flows -------------");

    console.log("Timestamp".padding(25),
        "Remote IP Address".padding(20),
        "Port".padding(8),
        "Upload".padding(10),
        "Download".padding(10),
        "Duration".padding(10)
    )

    await _print_flow(`flow:conn:out:${key1}`);
    await _print_flow(`flow:conn:out:${key2}`)
}

async function _print_flow(flowKey) {
    const flows = await rclient.zrevrangeAsync(flowKey, 0, 19);
    flows.forEach((flowContent) => {
        try {
            const flow = JSON.parse(flowContent);
            print_flow_line(flow);
        } catch(err) {
            // do nothing
        }
    })
}

function print_num(number) {
    return `${number}`.padding(10);
}

async function print_flow_line(flow, direction) {
    flow = flow || {};

    const ts = flow._ts || 0
    const tsString = new Date(ts * 1000).toLocaleString();
    const remoteIP = flow.lh === flow.sh ? flow.dh : flow.sh;
    const ob = flow.ob || 0;
    const rb = flow.rb || 0;
    const du = flow.du || 0;
    const pf = flow.pf || {};
    const keys = Object.keys(pf);
    let dport = "0";
    if(keys.length > 0) {
        dport = keys[0].replace("tcp:", "").replace("udp:", "");
    }

    console.log(tsString.padding(25),
        remoteIP.padding(20),
        dport.padding(8),
    print_num(ob),
        print_num(rb),
        print_num(du)
        )
}

let mac = program.device;


(async () => {
    if(!mac) {
        mac = await get_mac(program.ip);
    }

    await print_device(mac);
    const ip = await get_ip(mac);
    await print_flow(ip, mac)
    process.exit(0);
})()

// print_line "Mac Address" $MAC
// print_line "Provisioned Name" $(get_mac_value $MAC "name")
// print_line "Machine Name" $(get_mac_value $MAC "bname")
// print_line "IPv6 Addresses" $(get_mac_value $MAC "ipv6Addr")
// print_line "Last Active Time" "$(date -d @$(get_mac_value $MAC lastActiveTimestamp))"
//
//