#!/bin/bash

shopt -s lastpipe

dpkg -s jq &> /dev/null

if [ $? -ne 0 ]; then
  echo "jq not found, installing... "
  sudo apt-get update
  sudo apt-get install -y jq
fi

printf "%-20s %-10s %-10s %s\n" 'MAC' 'ConnAll' 'UniqDest' 'bname'

# finding top conn:flow hosts
redis-cli keys host:mac:* |
cut -d ':' -f 3- |
while read mac; do
  conn_in=$(redis-cli zcard "flow:conn:in:$mac")
  conn_out=$(redis-cli zcard "flow:conn:out:$mac")
  sum=$(($conn_in + $conn_out))
  if [[ $sum == 0 ]]; then continue; fi;
  unset hosts
  declare -A hosts
  redis-cli zrange "flow:conn:in:$mac" 0 -1 | jq -r ".dh" | while read host; do hosts["$host"]=1; done
  printf "%-20s %-10i %-10i %s\n" $mac $sum ${#hosts[@]} "$(redis-cli hget "host:mac:$mac" bname)"
done | sort -rn -k2
