#!/bin/bash

IP=$1

# check all ipset
sudo ipset -S |
  grep create |
  cut -d ' ' -f 2 |
  while read setName; do
    sudo ipset test $setName $IP &>/dev/null;
    [ $? -eq 0 ] && echo "Found in ipset $setName";
  done;

# check redis
redis-cli keys policy:* |
  while read policyKey; do
    if [[ "$(redis-cli hget $policyKey target)" == *$IP* ]]; then
      TYPE=$(redis-cli hget $policyKey type);
      SCOPE=$(redis-cli hget $policyKey scope);
      echo "Found in $policyKey: $TYPE $SCOPE";
    fi;
  done;
