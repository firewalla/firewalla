#!/bin/bash

self_ip=$(ip addr show dev eth0 | awk '/inet /' | awk '$NF=="eth0" {print $2}' | cut -f1 -d/ | grep -v '^169\.254\.' | head -n 1)

if [[ -z $self_ip ]]; then
  echo "Can not find Firewalla's IP address."
  exit -1
fi


if [[ ! -f /blog/current/conn.log ]]; then
  echo "bro conn.log is not found."
  exit -1
fi

cp /blog/current/conn.log /home/pi/conn.log
total=$(cat /home/pi/conn.log | grep -v $self_ip | grep tcp | grep -v "OTH" | grep -v "0.0.0.0" | wc -l)
echo "Total captured tcp connections: $total"
complete=$(cat /home/pi/conn.log | grep -v $self_ip | grep tcp | grep -v "OTH" | grep -v "0.0.0.0" | grep "history\":\"ShA" | wc -l)
echo "Completely captured tcp connections: $complete"
complete_ratio=$(echo "scale=4;$complete/$total" | bc)
echo "Compatibility probability: $complete_ratio"
rm /home/pi/conn.log
exit 0
