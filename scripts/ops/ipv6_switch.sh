#!/bin/bash

GATEWAY_6=`ip -6 r | grep default | head -n 1 | awk '{print $3}'`

GOOGLE_IP_6=`dig +short AAAA www.google.com | head -n 1`

if [[ -n $GATEWAY_6 && -n $GOOGLE_IP_6 ]]; then
  timeout 10 nc -6 -z $GOOGLE_IP_6 443
  if [[ $? -eq 0 ]]; then
    echo "IPv6 is supported."
    redis-cli hset sys:features ipv6 1
    redis-cli publish "config:feature:dynamic:enable" ipv6
    exit 0
  fi
fi

echo "IPv6 is not supported."
redis-cli hset sys:features ipv6 0
redis-cli publish "config:feature:dynamic:disable" ipv6
exit 0