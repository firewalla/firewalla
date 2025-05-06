#!/bin/bash

shopt -s lastpipe

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREROUTER_HOME:=/home/pi/firerouter}

UNAME=$(uname -m)
ROUTER_MANAGED='yes'
case "$UNAME" in
  "x86_64")
    PLATFORM='gold'
    ;;
  "aarch64")
    if [[ -e /etc/firewalla-release ]]; then
      PLATFORM=$( . /etc/firewalla-release 2>/dev/null && echo $BOARD || cat /etc/firewalla-release )
      if [[ $PLATFORM == "blue" || $PLATFORM == "navy" ]]; then
        ROUTER_MANAGED='no'
      fi
    else
      PLATFORM='unknown'
    fi
    ;;
  "armv7l")
    PLATFORM='red'
    ROUTER_MANAGED='no'
    ;;
  *)
    PLATFORM='unknown'
    ;;
esac

# no idea what version of column were used before, but -n tells it not to ommit empty cells
# while it's for something totally different in offical build now
echo | column -n 2>/dev/null && COLUMN_OPT='column -n' || COLUMN_OPT='column'

# reads redis hash with key $2 into associative array $1
read_hash() {
  # make an alias of $1, https://unix.stackexchange.com/a/462089
  declare -n hash="$1"
  local i=0
  local key
  # as hash value might contain \n, have to use a non-standard delimiter here
  # use \x03 as delimiter as redis-cli doesn't seems to operate with \x00
  # bash 4.3 doesn't support readarray -d
  (redis-cli -d $'\3' hgetall "$2"; printf $'\3') | while read -r -d $'\3' entry; do
    ((i++))
    if ((i % 2)); then
      key="$entry"
    else
      hash["$key"]="$entry"
    fi
  done
}

