#!/bin/bash
basedir=`dirname $0`
basedir=`cd $basedir;pwd`
function usage()
{
    echo "dhcp_shutup_router.sh <pi_address_on_router's network> <router's mac> <network device name>"
    echo "example: dhcp_shutup_rounter.sh 192.168.1.1 aa:bb:cc:dd:ee:00:11 eth0"
}

usage

pi_ip=$1
router_mac=$2
device_name=$3

while [ true ]; do
    sudo $basedir/pig.py -p $pi_ip -m $router_mac $device_name
    echo "wait for 60 seconds to start another round"
    sleep 60;
done
