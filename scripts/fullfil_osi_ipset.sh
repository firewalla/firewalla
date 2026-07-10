#!/bin/bash

# only populate for runtime updates (FW_FORWARD already exists), no need to populate for boot up
# for bootup, it will be populated by prepare_network_env.sh @ firerouter
if sudo iptables -S FW_FORWARD &>/dev/null; then
  # OSI: fullfil from redis
  # https://github.com/firewalla/firerouter/blob/master/scripts/prepare_network_env.sh
  sudo ipset flush -! osi_mac_set &>/dev/null
  sudo ipset flush -! osi_subnet_set &>/dev/null
  sudo ipset flush -! osi_match_all_knob &>/dev/null
  sudo ipset flush -! osi_rules_match_all_knob &>/dev/null
  sudo ipset add -! osi_match_all_knob 0.0.0.0/1 &>/dev/null
  sudo ipset add -! osi_match_all_knob 128.0.0.0/1 &>/dev/null
  sudo ipset add -! osi_rules_match_all_knob 0.0.0.0/1 &>/dev/null
  sudo ipset add -! osi_rules_match_all_knob 128.0.0.0/1 &>/dev/null
  
  sudo ipset flush -! osi_subnet6_set &>/dev/null
  sudo ipset flush -! osi_match_all_knob6 &>/dev/null
  sudo ipset flush -! osi_rules_match_all_knob6 &>/dev/null
  sudo ipset add -! osi_match_all_knob6 ::/1 &>/dev/null
  sudo ipset add -! osi_match_all_knob6 8000::/1 &>/dev/null
  sudo ipset add -! osi_rules_match_all_knob6 ::/1 &>/dev/null
  sudo ipset add -! osi_rules_match_all_knob6 8000::/1 &>/dev/null

  OSI_TIMEOUT=$(redis-cli get osi:admin:timeout)
  if [[ -z "$OSI_TIMEOUT" ]]; then
    OSI_TIMEOUT=600 # default 10 mins
  fi

  redis-cli smembers osi:active | awk -v OSI_TIMEOUT="$OSI_TIMEOUT" -F, '$1 == "mac" || $1 == "tag" {print "add osi_mac_set " $NF " timeout " OSI_TIMEOUT}' | sudo ipset -! restore &> /dev/null
  redis-cli smembers osi:active | awk -v OSI_TIMEOUT="$OSI_TIMEOUT" -F, '$1 == "network" || $1 == "identity" || $1 == "identityTag" {print "add osi_subnet_set " $NF " timeout " OSI_TIMEOUT}' | sudo ipset -! restore &> /dev/null
  redis-cli smembers osi:active | awk -v OSI_TIMEOUT="$OSI_TIMEOUT" -F, '$1 == "network6" {print "add osi_subnet6_set " $NF " timeout " OSI_TIMEOUT}' | sudo ipset -! restore &> /dev/null
  redis-cli smembers osi:rules:active | awk -v OSI_TIMEOUT="$OSI_TIMEOUT" -F, '$1 == "mac" || $1 == "tag" {print "add osi_rules_mac_set " $NF " timeout " OSI_TIMEOUT}' | sudo ipset -! restore &> /dev/null
  redis-cli smembers osi:rules:active | awk -v OSI_TIMEOUT="$OSI_TIMEOUT" -F, '$1 == "network" || $1 == "identity" || $1 == "identityTag" {print "add osi_rules_subnet_set " $NF " timeout " OSI_TIMEOUT}' | sudo ipset -! restore &> /dev/null
  redis-cli smembers osi:rules:active | awk -v OSI_TIMEOUT="$OSI_TIMEOUT" -F, '$1 == "network6" {print "add osi_rules_subnet6_set " $NF " timeout " OSI_TIMEOUT}' | sudo ipset -! restore &> /dev/null

  mode=$(redis-cli get mode)
  if [[ -z "$mode" ]]; then
    mode="router"
  fi
  if [[ $mode == "router" ]]; then
    wans=$(curl 'http://localhost:8837/v1/config/wans' | jq -r 'keys[]')
    while IFS= read -r wan; do
      sudo ipset add -! osi_wan_inbound_set 0.0.0.0/1,$wan
      sudo ipset add -! osi_wan_inbound_set 128.0.0.0/1,$wan
      sudo ipset add -! osi_wan_inbound_set6 ::/1,$wan
      sudo ipset add -! osi_wan_inbound_set6 8000::/1,$wan
    done <<< "$wans"
  fi
fi

# OSI: reset verified set
sudo ipset flush -! osi_verified_mac_set &>/dev/null
sudo ipset flush -! osi_verified_subnet_set &>/dev/null
sudo ipset flush -! osi_verified_subnet6_set &>/dev/null