# https://stackoverflow.com/questions/73742856/printing-and-padding-strings-with-bash-printf
# this doesn't work for chinese or japanese but deals with emoji pretty well
#
# Space pad align string to width
# @params
# $1: The alignment width
# $2: The string to align
# @stdout
# aligned string
align::right() {
  local -i width=$1 # Mandatory column width
  local -- str=$2 # Mandatory input string
  local -i length
  if (( ${#str} > width )); then
    length=$width
    str="${str:0:width-3}..."
  else
    length=${#str}
  fi
  local -i offset=$((${#str} - length))
  local -i pad_left=$((width - length))
  printf '%*s%s' $pad_left '' "${str:offset:length}"
}

element_in() {
  local e match="$1"
  shift
  for e; do [[ "$e" == "$match" ]] && return 0; done
  return 1
}

declare -A NETWORK_UUID_NAME
declare -A WGPEER_NAME
frcc_done=0
frcc() {
    if [[ $ROUTER_MANAGED == "no" ]]; then
        NETWORK_UUID_NAME['00000000-0000-0000-0000-000000000000']='primary'
        NETWORK_UUID_NAME['11111111-1111-1111-1111-111111111111']='overlay'
    elif [ "$frcc_done" -eq "0" ]; then
        curl localhost:8837/v1/config/active -s -o /tmp/scc_config

        jq -r '.interface | to_entries[].value | to_entries[].value.meta | .uuid, .name' /tmp/scc_config |
        while mapfile -t -n 2 ARY && ((${#ARY[@]})); do
            NETWORK_UUID_NAME[${ARY[0]}]=${ARY[1]}
        done

        jq -r '.interface.wireguard.wg0.extra.peers[]? | .publicKey, .name' /tmp/scc_config |
        while mapfile -t -n 2 ARY && ((${#ARY[@]})); do
            WGPEER_NAME[${ARY[0]}]=${ARY[1]}
        done

        frcc_done=1
    fi
}

declare -A TAG_UID_NAME
get_tag_name() {
    if [ -z "${TAG_UID_NAME[$1]+x}" ]; then
        TAG_UID_NAME["$1"]=$(redis-cli hget "${1/:/:uid:}" name)
    fi
    echo "${TAG_UID_NAME["$1"]}"
}

declare -A SF
system_features_done=0
get_system_features() {
  if [ "$system_features_done" -eq "0" ]; then
    local FILE="$FIREWALLA_HOME/net2/config.json"
    local USERFILE="$HOME/.firewalla/config/config.json"

    # use jq where available
    if [[ "$PLATFORM" != 'red' && "$PLATFORM" != 'blue' ]]; then
      if [[ -f "$FILE" ]]; then
        jq -r '.userFeatures // {} | to_entries[] | "\(.key) \(.value)"' "$FILE" |
          while read key value; do
            SF["$key"]="$value"
          done
      fi

      if [[ -f "$USERFILE" ]]; then
        jq -r '.userFeatures // {} | to_entries[] | "\(.key) \(.value)"' "$USERFILE" |
          while read key value; do
            SF["$key"]="$value"
          done
      fi
    else
      # lagacy python 2.7 solution
      if [[ -f "$FILE" ]]; then
        local JSON=$(python -c "import json; obj=json.load(open('$FILE')); obj2='\n'.join([key + '=' + str(value) for key,value in obj['userFeatures'].items()]); print obj2;")
        while IFS="=" read -r key value; do
          SF["$key"]="$value"
        done <<<"$JSON"
      fi

      if [[ -f "$USERFILE" ]]; then
        local JSON=$(python -c "import json; obj=json.load(open('$USERFILE')); obj2='\n'.join([key + '=' + str(value) for key,value in obj['userFeatures'].items()]) if obj.has_key('userFeatures') else ''; print obj2;")
        if [[ "$JSON" != "" ]]; then
          while IFS="=" read -r key value; do
            SF["$key"]="$value"
          done <<<"$JSON"
        fi
      fi
    fi

    read_hash SF sys:features

    system_features_done=1
  fi
}

declare -A SP
declare -a VPNClients
system_policy_done=0
get_system_policy() {
  if [ "$system_policy_done" -eq "0" ]; then
    read_hash SP policy:system
    system_policy_done=1
    mapfile -t VPNClients < <(jq -r 'if .multiClients then .multiClients[]|.[.type].profileId else .[.type//empty].profileId end' <<< "${SP[vpnClient]}")
  fi
}

declare -A NP
declare -A network_policy_done
get_network_policy() {
  if [ -z "${network_policy_done[$1]+x}" ]; then
    declare -A network_policy
    read_hash network_policy "policy:network:$1"
    for key in "${!network_policy[@]}"; do
      NP[$1,${key}]=${network_policy[$key]}
    done
    unset network_policy
    network_policy_done[$1]=1
  fi
}

declare -A TP
declare -A tag_policy_done
get_tag_policy() {
  if [ -z "${tag_policy_done[$1]+x}" ]; then
    declare -A tag_policy
    read_hash tag_policy "policy:tag:$1"
    for key in "${!tag_policy[@]}"; do
      TP[$1,${key}]=${tag_policy[$key]}
    done
    unset tag_policy
    tag_policy_done[$1]=1
  fi
}

check_wan_conn_log() {
  if [[ $ROUTER_MANAGED == "no" ]]; then
    return 0
  fi
  echo "---------------------------- WAN Connectivity Check Failures ----------------------------"
  cat ~/.forever/router*.log  | grep -a "WanConnCheckSensor" | grep -e "all ping test \| DNS \| Wan connectivity test failed" | sort | tail -n 50
  echo ""
  echo ""
}

check_cloud() {
    echo -n "  checking cloud access ... "
    curl_result=$(curl -w '%{http_code}' -Lks --connect-timeout 5 https://firewalla.encipher.io)
    test $curl_result == '200' && echo OK || {
        echo "fail($curl_result)"
        return 1
    }
    return 0
}

check_process() {
    echo -n "  checking process $1 ... "
    ps -ef | grep -w $1 | grep -qv grep && echo OK || {
        echo fail
        return 1
    }
    return 0
}

check_partition() {
    echo -n "  checking partition $1 ... "
    mount | grep -qw $1 && echo OK || {
        echo fail
        return 1
    }
    return 0
}

check_zram() {
    echo -n "  checking zram ... "
    test $(swapon -s | wc -l) -eq 5 && echo OK || {
        echo fail
        return 1
    }
    return 0
}

check_file() {
    echo -n "  check file $1 ... "
    if [[ -n "$2" ]]; then
        grep -q "$2" $1 && echo OK || {
            echo fail
            return 1
        }
    else
        test -f $1 && echo OK || {
            echo fail
            return 1
        }
    fi
    return 0
}

check_dmesg_ethernet() {
    echo "----------------------- Ethernet Link Up/Down in dmesg ----------------------------"

    sudo dmesg --time-format iso | grep '1c30000.ethernet' | grep 'Link is Down' -C 3 || echo "Nothing Found"

    echo ""
    echo ""
}

check_each_system_service() {
    local SERVICE_NAME=$1
    local EXPECTED_STATUS=$2
    local RESTART_TIMES=$(systemctl show "$1" -p NRestarts | awk -F= '{print $2}')
    local ACTUAL_STATUS=$(systemctl status "$1" | grep 'Active: ' | sed 's=Active: ==')
    printf "%20s %10s %5s %s\n" "$SERVICE_NAME" "$EXPECTED_STATUS" "$RESTART_TIMES" "$ACTUAL_STATUS"
}

check_systemctl_services() {
    echo "----------------------- System Services ----------------------------"
    printf "%20s %10s %5s %s\n" "Service Name" "Expect" "RestartedTimes" "Actual"

    check_each_system_service fireapi "running"
    check_each_system_service firemain "running"
    check_each_system_service firemon "running"
    check_each_system_service firekick "dead"
    check_each_system_service redis-server "running"
    check_each_system_service brofish "running"
    check_each_system_service firewalla "dead"
    check_each_system_service fireupgrade "dead"
    check_each_system_service fireboot "dead"

    get_system_policy
    if grep -F -q '"state":true' <<< "${SP[vpn]}"
    then
      vpn_run_state='running'
    else
      vpn_run_state='dead'
    fi
    check_each_system_service openvpn@server $vpn_run_state

    if [[ $ROUTER_MANAGED == 'no' ]]; then
        check_each_system_service firemasq "running"
        check_each_system_service watchdog "running"
    else
        check_each_system_service firerouter "running"
        check_each_system_service firerouter_dns "running"
        check_each_system_service firerouter_dhcp "running"
    fi

    echo ""
    echo ""
}

check_rejection() {
    echo "----------------------- Node Rejections ----------------------------"

    find /home/pi/logs/ -type f -mtime -2 -exec bash -c 'grep -a "Possibly Unhandled Rejection" -A 10 -B 2 $1 | tail -n 300' shell {} \;

    echo ""
    echo ""
}

check_exception() {
    echo "----------------------- Node Exceptions ----------------------------"

    find /home/pi/logs/ -type f -mtime -2 -exec bash -c 'grep -a -H -i "##### CRASH #####" -A 20 $1 | tail -n 300' shell {} \;

    echo ""
    echo ""
}

check_reboot() {
    echo "----------------------- Reboot Record ------------------------------"

    sudo grep -a REBOOT /var/log/syslog

    echo ""
    echo ""
}

print_config() {
    local VALUE=${2%$'\r'} # remove tailing \r
    if [[ $VALUE == "" ]]; then
        VALUE="false"
    elif [[ $VALUE == "1" ]]; then
        VALUE="true"
    elif [[ $VALUE == "0" ]]; then
        VALUE="false"
    fi
    if [ -z "$3" ]; then
        printf "%30s  %-30s\n" "$1" "$VALUE"
    else
        printf "%40s  %30s  %-30s\n" "$1" "$3" "$VALUE"
    fi
}

get_redis_key_with_no_ttl() {
    local OUTPUT=$(redis-cli info keyspace | grep db0 | awk -F: '{print $2}')
    local TOTAL=$(echo "$OUTPUT" | sed 's/keys=//' | sed 's/,.*$//')
    local EXPIRES=$(echo "$OUTPUT" | sed 's/.*expires=//' | sed 's/,.*$//')
    local NOTTL=$((TOTAL - EXPIRES))

    local COLOR=""
    local UNCOLOR="\e[0m"
    if [[ $NOTTL -gt 1000 ]]; then
        COLOR="\e[91m"
    fi

    echo -e "$COLOR$NOTTL$UNCOLOR"
}

get_mode() {
    MODE=$(redis-cli get mode)
    frcc
    get_system_policy
    if [ "$MODE" = "spoof" ] && [ "${SP[enhancedSpoof]}" = "true" ]; then
        echo "enhancedSpoof"
    elif [ "$MODE" = "dhcp" ] && [ $ROUTER_MANAGED = "yes" ] && \
        [[ $(jq -c '.interface.bridge[] | select(.meta.type=="wan")' /tmp/scc_config | wc -c ) -ne 0 ]]; then
        echo "bridge"
    else
        echo "$MODE"
    fi
}

get_auto_upgrade() {
    local UPGRADE=
    local COLOR=
    local UNCOLOR="\e[0m"
    if [ -f "$1" ] || [ -f "$2" ]; then
      COLOR="\e[91m"
      UPGRADE="false"
    else
      UPGRADE="true"
    fi

    echo -e "$COLOR$UPGRADE$UNCOLOR"
}

check_firerouter_hash() {
  if ! pushd "$FIREROUTER_HOME" &>/dev/null; then
      printf "no firerouter"
      return
  fi

  if git merge-base --is-ancestor 97a43b9faf0492b3a4a96628ea6c23246524fb90 HEAD &>/dev/null; then
    git rev-parse @
  else
    printf "\e[41m >>>>>> version too old <<<<<< \e[0m"
  fi

  popd &>/dev/null
}


check_system_config() {
    echo "----------------------- System Config ------------------------------"
    declare -A c
    read_hash c sys:config

    for hkey in "${!c[@]}"; do
        print_config "$hkey" "${c[$hkey]}"
    done
    print_config 'version' "$(jq -c .version /home/pi/firewalla/net2/config.json)"

    pushd "$FIREWALLA_HOME" &>/dev/null
    branch="$(git rev-parse --abbrev-ref HEAD)"
    release=branch
    case "$branch" in
      "release_6_0")
        release="prod"
        ;;
      "beta_6_0")
        release="beta"
        ;;
      "beta_7_0")
        release="alpha"
        ;;
      "master")
        release="dev"
        ;;
    esac
    print_config 'release' "$release"
    popd &>/dev/null

    echo ""

    get_system_policy

    print_config "Mode" "$(get_mode)"
    print_config "Adblock" "${SP[adblock]}"
    print_config "Family" "${SP[family]}"
    print_config "DoH" "${SP[doh]}"
    print_config "Unbound" "${SP[unbound]}"
    print_config "Monitor" "${SP[monitor]}"
    print_config "Emergency Access" "${SP[acl]}"
    print_config "vpnAvailable" "${SP[vpnAvailable]}"
    print_config "vpn" "${SP[vpn]}"
    print_config "Redis Usage" "$(redis-cli info | grep used_memory_human | awk -F: '{print $2}')"
    print_config "Redis Total Key" "$(redis-cli dbsize)"
    print_config "Redis key without ttl" "$(get_redis_key_with_no_ttl)"

    echo ""

    print_config 'Firewalla Autoupgrade' \
      "$(get_auto_upgrade "/home/pi/.firewalla/config/.no_auto_upgrade" "/home/pi/.firewalla/config/.no_upgrade_check")"
    print_config 'Firerouter Autoupgrade' \
      "$(get_auto_upgrade "/home/pi/.router/config/.no_auto_upgrade" "/home/pi/.router/config/.no_upgrade_check")"
    print_config 'Firerouter Hash' "$(check_firerouter_hash)"
    print_config 'License Prefix' "$(jq -r .DATA.SUUID ~/.firewalla/license)"

    echo ""

    print_config 'default MSP' "$(redis-cli get ext.guardian.business | jq -c .name) $(redis-cli get ext.guardian.socketio.server)"
    redis-cli zrange guardian:alias:list 0 -1 | while read -r alias; do printf '%30s  %s\n' "$alias" "$(redis-cli get "ext.guardian.socketio.server.$alias")"; done

    echo ""
}

check_tc_classes() {
    echo "------------------------- TC Classes -------------------------------"
    local RULES=$(redis-cli hkeys policy_qos_handler_map | grep "^policy_" | sort -t_ -n -k 2)
    for RULE in $RULES; do
        local RULE_ID=${RULE/policy_/""}
        local QOS_HANDLER=$(redis-cli hget policy_qos_handler_map $RULE)
        local QOS_HANDLER_ID=$(printf '%x' ${QOS_HANDLER/qos_/""})
        local TRAFFIC_DIRECTION=$(redis-cli hget policy:${RULE_ID} trafficDirection)
        local RATE_LIMIT=$(redis-cli hget policy:${RULE_ID} rateLimit)
        local PRIORITY=$(redis-cli hget policy:${RULE_ID} priority)
        local DISABLED=$(redis-cli hget policy:${RULE_ID} disabled)
        echo "PID: ${RULE_ID}, traffic direction: ${TRAFFIC_DIRECTION}, rate limit: ${RATE_LIMIT}, priority: ${PRIORITY}, disabled: ${DISABLED}"
        if [[ $TRAFFIC_DIRECTION == "upload" ]]; then
          tc class show dev ifb0 classid 1:0x${QOS_HANDLER_ID}
        else
          tc class show dev ifb1 classid 1:0x${QOS_HANDLER_ID}
        fi
        echo ""
    done
    echo ""
    echo ""
}

check_policies() {
    echo "--------------------------- Rules ----------------------------------"
    local RULES=$(redis-cli keys 'policy:*' | grep -E "policy:[0-9]+$" | sort -t: -n -k 2)
    frcc

    echo "No.|Target|Type|Scope|Expire|Scheduler|Proto|TosDir|RateLmt|Pri|Dis|Purpose">/tmp/qos_csv
    echo "No.|Target|Type|Scope|Expire|Scheduler|Proto|Dir|wanUUID|Type|Dis|Purpose">/tmp/route_csv
    echo "No.|Target|Action|Scope|Expire|Scheduler|Resolver|Dis|Purpose">/tmp/dns_csv
    printf "%7s %52s %11s %25s %10s %25s %5s %8s %5s %9s %9s %3s %8s %20s\n" \
      "No." "Target" "Type" "Scope" "Expire" "Scheduler" "Dir" "Action" "Proto" "LPort" "RPort" "Dis" "Hit" "Purpose"
    for RULE in $RULES; do
        local RULE_ID=${RULE/policy:/""}
        declare -A p
        read_hash p "$RULE"

        local TYPE=${p["type"]}
        if [[ $TYPE == "dns" || $TYPE == 'domain' ]]; then
          if [[ ${p[dnsmasq_only]} != 'true' && ${p[dnsmasq_only]} != '1'  ]]; then
            TYPE=$TYPE'+ip'
          fi
        fi
        local ACTION=${p[action]}
        local TRAFFIC_DIRECTION=${p[trafficDirection]}
        TRAFFIC_DIRECTION=${TRAFFIC_DIRECTION%load} # remove 'load' from end of string
        local DISABLED=${p[disabled]}

        local COLOR=""
        local UNCOLOR="\e[0m"

        if [ "$ACTION" = "" ]; then
            ACTION="block"
        elif [ "$ACTION" = "allow" ]; then
            COLOR="\e[38;5;28m"
        fi

        if [[ $DISABLED == "1" ]]; then
            DISABLED='T'
            COLOR="\e[2m" #dim
        else
            DISABLED=
        fi

        local DIRECTION=${p[direction]}
        if [ "$DIRECTION" = "" ] || [ "$DIRECTION" = "bidirection" ]; then
            DIRECTION="both"
        else
            DIRECTION=${DIRECTION%bound} # remove 'bound' from end of string
        fi

        local SCOPE=${p[scope]:2:-2}
        local TAG=${p[tag]}
        if [[ -n $TAG ]]; then
            TAG="${TAG:2:-2}"
            if [[ "$TAG" == "intf:"* ]]; then
                SCOPE="net:${NETWORK_UUID_NAME[${TAG:5}]}"
            else
                SCOPE="${TAG%%:*}:$(get_tag_name "$TAG")"
            fi
        elif [[ -n ${p[guids]} ]]; then
            GUID="${p[guids]:2:-2}"
            if [[ "$GUID" == "wg_peer:"* ]]; then
                SCOPE="wg:${WGPEER_NAME[${GUID:8}]}"
            fi
        elif [[ -z $SCOPE ]]; then
            SCOPE="All Devices"
        fi

        local TARGET="${p[target]}"
        if [[ $TYPE == "network" ]]; then
            TARGET="net:${NETWORK_UUID_NAME[$TARGET]}"
        fi

        local EXPIRE=${p[expire]}
        local CRONTIME=${p[cronTime]}

        local ALARM_ID=${p[aid]}
        if [[ -n $ALARM_ID ]]; then
            RULE_ID="* $RULE_ID"
        elif [[ -n ${p[flowDescription]} ]]; then
            RULE_ID="** $RULE_ID"
        fi
        if [[ $ACTION == 'qos' ]]; then
          echo -e "$RULE_ID|$TARGET|$TYPE|$SCOPE|$EXPIRE|$CRONTIME|${p[protocol]}|$TRAFFIC_DIRECTION|${p[rateLimit]}|${p[priority]}|$DISABLED|${p[purpose]}">>/tmp/qos_csv
        elif [[ $ACTION == 'route' ]]; then
          local WAN="${NETWORK_UUID_NAME[${p[wanUUID]}]}"
          if [ -z "$WAN" ]; then
              WAN=${p[wanUUID]}
          fi
          echo -e "$RULE_ID|$TARGET|$TYPE|$SCOPE|$EXPIRE|$CRONTIME|${p[protocol]}|$DIRECTION|$WAN|${p[routeType]}|$DISABLED|${p[purpose]}">>/tmp/route_csv
        elif [[ $ACTION == 'address' ]] || [[ $ACTION == 'resolve' ]]; then
          echo -e "$RULE_ID|$TARGET|$ACTION|$SCOPE|$EXPIRE|$CRONTIME|${p[resolver]}|$DISABLED|${p[purpose]}">>/tmp/dns_csv
        else
          printf "$COLOR%7s %52s %11s %25s %10s %25s %5s %8s %5s %9s %9s %3s %8s %20s$UNCOLOR\n" \
            "$RULE_ID" "$(align::right 52 "$TARGET")" "$TYPE" "$(align::right 25 "$SCOPE")" "$EXPIRE" "$CRONTIME" \
            "$DIRECTION" "$ACTION" "${p[protocol]}" "${p[localPort]}" "${p[remotePort]}" "$DISABLED" "${p[hitCount]}" "${p[purpose]:-${p[app_name]}}"
        fi;

        unset p
    done

    echo ""
    echo "Note: * - created from alarm, ** - created from network flow"

    echo ""
    echo "QoS Rules:"
    $COLUMN_OPT -t -s'|' /tmp/qos_csv

    echo ""
    echo "Route Rules:"
    $COLUMN_OPT -t -s'|' /tmp/route_csv

    echo ""
    echo "DNS Rules:"
    $COLUMN_OPT -t -s'|' /tmp/dns_csv

    echo ""
    echo ""
}

is_router() {
    local GW=$(/sbin/ip route show | awk '/default via/ {print $3}')
    if [[ $GW == "$1" ]]; then
        return 0
    else
        return 1
    fi
}

is_simple_mode() {
    local MODE=$(redis-cli get mode)
    if [[ $MODE == "spoof" ]]; then
        echo T
    fi

    echo F
}

set_color_value() {
  # make an alias of $1, https://unix.stackexchange.com/a/462089
  fcv[$1,v]=$2
  if [ -z ${3+x} ]; then
    fcv[$1,c]="\e[2m" #dim
  else
    fcv[$1,c]="\e[39m"
  fi
}

check_hosts() {
    echo "----------------------- Devices ------------------------------"

    local SIMPLE_MODE=$(is_simple_mode)
    # read all enabled newDeviceTag tags
    declare -a NEW_DEVICE_TAGS
    get_system_policy
    get_system_features
    if [[ "${SF[new_device_tag]}" == "1" ]]; then
      NEW_DEVICE_TAGS=( $(jq "select(.state == true) | .tag" <<< ${SP[newDeviceTag]}) )
      while read -r POLICY_KEY; do
        if [ -n "$POLICY_KEY" ]; then
          local nid=${POLICY_KEY/policy:network:/""}
          get_network_policy "$nid"
          NEW_DEVICE_TAGS+=( $(jq "select(.state == true) | .tag" <<< ${NP[$nid,newDeviceTag]}) );
        fi
      done < <(redis-cli keys 'policy:network:*')
    else
      NEW_DEVICE_TAGS=( )
    fi

    local B7_Placeholder=
    if [[ $SIMPLE_MODE == "T" ]]; then
      B7_Placeholder=' %2s'
    else
      B7_Placeholder='%.s'
    fi
    printf "%35s %15s %16s %18s %3s$B7_Placeholder %2s %11s %7s %6s %3s %3s %3s %3s %3s %3s %3s %3s %3s %3s %3s %3s\n" \
      "Host" "Network" "IP" "MAC" "Mon" "B7" "Ol" "VPNClient" "FlowOut" "FlowIn" "Grp" "Usr" "DvT" "VqL" "Iso" "EA" "DNS" "AdB" "Fam" "SS" "DoH" "Ubd"
    NOW=$(date +%s)
    frcc


    local FIREWALLA_MAC="$(ip link list | awk '/ether/ {print $2}' | sort | uniq)"

    local hierarchicalPolicies=('isolation')
    local policyNames=("adblock" "safeSearch" "doh" "unbound")
    local featureNames=("adblock" "safe_search" "doh" "unbound")

    # family native mode doesn't have 'family_protect' enabled but are all standalone app controlled rules
    if [[ "$(jq -r ".family | select(.state == true) | .mode" <<< "${SP[app]}")" == "native" ]]; then
      hierarchicalPolicies+=("family")
    else
      policyNames+=("family")
      featureNames+=("family_protect")
    fi
    for index in "${!policyNames[@]}"; do
      local policy=${policyNames[$index]}
      local feature=${featureNames[$index]}
      if [[ "${SF[$feature]}" == "1" ]] || [[ "${SF[$feature]}" == "true" ]]; then
        hierarchicalPolicies+=("$policy")
      fi
    done

    # typeset -p hierarchicalPolicies

    local DEVICES=$(redis-cli keys 'host:mac:*')
    for DEVICE in $DEVICES; do
        local MAC=${DEVICE/host:mac:/""}
        # hide vpn_profile:*
        if [[ ${MAC,,} == "vpn_profile:"* ]]; then
            continue
        fi

        local IS_FIREWALLA
        if echo "$FIREWALLA_MAC" | grep -wiq "$MAC"; then
          IS_FIREWALLA=1 # true
        else
          IS_FIREWALLA=0 # false
        fi

        declare -A h
        read_hash h "$DEVICE"

        local ONLINE_TS=${h[lastActiveTimestamp]}
        ONLINE_TS=${ONLINE_TS%.*}
        if [[ -z $ONLINE_TS ]]; then
            local ONLINE="NA"
        elif ((ONLINE_TS < NOW - 2592000)); then # 30days ago, hide entry
            unset h
            continue
        elif ((ONLINE_TS > NOW - 600)); then
            local ONLINE="T"
        else
            local ONLINE=
        fi

        local NAME="${h[name]}"
        if [[ -z "$NAME" ]]; then NAME="$( jq -re 'select(has("name")) | .name' <<< "${h[detect]}" )"; fi
        if [[ -z "$NAME" ]]; then NAME="${h[bname]}"; fi
        if [[ -z "$NAME" ]]; then NAME="${h[dhcpName]}"; fi
        if [[ -z "$NAME" ]]; then NAME="${h[bonjourName]}"; fi
        if [[ -z "$NAME" ]]; then NAME="${h[ssdpName]}"; fi

        declare -A fcv # feature color value

        for policy in "${hierarchicalPolicies[@]}"; do
          if [[ -n ${SP[$policy]+x} ]]; then
            [[ ${SP[$policy]} == *"true"* ]] && set_color_value "$policy" "T"
            [[ ${SP[$policy]} == *"null"* ]] && set_color_value "$policy" "F"
            # echo $policy ${SP[$policy]} ${fcv[$policy,v]}
          fi
          if [[ -n ${SP[acl]+x} ]]; then
            [[ ${SP[acl]} == "false" ]] && set_color_value "acl" "T"
          fi
        done

        local nid=${h[intf]}
        local NETWORK_NAME=
        if [[ -n ${h[intf]+x} ]]; then
          NETWORK_NAME=${NETWORK_UUID_NAME[${h[intf]}]}
          for policy in "${hierarchicalPolicies[@]}"; do
            if [[ -n ${NP[$nid,$policy]+x} ]]; then
              if [ "$policy" == "isolation" ]; then
                if [[ "${NP[$nid,isolation]}" == *'"external":true'* ]]; then
                  set_color_value vql "T"
                  [[ "${NP[$nid,isolation]}" == *'"internal":true'* ]] && set_color_value iso "T"
                fi
              else
                [[ ${NP[$nid,$policy]} == *"true"* ]] && set_color_value "$policy" "T"
                [[ ${NP[$nid,$policy]} == *"null"* ]] && set_color_value "$policy" "F"
              fi
            fi
            # echo $policy $uid ${NP[$uid,$policy]} ${fcv[$policy,v]}
          done
          if [[ -n ${NP[$nid,acl]+x} ]]; then
            [[ ${NP[$nid,acl]} == "false" ]] && set_color_value "acl" "T"
          fi
        fi

        local MAC_VENDOR=${h[macVendor]}
        local POLICY_MAC="policy:mac:${MAC}"

        declare -A p
        read_hash p "$POLICY_MAC"

        local IP=${h[ipv4Addr]}
        if [[ -n $IP ]] && [[ "$(jq -r '.allocations[] | select(.type=="static") | .ipv4' <<< "${p[ipAllocation]}")" == $IP ]]; then
          IP="*$IP"
        fi

        local TAGS=${p[tags]//[\]\[\" ]/}
        local USER_TAGS=${p[userTags]//[\]\[\" ]/}
        local DEVICE_TAGS=${p[deviceTags]//[\]\[\" ]/}

        for tag in $TAGS; do
          get_tag_policy "$tag"
          for policy in "${hierarchicalPolicies[@]}"; do
            if [[ -n ${TP[$tag,$policy]+x} ]]; then
              if [ "$policy" == "isolation" ]; then
                if [[ "${TP[$tag,isolation]}" == *'"external":true'* ]]; then
                  set_color_value vql "T"
                  [[ "${TP[$tag,isolation]}" == *'"internal":true'* ]] && set_color_value iso "T"
                fi
              else
                [[ ${TP[$tag,$policy]} == *"true"* ]] && set_color_value "$policy" "T"
                [[ ${TP[$tag,$policy]} == *"null"* ]] && set_color_value "$policy" "F"
                # echo $policy $tag ${TP[$tag,$policy]} ${fcv[$policy,v]}
              fi
            fi
          done
        done

        local MONITORING=
        if ((IS_FIREWALLA)) || is_router "${h[ipv4Addr]}"; then
            MONITORING="NA"
        elif [ -z ${p[monitor]+x} ] || [[ ${p[monitor]} == "true" ]]; then
            MONITORING=""
        else
            MONITORING="F"
        fi
        if [[ $SIMPLE_MODE == "T" ]]; then
          local B7_MONITORING_FLAG=$(redis-cli sismember monitored_hosts "${h[ipv4Addr]}")
          local B7_MONITORING=""
          if [[ $B7_MONITORING_FLAG == "1" ]]; then
            B7_MONITORING="T"
          else
            B7_MONITORING="F"
          fi
        fi

        # local policy=()
        # local output=$(redis-cli -d $'\3' hmget $POLICY_MAC vpnClient tags acl)
        # readarray -d $'\3' -t policy < <(echo -n "$output")

        local VPN=$( ((${#p[vpnClient]} > 2)) && jq -re 'select(.state == true) | .profileId' <<< "${p[vpnClient]}" || echo -n "")
        if ! element_in "$VPN" "${VPNClients[@]}" && [[ "$VPN" != VWG:* ]]; then VPN=""; fi

        local FLOWINCOUNT=$(redis-cli zcount flow:conn:in:$MAC -inf +inf)
        # if [[ $FLOWINCOUNT == "0" ]]; then FLOWINCOUNT=""; fi
        local FLOWOUTCOUNT=$(redis-cli zcount flow:conn:out:$MAC -inf +inf)
        # if [[ $FLOWOUTCOUNT == "0" ]]; then FLOWOUTCOUNT=""; fi

        # local DNS_BOOST=$(jq -r 'select(.dnsCaching == false) | "F"' <<< "${p[dnsmasq]}")
        local DNS_BOOST=$(if [[ ${p[dnsmasq]} == *"false"* ]]; then echo "F"; fi)

        for policy in "${hierarchicalPolicies[@]}"; do
          if [ -n "${p[$policy]+x}" ]; then
            if [ "$policy" == "isolation" ]; then
              if [[ "${p[isolation]}" == *'"external":true'* ]]; then
                set_color_value vql "T" 1
                [[ "${p[isolation]}" == *'"internal":true'* ]] && set_color_value iso "T" 1
              fi
            else
              [[ "${p[$policy]}" == *"true"* ]] && set_color_value $policy "T" 1
              [[ "${p[$policy]}" == *"null"* ]] && set_color_value $policy "F" 1
            fi
            # echo "$policy | ${p[$policy]} | ${fcv[$policy,v]}"
          fi
        done
        if [[ -n ${p[acl]+x} ]]; then
          [[ "${p[acl]}" == "false" ]] && set_color_value "acl" "T" 1
        fi

        # === COLOURING ===
        local FC="\e[39m"   # front color
        local UC="\e[0m"    # uncolor
        local BGC="\e[49m"  # background color
        local BGUC="\e[49m" # background uncolor
        if [[ $SIMPLE_MODE == "T" && -n $ONLINE && -z $MONITORING && $B7_MONITORING == "F" ]] &&
          ((! IS_FIREWALLA)) && ! is_router ${h[ipv4Addr]}; then
            FC="\e[91m"
        elif [ $FLOWINCOUNT -gt 2000 ] || [ $FLOWOUTCOUNT -gt 2000 ]; then
            FC="\e[33m" #yellow
        fi
        if [[ ${NAME,,} == "circle"* || ${MAC_VENDOR,,} == "circle"* ]]; then
            BGC="\e[41m"
        fi

        local MAC_COLOR="$FC"
        if [[ $MAC =~ ^.[26AEae].*$ ]] && ((! IS_FIREWALLA)); then
          MAC_COLOR="\e[35m"
        fi

        TAG_COLOR="$FC"
        if [[ " ${NEW_DEVICE_TAGS[*]} " =~ " ${TAGS} " ]]; then
          TAG_COLOR="\e[31m"
        fi

        if [ -z "$ONLINE" ] || [ "$ONLINE" == "NA" ]; then
            FC=$FC"\e[2m" #dim
        fi

        printf "$BGC$FC%35s %15s %16s $MAC_COLOR%18s$FC %3s$B7_Placeholder %2s %11s %7s %6s $TAG_COLOR%3s$FC %3s %3s ${fcv[vql,c]}%3s$UC ${fcv[iso,c]}%3s$UC ${fcv[acl,c]}%3s$UC %3s ${fcv[adblock,c]}%3s$UC ${fcv[family,c]}%3s$UC ${fcv[safeSearch,c]}%3s$UC ${fcv[doh,c]}%3s$UC ${fcv[unbound,c]}%3s$UC$BGUC\n" \
          "$(align::right 35 "$NAME")" "$(align::right 15 "$NETWORK_NAME")" "$IP" "$MAC" "$MONITORING" "$B7_MONITORING" "$ONLINE" "$(align::right 11 $VPN)" "$FLOWINCOUNT" \
          "$FLOWOUTCOUNT" "$TAGS" "$USER_TAGS" "$DEVICE_TAGS" "${fcv[vql,v]}" "${fcv[iso,v]}" "${fcv[acl,v]}" "$DNS_BOOST" "${fcv[adblock,v]}" "${fcv[family,v]}" "${fcv[safeSearch,v]}" "${fcv[doh,v]}" "${fcv[unbound,v]}"

        unset h
        unset p
        unset fcv

        # for feature in ${hierarchicalFeatures[@]}; do
        #   unset $feature
        # done
    done

    D="\e[2m"
    U="\e[0m"

    echo ""
    echo    "    *: Reserved IP"
    echo -e "Abbr.: Mon${D}itoring$U B7${D}(Spoofing Flag)$U Ol${D}(Online)$U DvT${D}(Device Type)$U VqL${D}an$U Iso${D}lation$U EA${D}(Emergency Access)$U SS${D}(Safe Search)$U DoH${D}(DNS over HTTPS)$U Ubd${D}(Unbound)$U"
    echo ""
}

check_ipset() {
    echo "---------------------- Active IPset ------------------"
    printf "%25s %10s\n" "IPSET" "NUM"
    local IPSETS=$(sudo iptables -w -L -n | grep -E -o "match-set [^ ]*" | sed 's=match-set ==' | sort | uniq)
    for IPSET in $IPSETS $(sudo ipset list -name | grep bd_default_c); do
        local NUM=$(($(sudo ipset -S $IPSET | wc -l)-1))
        local COLOR=""
        local UNCOLOR="\e[0m"
        if [[ $NUM -gt 0 ]]; then
            COLOR="\e[91m"
        fi
        printf "%25s $COLOR%10s$UNCOLOR\n" $IPSET $NUM
    done

    echo ""
    echo ""
}

check_sys_features() {
    echo "---------------------- System Features ------------------"

    get_system_features

    keyList=( "ipv6" "local_domain" "family_protect" "adblock" "doh" "unbound" "dns_proxy" "safe_search" "external_scan" "device_online" "device_offline" "dual_wan" "single_wan_conn_check" "video" "porn" "game" "vpn" "cyber_security" "cyber_security.autoBlock" "cyber_security.autoUnblock" "large_upload" "large_upload_2" "abnormal_bandwidth_usage" "vulnerability" "new_device" "new_device_tag" "new_device_block" "alarm_subnet" "alarm_upnp" "alarm_openport" "acl_alarm" "vpn_client_connection" "vpn_disconnect" "vpn_restore" "spoofing_device" "sys_patch" "device_service_scan" "acl_audit" "dnsmasq_log_allow" "data_plan" "data_plan_alarm" "country" "category_filter" "fast_intel" "network_monitor" "network_monitor_alarm" "network_stats" "network_status" "network_speed_test" "network_metrics" "link_stats" "rekey" "rule_stats" "internal_scan" "accounting" "wireguard" "pcap_zeek" "pcap_suricata" "compress_flows" "event_collect" "mesh_vpn" "redirect_httpd" "upstream_dns" )

    declare -A nameMap
    nameMap[ipv6]="Simple mode IPv6 Support"
    nameMap[local_domain]="Local Domain"
    nameMap[family_protect]="Family Protect"
    nameMap[adblock]="AD Block"
    nameMap[doh]="DNS over HTTPS"
    nameMap[unbound]="Unbound"
    nameMap[dns_proxy]="DNS Proxy"
    nameMap[safe_search]="Safe Search"
    nameMap[external_scan]="External Scan"
    nameMap[device_online]="Device Online Alarm"
    nameMap[device_offline]="Device Offline Alarm"
    nameMap[dual_wan]="Internet Connectivity Alarm Dual WAN"
    nameMap[single_wan_conn_check]="Internet Connectivity Alarm Single WAN"
    nameMap[video]="Auido/Video Alarm"
    nameMap[porn]="Porn Alarm"
    nameMap[game]="Gaming Alarm"
    nameMap[vpn]="VPN Traffic Alarm"
    nameMap[cyber_security]="Security Alarm"
    nameMap[cyber_security.autoBlock]="Malicious Traffic Autoblock"
    nameMap[cyber_security.autoUnblock]="Malicious Traffic Autoblock Validation"
    nameMap[large_upload]="Abnormal Upload Alarm"
    nameMap[large_upload_2]="Large Upload Alarm"
    nameMap[abnormal_bandwidth_usage]="Abnormal Bandwidth Alarm"
    nameMap[vulnerability]="Vulnerability Alarm"
    nameMap[new_device]="New Device Alarm"
    nameMap[new_device_tag]="Quarantine"
    nameMap[new_device_block]="New Device Alarm Auto Block"
    nameMap[alarm_subnet]="Subnet Alarm"
    nameMap[alarm_upnp]="uPnP Alarm"
    nameMap[alarm_openport]="Open Port Alarm"
    nameMap[acl_alarm]="Customized Alarm"
    nameMap[vpn_client_connection]="VPN Activity Alarm"
    nameMap[vpn_disconnect]="VPN Connectivity Disconnection Alarm"
    nameMap[vpn_restore]="VPN Connectivity Restoration Alarm"
    nameMap[spoofing_device]="Spoofing Device Alarm"
    nameMap[sys_patch]="System Patch"
    nameMap[device_service_scan]="Device Service Scan"
    nameMap[acl_audit]="Blocked Flows"
    nameMap[dnsmasq_log_allow]="Nonblock DNS Flows"
    nameMap[data_plan]="Data Plan"
    nameMap[data_plan_alarm]="Data Plan Alarm"
    nameMap[country]="Country Data Update"
    nameMap[category_filter]="Category Bloomfilter"
    nameMap[fast_intel]="Intel Bloomfilter"
    nameMap[network_monitor]="Internet Quality Test"
    nameMap[network_monitor_alarm]="Internet Quality Alarm"
    nameMap[network_stats]="Network Ping Test"
    nameMap[network_status]="DNS Server Ping Test"
    nameMap[network_speed_test]="Auto Speed Test"
    nameMap[network_metrics]="Network Traffic Metrics"
    nameMap[link_stats]="dmesg LinkDown Check"
    nameMap[rekey]="Renew Group Key"
    nameMap[rule_stats]="Rule Stats"
    nameMap[internal_scan]="Internal Scan"
    nameMap[accounting]="Screen Time"
    nameMap[wireguard]="WireGuard"
    nameMap[pcap_zeek]="Zeek"
    nameMap[pcap_suricata]="Suricate"
    nameMap[compress_flows]="Compress Flow"
    nameMap[event_collect]="Events"
    nameMap[mesh_vpn]="Mesh VPN"
    nameMap[redirect_httpd]="Legacy block service"
    nameMap[upstream_dns]="Legacy DNS -should be off-"

    for key in "${keyList[@]}"; do
        if [[ -n "${nameMap[$key]+x}" ]] && [[ -n "${SF[$key]+x}" ]]; then
            print_config "${nameMap[$key]}" "${SF[$key]}" "$key"
        fi
    done

    for key in "${!SF[@]}"; do
        [ -z "${nameMap[$key]+x}" ] && print_config "" "${SF[$key]}" "$key"
    done

    echo ""
    echo ""
}

check_speed() {
    echo "---------------------- Speed ------------------"
    UNAME=$(uname -m)
    test "$UNAME" == "x86_64" && curl --connect-timeout 10 -L https://github.com/firewalla/firewalla/releases/download/v1.963/fast_linux_amd64 -o /tmp/fast 2>/dev/null && chmod +x /tmp/fast && /tmp/fast
    test "$UNAME" == "aarch64" && curl --connect-timeout 10 -L https://github.com/firewalla/firewalla/releases/download/v1.963/fast_linux_arm64 -o /tmp/fast 2>/dev/null && chmod +x /tmp/fast && /tmp/fast
    test "$UNAME" == "armv7l" && curl --connect-timeout 10 -L https://github.com/firewalla/firewalla/releases/download/v1.963/fast_linux_arm -o /tmp/fast 2>/dev/null && chmod +x /tmp/fast && /tmp/fast
}

check_conntrack() {
    echo "---------------------- Conntrack Count------------------"

    cat /proc/sys/net/netfilter/nf_conntrack_count

    echo ""
    echo ""
}

check_network() {
    if [[ $ROUTER_MANAGED == "no" ]]; then
        return
    fi

    echo "---------------------- Network ------------------"
    curl localhost:8837/v1/config/interfaces -s -o /tmp/scc_interfaces
    INTFS=$(jq -r 'keys | .[]' /tmp/scc_interfaces)
    frcc
    DNS=$(jq '.dns' /tmp/scc_config)
    # read LAN DNS as '|' seperated string into associative array DNS_CONFIG
    declare -A DNS_CONFIG
    jq -r '.dns | to_entries | map(select(.value.nameservers))[] | .key, (.value.nameservers | join("|"))' /tmp/scc_config |
      while mapfile -t -n 2 ARY && ((${#ARY[@]})); do
        DNS_CONFIG[${ARY[0]}]=${ARY[1]}
      done

    :>/tmp/scc_csv
    for INTF in $INTFS; do
      jq -rj ".[\"$INTF\"] | if (.state.ip6 | length) == 0 then .state.ip6 |= [] else . end | [\"$INTF\", .config.meta.name, .config.meta.uuid, .state.ip4, .state.gateway, (.state.ip6 | join(\"|\")), .state.gateway6, (.state.dns // [] | join(\";\"))] | @tsv" /tmp/scc_interfaces >>/tmp/scc_csv
      echo "" >> /tmp/scc_csv
    done

    get_system_policy

    printf "Interface\tName\tUUID\tIPv4\tGateway\tIPv6\tGateway6\tDNS\tvpnClient\tAdB\tFam\tSS\tDoH\tubn\n" >/tmp/scc_csv_multline
    while read -r LINE; do
      mapfile -td $'\t' COL < <(printf "%s" "$LINE")
      # read multi line fields into array
      mapfile -td '|' IP6 < <(printf "%s" "${COL[5]}")
      # column 7 is the last column, which carries a line feed
      if [[ ${#COL[7]} -gt 1 ]]; then
        # echo "7 ${COL[7]}"
        mapfile -td ';' DNS < <(printf "%s" "${COL[7]}")
      else
        # echo "c,${COL[0]},${DNS_CONFIG["${COL[0]}"]}"
        mapfile -td '|' DNS < <(printf "%s" "${DNS_CONFIG["${COL[0]}"]}")
      fi
      # echo "ip${#IP6[@]} dns${#DNS[@]}"
      # echo ${IP6[@]}
      # echo ${DNS[@]}

      local id=${COL[2]}
      get_network_policy "$id"

      local VPN=$( ((${#NP[$id,vpnClient]} > 2)) && jq -re 'select(.state == true) | .profileId' <<< "${NP[$id,vpnClient]}" || echo -n "")
      if ! element_in "$VPN" "${VPNClients[@]}" && [[ "$VPN" != VWG:* ]]; then VPN=""; fi

      local ADBLOCK=
      if [[ "${NP[$id,adblock]}" == "true" ]]; then ADBLOCK="T"; fi
      local FAMILY_PROTECT=
      if [[ "${NP[$id,family]}" == "true" ]]; then FAMILY_PROTECT="T"; fi

      local SAFE_SEARCH=$(if [[ ${NP[$id,safeSearch]} == *"true"* ]]; then echo "T"; fi)
      local DOH=$(if [[ ${NP[$id,doh]} == *"true"* ]]; then echo "T"; fi)
      local UNBOUND=$(if [[ ${NP[$id,unbound]} == *"true"* ]]; then echo "T"; fi)


      local LINE_COUNT=$(( "${#IP6[@]}" > "${#DNS[@]}" ? "${#IP6[@]}" : "${#DNS[@]}" ));
      [[ $LINE_COUNT -eq 0 ]] && LINE_COUNT=1
      for (( IDX=0; IDX < $LINE_COUNT; IDX++ )); do
        # echo $IDX
        local IP=
        if [[ ${#IP6[@]} -gt $IDX ]]; then
          IP=${IP6[$IDX]}
        fi

        if [[ $IDX -eq 0 ]]; then
          printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
            "${COL[0]}" "${COL[1]}" "${COL[2]:0:7}" "${COL[3]}" "${COL[4]}" "$IP" "${COL[6]}" "${DNS[$IDX]}" \
            "$VPN" "$ADBLOCK" "$FAMILY_PROTECT" "$SAFE_SEARCH" "$DOH" "$UNBOUND" >> /tmp/scc_csv_multline
        else
          printf "\t\t\t\t\t%s\t\t%s\n" "$IP" "${DNS[$IDX]}" >> /tmp/scc_csv_multline
        fi
      done

    done < /tmp/scc_csv
    $COLUMN_OPT -t -s$'\t' /tmp/scc_csv_multline
    echo ""

    if  [[ "$(get_mode)" == "router" ]]; then
      #check source NAT
      mapfile -t WANS < <(jq -r ". | to_entries | .[] | select(.value.config.meta.type == \"wan\") | .key" /tmp/scc_interfaces)
      mapfile -t SOURCE_NAT < <(jq -r ".nat | keys | .[]" /tmp/scc_config | cut -d - -f 2 | sort | uniq)
      echo "WAN Interfaces:"
      for WAN in "${WANS[@]}"; do
        if [[ " ${SOURCE_NAT[*]} " =~ " ${WAN} " ]]; then
          printf "%10s: Source NAT ON\n" $WAN
        else
          printf "\e[31m%10s: Source NAT OFF\e[0m\n" $WAN
        fi
      done
      echo ""
    fi
    echo ""
}

check_tag() {
    echo "---------------------- Tag ------------------"
    mapfile -t TAGS < <(redis-cli --scan --pattern 'tag:uid:*' | sort --version-sort)
    mapfile -t -O "${#TAGS[@]}" TAGS < <(redis-cli --scan --pattern 'userTag:uid:*' | sort --version-sort)
    mapfile -t -O "${#TAGS[@]}" TAGS < <(redis-cli --scan --pattern 'deviceTag:uid:*' | sort --version-sort)
    get_system_policy

    printf "ID\tType\tName\taffiliated\tvpnClient\tVqL\tIso\tAdB\tFam\tSS\tDoH\tubn\n" >/tmp/tag_csv
    for TAG in "${TAGS[@]}"; do
      declare -A t p
      read_hash t "$TAG"
      local id=${t[uid]}
      get_tag_policy "$id"

      local VPN=$( ((${#TP[$id,vpnClient]} > 2)) && jq -re 'select(.state == true) | .profileId' <<< "${TP[$id,vpnClient]}" || echo -n "")
      if ! element_in "$VPN" "${VPNClients[@]}" && [[ "$VPN" != VWG:* ]]; then VPN=""; fi

      local VQLAN=""
      local ISOLATION=""
      if [[ "${TP[$id,isolation]}" == *'"external":true'* ]]; then
        VQLAN="T";
        if [[ "${TP[$id,isolation]}" == *'"internal":true'* ]]; then ISOLATION="T"; fi
      fi

      local ADBLOCK=""
      if [[ "${TP[$id,adblock]}" == "true" ]]; then ADBLOCK="T"; fi
      local FAMILY_PROTECT=""
      if [[ "${TP[$id,family]}" == "true" ]]; then FAMILY_PROTECT="T"; fi

      local DOH=$(if [[ ${TP[$id,doh]} == *"true"* ]]; then echo "T"; fi)
      local SAFE_SEARCH=$(if [[ ${TP[$id,safeSearch]} == *"true"* ]]; then echo "T"; fi)
      local UNBOUND=$(if [[ ${TP[$id,unbound]} == *"true"* ]]; then echo "T"; fi)

      printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
        "${t[uid]}" "${t[type]}" "${t[name]}" "${t[affiliatedTag]}" "$VPN" "$VQLAN" "$ISOLATION" "$ADBLOCK" "$FAMILY_PROTECT" "$SAFE_SEARCH" "$DOH" "$UNBOUND" >>/tmp/tag_csv

      unset t
    done

    $COLUMN_OPT -t -s$'\t' /tmp/tag_csv

    echo ""
    echo ""
}

check_portmapping() {
  echo "------------------ Port Forwarding ------------------"

  (
    printf "type\tactive\tProto\tExtIP\tExtPort\ttoIP\ttoPort\ttoMac\tdescription\n"
    redis-cli get extension.portforward.config |
      jq -r '.maps[] | select(.state == true) | [ ._type // "Forward", .active, .protocol, .extIP // "", .dport, .toIP, .toPort, .toMac, .description ] | @tsv'
    redis-cli hget sys:scan:nat upnp |
      jq -r '.[] | [ "UPnP", .expire, .protocol, .public.host, .public.port, .private.host, .private.port, "N\/A", .description ] | @tsv'
  ) |
    $COLUMN_OPT -t -s$'\t'
  echo ""
  echo ""
}

check_dhcp() {
    echo "---------------------- DHCP ------------------"
    find /log/blog/ -mmin -120 -name "dhcp*log.gz" |
      sort | xargs zcat -f |
      jq -r '.msg_types=(.msg_types|join("|"))|[."ts", ."server_addr", ."mac", ."host_name", ."requested_addr", ."assigned_addr", ."lease_time", ."msg_types"]|@csv' |
      sed 's="==g' | grep -v "INFORM|ACK" |
      awk -F, 'BEGIN { OFS = "," } { cmd="date -d @"$1; cmd | getline d;$1=d;print;close(cmd)}' |
      $COLUMN_OPT -s "," -t
    echo ""
    echo ""
}

check_redis() {
    echo "---------------------- Redis ----------------------"
    local INTEL_IP=$(redis-cli --scan --pattern intel:ip:*|wc -l)
    local INTEL_IP_COLOR=""
    if [ $INTEL_IP -gt 20000 ]; then
        INTEL_IP_COLOR="\e[31m"
    elif [ $INTEL_IP -gt 10000 ]; then
        INTEL_IP_COLOR="\e[33m"
    fi
    printf "%20s $INTEL_IP_COLOR%10s\e[0m\n" "intel:ip:*" $INTEL_IP
    echo ""
    echo ""
}

check_docker() {
  echo "---------------------- Docker ----------------------"
  sudo systemctl -q is-active docker && sudo docker ps
  echo ""
  echo ""
}

run_ifconfig() {
  echo "---------------------- ifconfig ----------------------"
  ifconfig
  echo ""
  echo ""
}

run_lsusb() {
  echo "---------------------- lsusb ----------------------"
  lsusb
  echo ""
  echo ""
}

check_eth_count() {
  ports=$(find /sys/class/net/ | grep -c "\\eth[0-3]$")

  if [[ ("$PLATFORM" == 'gold' || "$PLATFORM" == 'gold-se') && $ports -ne 4 ||
    ("$PLATFORM" == 'purple' || "$PLATFORM" == 'purple-se') && $ports -ne 2 ||
    ("$PLATFORM" == 'blue' || "$PLATFORM" == 'red' || "$PLATFORM" == 'navy' ) && $ports -ne 1 ]]; then
      printf "\e[41m >>>>>> eth interface number mismatch: %s <<<<<< \e[0m\n" "$ports"
    else
      echo "all good: $ports eth interfaces"
  fi
  echo ""
  echo ""
}

check_events() {
  redis-cli zrange event:log 0 -1 | jq -c '.ts |= (. / 1000 | strftime("%Y-%m-%d %H:%M")) | del(.event_type, .ts0, .labels.wan_intf_uuid) | del(.labels|..|select(type=="object")|.wan_intf_uuid)'
  # hint on stderr so won't impact stuff being piped
  >&2 echo "  >> Keep in mind the timestamps above are all UTC, local timezone is: $(date +'%:::z %Z') <<"
}

usage() {
    echo "Options:"
    echo "  -s  | --service"
    echo "  -sc | --config"
    echo "  -sf | --feature"
    echo "  -r  | --rule"
    echo "  -i  | --ipset"
    echo "  -d  | --dhcp"
    echo "  -re | --redis"
    echo "        --docker"
    echo "  -n  | --network"
    echo "  -p  | --port"
    echo "  -t  | --tag"
    echo "  -e  | --events"
    echo "  -f  | --fast | --host"
    echo "  -h  | --help"
    return
}

FAST=false
while [ "$1" != "" ]; do
    case $1 in
    -s | --service)
        shift
        FAST=true
        check_systemctl_services
        ;;
    -sc | --config)
        shift
        FAST=true
        check_system_config
        ;;
    -sf | --feature)
        shift
        FAST=true
        check_sys_features
        ;;
    -r | --rule)
        shift
        FAST=true
        check_policies
        check_tc_classes
        ;;
    -i | --ipset)
        shift
        FAST=true
        check_ipset
        ;;
    -d | --dhcp)
        shift
        FAST=true
        check_dhcp
        ;;
    -re | --redis)
        shift
        FAST=true
        check_redis
        ;;
    -n | --network)
        shift
        FAST=true
        check_network
        ;;
    -t | --tag)
        shift
        FAST=true
        check_tag
        ;;
    -f | --fast | --host)
        shift
        FAST=true
        check_hosts
        ;;
    -p | --port)
        shift
        FAST=true
        check_portmapping
        ;;
    --docker)
        shift
        FAST=true
        check_docker
        ;;
    -e | --events)
        shift
        FAST=true
        check_events
        ;;
    -h | --help)
        usage
        exit
        ;;
    *)
        usage
        exit 1
        ;;
    esac
done

if [ "$FAST" == false ]; then
    check_systemctl_services
    check_rejection
    check_exception
    check_dmesg_ethernet
    check_wan_conn_log
    check_reboot
    check_system_config
    check_sys_features
    check_policies
    check_tc_classes
    check_ipset
    check_conntrack
    check_dhcp
    check_redis
    run_ifconfig
    check_network
    check_portmapping
    check_tag
    check_hosts
    check_docker
    run_lsusb
    check_eth_count
    test -z $SPEED || check_speed
fi
