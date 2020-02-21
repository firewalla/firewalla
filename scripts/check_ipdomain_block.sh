#!/bin/bash
#
# -i <ip>
# -d <domain>
#

GETOPT_ARGS=`getopt -o i:d:m: --long ip:,domain:,mac: -- "$@"`
if [ $? != 0 ] ; then
  exit 1
fi

eval set -- "$GETOPT_ARGS"
while [ -n "$1" ]
do
  case "$1" in
    -i|--ip) IP=$2; shift 2;;
    -d|--domain) DOMAIN=$2; shift 2;;
    -m|--mac) MAC=$2; shift 2;;
    --) break ;;
    *) break ;;
  esac
done

if [[ -z $IP && -z $DOMAIN ]]; then
  echo "Error: ip or domain missing"
  exit 1
fi

REDISRULES=`redis-cli keys policy:*`
function in_subnet {
  local ip ip_a mask netmask sub sub_ip rval start end

  # Define bitmask.
  local readonly BITMASK=0xFFFFFFFF

  # Read arguments.
  IFS=/ read sub mask <<< "${1}"
  IFS=. read -a sub_ip <<< "${sub}"
  IFS=. read -a ip_a <<< "${2}"

  # Calculate netmask.
  netmask=$(($BITMASK<<$((32-$mask)) & $BITMASK))

  # Determine address range.
  start=0
  for o in "${sub_ip[@]}"
  do
    start=$(($start<<8 | $o))
  done

  start=$(($start & $netmask))
  end=$(($start | ~$netmask & $BITMASK))

  # Convert IP address to 32-bit number.
  ip=0
  for o in "${ip_a[@]}"
  do
    ip=$(($ip<<8 | $o))
  done

  # Determine if IP in range.
  (( $ip >= $start )) && (( $ip <= $end )) && rval=0 || rval=1

  echo $rval
  return $rval
}

function check_ip {
  local ip_ret ipsets rule_id policy_ret

  if [[ -z $2 ]]; then
    echo "Start check ip: $1 "
  else
    echo "Start check ip: $1 mac: $2"
  fi

  # default
  ip_ret=1
  ipsets=`sudo ipset -S | grep create | cut -d ' ' -f 2`
  while read setName; do
    if [[ -z $setName ]]; then
      continue
    fi
    sudo ipset test $setName $1 &>/dev/null;
    if [[ $? -eq 0 ]]; then
      rule_id=$(echo $setName | sed 's/.*_\([0-9]\+\)_.*/\1/')
      if [[ $rule_id != $setName ]]; then
        if echo $REDISRULES | grep "policy:$rule_id" &>/dev/null; then
          policy_ret=1
          if [[ -z $2 ]]; then
            policy_ret=0
          elif [[ $(check_redis_rule_mac "policy:$rule_id" $2) -eq 0 ]]; then
            policy_ret=0
          fi

          if [[ $policy_ret -eq 0 ]]; then
            echo "Found $1 in ipset $setName policy:$rule_id"
            redis-cli hgetall "policy:$rule_id"
            ip_ret=0
          fi
        fi
      elif [[ "$setName" == "blocked_ip_set" || "$setName" == "blocked_domain_set" || "$setName" == "blocked_net_set" ]]; then
        check_redis_rule $setName $1 $2
        if [[ $? -eq 0 ]]; then
          ip_ret=0
        fi
      else
        ip_ret=0
        echo "Found $1 in ipset $setName"
        sudo ipset list "$setName"
      fi
    fi
  done <<< "$ipsets"
  
  if [[ $ip_ret -eq 1 ]]; then
    echo "Not found $1"
  fi

  return $ip_ret
}

function check_redis_rule {
  local rule_ret setName mac_ret target ptype

  # default
  rule_ret=1
  setName=$1
  while read policyKey; do
    if [[ -z $policyKey ]]; then
      continue
    fi

    mac_ret=1
    if [[ -z $3 ]]; then
      mac_ret=0
    else
      if [[ $(check_redis_rule_mac $policyKey $3) -eq 0 ]]; then
        mac_ret=0
      fi
    fi

    target="$(redis-cli hget $policyKey target)"
    ptype="$(redis-cli hget $policyKey type)"
    if [[ $ptype == "ip" && $target == *$2* && $mac_ret -eq 0 ]]; then
      echo "Found $2 in ipset $setName $policyKey"
      redis-cli hgetall "$policyKey"
      rule_ret=0
    elif [[ $ptype == "dns" ]]; then
      redis-cli zrange "rdns:domain:$target" 0 -1 | grep $2 &> /dev/null
      if [[ $? -eq 0 && $mac_ret -eq 0 ]]; then
        echo "Found $2 in ipset $setName $policyKey $target"
        redis-cli hgetall "$policyKey"
        rule_ret=0
      fi
    elif [[ $ptype == "net" && $(in_subnet $target $2) -eq 0 && $mac_ret -eq 0 ]]; then
      echo "Found $2 in ipset $setName $policyKey $target"
      redis-cli hgetall "$policyKey"
      rule_ret=0
    fi
  done <<< "$REDISRULES"

  return $rule_ret
}

function check_redis_rule_mac {
  local mac_ret=1
  if [[ -z $1 || -z $2 ]]; then
    return $mac_ret
  fi
  if redis-cli hgetall $1 | grep $2 &>/dev/null; then
    mac_ret=0
  fi
  echo $mac_ret
  return $mac_ret
}

function check_domain {
  local domain_ret domains

  if [[ -z $2 ]]; then
    echo "Start check domain: $1 "
  else
    echo "Start check domain: $1 mac: $2"
  fi

  # default
  domain_ret=1
  domains=`redis-cli zrange "rdns:domain:$1" 0 -1`
  while read ip; do
    if [[ -z $ip ]]; then
      continue
    fi
    
    check_ip $ip $2
    if [[ $? -eq 0 ]]; then
      domain_ret=0
    fi
  done <<< "$domains"

  if [[ $domain_ret -eq 1 ]]; then
    echo "Not found $1"
  fi

  return $domain_ret
}

if [[ $IP ]];  then
  check_ip $IP $MAC
elif [[ $DOMAIN ]]; then
  check_domain $DOMAIN $MAC
fi
