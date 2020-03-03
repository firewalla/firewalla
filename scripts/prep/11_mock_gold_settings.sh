#!/bin/bash

redis-cli hset sys:network:settings lans "[{\"name\":\"lan1\",\"type\":\"bridge\",\"intf\":\"br0\",\"ip4Prefixes\":\"10.0.0.1/24\",\"guest\":false,\"enabled\":true,\"dhcp4\":{\"enabled\":true,\"gateway\":\"10.0.0.1\",\"subnetMask\":\"255.255.255.0\",\"dnsServers\":[\"1.1.1.1\"]},\"phyPorts\":[\"eth0\",\"eth1\",\"eth2\"]}]"
