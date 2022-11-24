#!/bin/bash
#
# -i <ip>
# -d <domain>
#

GETOPT_ARGS=`getopt -o i:d:m:s --long ip:,domain:,mac:,subdomain -- "$@"`
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
    -s|--subdomain) SUBDOMAIN=true; shift;;
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

function print_block_rule {
  local rule_id rule target ptype scope alarm_id flow_description expire crontime
  if [[ -n $2 ]]; then
    rule=$2
    rule_id=${rule/policy:/""}
    target=$(redis-cli hget $rule target)
    ptype=$(redis-cli hget $rule type)
    scope=$(redis-cli hget $rule scope)
    alarm_id=$(redis-cli hget $rule aid)
    flow_description=$(redis-cli hget $rule flowDescription)

    if [[ ! -n $scope ]]; then
      scope="All Devices"
    fi
    expire=$(redis-cli hget $rule expire)
    if [[ ! -n $expire ]]; then
      expire="Infinite"
    fi
    crontime=$(redis-cli hget $rule cronTime)
    if [[ ! -n $crontime ]]; then
      crontime="Always"
    fi
    if [[ -n $alarm_id ]]; then
      rule_id="* $rule_id"
    elif [[ -n $flow_description ]]; then
      rule_id="** $rule_id"
    fi
  fi
  printf "%25s %8s %30s %10s %25s %10s %15s\n" "$1" "$rule_id" "$target" "$ptype" "$scope" "$expire" "$crontime"
}

function print_block_target {
  printf "%25s %8s %30s %10s %25s %10s %15s\n" "" "" "$1" "" "" "" ""
}

function check_ip {
  local ip_ret ipsets rule_id rule_category rule_country policy_ret ipset_content set_type set_compare set_exists

  if [[ -z $2 ]]; then
    echo "Start check ip: $1 "
  else
    echo "Start check ip: $1 mac: $2"
  fi

  echo "------------------------------ Blocking Rules ------------------------------"
  printf "%25s %5s %30s %10s %25s %10s %15s\n" "Ipset" "Rule" "Target" "Type" "Device" "Expire" "Scheduler"

  # default
  ip_ret=1
  ipsets=`sudo ipset -S | grep create | awk '{print $2, $3}'`
  ipset_content=`sudo ipset -S | grep add`
  while read set_line; do
    if [[ -z $set_line ]]; then
      continue
    fi
    read setName set_type <<< "${set_line}"
    set_compare="add $setName $1"
    set_exists=1
    if [[ "$set_type" == "hash:net" ]]; then
      sudo ipset test $setName $1 &>/dev/null;
      if [[ $? -eq 0 ]]; then
        set_exists=0
      fi
    elif [[ $ipset_content == *$set_compare* ]]; then
      set_exists=0
    fi
    if [[ $set_exists -eq 0 ]]; then
      rule_id=$(echo $setName | sed 's/.*_\([0-9]\+\)_.*/\1/')
      rule_category=$(echo $setName | sed 's/c_bd_\([a-zA-Z_]\+\)_set/\1/')
      rule_country=$(echo $setName | sed 's/c_bd_country:\([a-zA-Z]\+\)_set/\1/')
      block_set=$(echo $setName | egrep -o "^block[^ ]*(_ip_set|_net_set|_domain_set)$")
      if [[ $rule_id != $setName ]]; then
        if echo $REDISRULES | grep "policy:$rule_id" &>/dev/null; then
          policy_ret=1
          if [[ -z $2 ]]; then
            policy_ret=0
          elif [[ $(check_redis_rule_mac "policy:$rule_id" $2) -eq 0 ]]; then
            policy_ret=0
          fi

          if [[ $policy_ret -eq 0 ]]; then
            print_block_rule $setName "policy:$rule_id"
            ip_ret=0
          fi
        fi
      elif [[ -n $block_set ]]; then
        check_redis_rule $setName $1 $1 $2
        if [[ $? -eq 0 ]]; then
          ip_ret=0
        fi
      elif [[ $rule_category != $setName ]]; then
        check_redis_rule $setName $rule_category $1 $2
        if [[ $? -eq 0 ]]; then
          ip_ret=0
        fi
      elif [[ $rule_country != $setName ]]; then
        check_redis_rule $setName $rule_country $1 $2
        if [[ $? -eq 0 ]]; then
          ip_ret=0
        fi
      else
        ip_ret=0
        print_block_rule $setName
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
    if [[ -z $4 ]]; then
      mac_ret=0
    else
      if [[ $(check_redis_rule_mac $policyKey $4) -eq 0 ]]; then
        mac_ret=0
      fi
    fi

    target="$(redis-cli hget $policyKey target)"
    ptype="$(redis-cli hget $policyKey type)"
    if [[ $ptype == "ip" && $target == *$2* && $mac_ret -eq 0 ]]; then
      print_block_rule $setName $policyKey
      rule_ret=0
    elif [[ $ptype == "dns" ]]; then
      check_redis_rule_domain $target $2
      if [[ $? -eq 0 && $mac_ret -eq 0 ]]; then
        print_block_rule $setName $policyKey
        rule_ret=0
      fi
    elif [[ $ptype == "net" && $(in_subnet $target $2) -eq 0 && $mac_ret -eq 0 ]]; then
      print_block_rule $setName $policyKey
      rule_ret=0
    elif [[ $ptype == "category" && $target == *$2* && $mac_ret -eq 0 && -n $3 ]]; then
      domain_name=""
      category_domain=`redis-cli zrange "dynamicCategoryDomain:$target" 0 -1`
      while read domain; do
        redis-cli zrange "rdns:domain:$domain" 0 -1 | grep $3 &> /dev/null
        if [[ $? -eq 0 ]]; then
          domain_name="$domain_name $domain"
        fi
      done <<< "$category_domain"
      print_block_rule $setName $policyKey 
      if [[ $domain_name != "" ]]; then
        print_block_target "$domain_name"
      fi
      rule_ret=0
    elif [[ $ptype == "country" && $target == *$2* && $mac_ret -eq 0 ]]; then
      print_block_rule $setName $policyKey
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

function check_redis_rule_domain {
  local domain_ret=1
  local domain_rules=`redis-cli keys rdns:domain:*$1`
  while read domain_key; do
    redis-cli zrange "$domain_key" 0 -1 | grep $2 &> /dev/null
    if [[ $? -eq 0 ]]; then
      domain_ret=0
      return $domain_ret
    fi
  done <<< "$domain_rules"

  return $domain_ret
}

function check_domain {
  local domain_ret domains domain_ips

  # default
  domain_ret=1
  if [[ "$SUBDOMAIN" == "true" ]]; then
    domains=`redis-cli keys rdns:domain:*$1`
  else
    domains=`redis-cli keys rdns:domain:$1`
  fi
  while read domain_key; do
    domain_name=${domain_key/rdns:domain:/};
    if [[ -z $2 ]]; then
      echo "Start check domain: $domain_name "
    else
      echo "Start check domain: $domain_name mac: $2"
    fi

    domain_ip=`redis-cli zrange "$domain_key" 0 -1`
    while read ip; do
      if [[ -z $ip ]]; then
        continue
      fi
      
      check_ip $ip $2
      if [[ $? -eq 0 ]]; then
        domain_ret=0
      fi
    done <<< "$domain_ip"
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
