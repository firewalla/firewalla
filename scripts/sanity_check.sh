#!/bin/bash

UNAME=$(uname -m)
case "$UNAME" in
  "x86_64")
    PLATFORM='gold'
    ;;
  "aarch64")
    if [[ -e /etc/firewalla-release ]]; then
      PLATFORM=$( . /etc/firewalla-release 2>/dev/null && echo $BOARD || cat /etc/firewalla-release )
    else
      PLATFORM='unknown'
    fi
    ;;
  "armv7l")
    PLATFORM='red'
    ;;
  *)
    PLATFORM='unknown'
    ;;
esac

check_wan_conn_log() {
  if [[ $PLATFORM != "gold" ]]; then
    return 0
  fi
  echo "---------------------------- WAN Connectivity Check Failures ----------------------------"
  cat ~/.forever/router*.log  | grep "WanConnCheckSensor" | grep -e "all ping test \| DNS \| Wan connectivity test failed" | sort | tail -n 50
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

check_git() {
    _rc=0
    repo_dir=$1
    remote_origin=$2
    echo -n "  check Git repository $repo_dir ... "
    pushd $repo_dir >/dev/null
    git_output=$(git status -uno --porcelain 2>&1)
    if [[ -n "$git_output" || $? -ne 0 ]]; then
        echo fail
        _rc=1
    elif [[ $remote_origin != $(git remote -v | awk '/origin/ {print $2}' | uniq) ]]; then
        echo fail
        _rc=1
    else
        echo OK
    fi
    popd >/dev/null
    return $_rc
}

check_each_system_service() {
    local SERVICE_NAME=$1
    local EXPECTED_STATUS=$2
    local RESTART_TIMES=$(systemctl show $1 -p NRestarts | awk -F= '{print $2}')
    local ACTUAL_STATUS=$(systemctl status $1 | grep 'Active: ' | sed 's=Active: ==')
    printf "%20s %10s %5s %s\n" $SERVICE_NAME $EXPECTED_STATUS "$RESTART_TIMES" "$ACTUAL_STATUS"

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

    if redis-cli hget policy:system vpn | fgrep -q '"state":true'
    then
      vpn_run_state='running'
    else
      vpn_run_state='dead'
    fi
    check_each_system_service openvpn@server $vpn_run_state

    if [[ $PLATFORM != 'gold' ]]; then # non gold
        check_each_system_service firemasq "running"
        check_each_system_service watchdog "running"
    else # gold
        check_each_system_service firerouter "running"
        check_each_system_service firerouter_dns "running"
        check_each_system_service firerouter_dhcp "running"
    fi

    echo ""
    echo ""
}

check_rejection() {
    echo "----------------------- Node Rejections ----------------------------"

    find /home/pi/logs/ -type f -mtime -2 -exec bash -c 'grep -a "Possibly Unhandled Rejection" -A 10 -B 2 {} | tail -n 300' \;

    echo ""
    echo ""
}

check_exception() {
    echo "----------------------- Node Exceptions ----------------------------"

    find /home/pi/logs/ -type f -mtime -2 -exec bash -c "egrep -a -H -i '##### CRASH #####' -A 20 {} | tail -n 300" \;

    echo ""
    echo ""
}

check_reboot() {
    echo "----------------------- Reboot Record ------------------------------"

    sudo grep -a REBOOT /var/log/syslog

    echo ""
    echo ""
}

check_each_system_config() {
    local VALUE=$2
    if [[ $VALUE == "" ]]; then
        VALUE="false"
    elif [[ $VALUE == "1" ]]; then
        VALUE="true"
    elif [[ $VALUE == "0" ]]; then
        VALUE="false"
    fi
    if [[ $3 == "reverse" ]]; then
        if [[ $VALUE == "false" ]]; then
            VALUE="true"
        else
            VALUE="false"
        fi
    fi
    printf "%30s %20s\n" "$1" "$VALUE"
}

get_redis_key_with_no_ttl() {
    local OUTPUT=$(redis-cli info keyspace | tail -n 1 | awk -F: '{print $2}')
    local TOTAL=$(echo $OUTPUT | sed 's/keys=//' | sed 's/,.*$//')
    local EXPIRES=$(echo $OUTPUT | sed 's/.*expires=//' | sed 's/,.*$//')
    local NOTTL=$(($TOTAL - $EXPIRES))

    local COLOR=""
    local UNCOLOR="\e[0m"
    if [[ $NOTTL -gt 1000 ]]; then
        COLOR="\e[91m"
    fi

    echo -e "$COLOR $NOTTL $UNCOLOR"
}

get_mode() {
    MODE=$(redis-cli get mode)
    if [ $MODE = "spoof" ] && [ "$(redis-cli hget policy:system enhancedSpoof)" = "true" ]; then
        echo "enhancedSpoof"
    else
        echo "$MODE"
    fi
}

check_system_config() {
    echo "----------------------- System Config ------------------------------"
    check_each_system_config "Mode" $(get_mode)
    check_each_system_config "Adblock" $(redis-cli hget policy:system adblock)
    check_each_system_config "Family" $(redis-cli hget policy:system family)
    check_each_system_config "Monitor" $(redis-cli hget policy:system monitor)
    check_each_system_config "Emergency Access" $(redis-cli hget policy:system acl) reverse
    check_each_system_config "vpnAvailable" $(redis-cli hget policy:system vpnAvaliable)
    check_each_system_config "vpn" $(redis-cli hget policy:system vpn)
    check_each_system_config "Redis Usage" $(redis-cli info | grep memory_human | awk -F: '{print $2}')
    check_each_system_config "Redis Total Key" $(redis-cli dbsize)
    check_each_system_config "Redis key without ttl" "$(get_redis_key_with_no_ttl)"

    echo ""
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

# reads redis hash with key $2 into associative array $1
read_hash() {
  # make an alias of $1, https://unix.stackexchange.com/a/462089
  declare -n a="$1"
  local hash=()
  readarray -t hash < <(redis-cli hgetall $2)
  for ((i=0; i<${#hash[@]}; i++)); do
    a["${hash[$i]}"]="${hash[$i+1]}"
    ((i++))
  done
}

check_policies() {
    echo "--------------------------- Rules ----------------------------------"
    local RULES=$(redis-cli keys 'policy:*' | egrep "policy:[0-9]+$" | sort -t: -n -k 2)

    echo "Rule|Device|Expire|Scheduler|Tag|Proto|TosDir|RateLmt|Pri|Disabled">/tmp/scc_csv
    printf "%8s %45s %11s %22s %10s %25s %15s %5s %8s %5s %9s %9s %9s\n" "Rule" "Target" "Type" "Device" "Expire" "Scheduler" "Tag" "Dir" "Action" "Proto" "LPort" "RPort" "Disabled"
    for RULE in $RULES; do
        local RULE_ID=${RULE/policy:/""}
        declare -A p
        read_hash p $RULE

        local TYPE=${p["type"]}
        if [[ $TYPE == "dns" || $TYPE == 'domain' ]]; then
          if [[ ${p[dnsmasq_only]} == 'true' || ${p[dnsmasq_only]} == '1'  ]]; then
            TYPE=$TYPE'_only'
          fi
        fi
        local ACTION=${p[action]}
        local TRAFFIC_DIRECTION=${p[trafficDirection]}
        TRAFFIC_DIRECTION=${TRAFFIC_DIRECTION%load} # remove 'load' from end of string
        local DISABLED=${p[disabled]}

        local COLOR=""
        local UNCOLOR="\e[0m"

        if [[ "x$ACTION" == "x" ]]; then
            ACTION="block"
        elif [ "$ACTION" = "allow" ]; then
            COLOR="\e[38;5;28m"
        fi

        if [[ $DISABLED == "1" ]]; then
            DISABLED=true
            COLOR="\e[2m" #dim
        else
            DISABLED=false
        fi

        local DIRECTION=${p[direction]}
        if [[ "x$DIRECTION" == "x" || "x$DIRECTION" == "xbidirection" ]]; then
            DIRECTION="both"
        else
            DIRECTION=${DIRECTION%bound} # remove 'bound' from end of string
        fi
        local TAG=${p[tag]}
        if [[ "x$TAG" != "x" ]]; then
            TAG="${TAG:2:13}"
        fi
        TAG="${TAG/\"]/}"

        local SCOPE=${p[scope]}
        if [[ ! -n $SCOPE ]]; then
            SCOPE="All Devices"
        fi
        local EXPIRE=${p[expire]}
        if [[ ! -n $EXPIRE ]]; then
            EXPIRE="Infinite"
        fi
        local CRONTIME=${p[cronTime]}
        if [[ ! -n $CRONTIME ]]; then
            CRONTIME="Always"
        fi

        local ALARM_ID=${p[aid]}
        if [[ -n $ALARM_ID ]]; then
            RULE_ID="* $RULE_ID"
        elif [[ -n ${p[flowDescription]} ]]; then
            RULE_ID="** $RULE_ID"
        fi
        if [[ $ACTION == 'qos' ]]; then
          echo "$RULE_ID|$SCOPE|$EXPIRE|$CRONTIME|$TAG|${p[protocol]}|$TRAFFIC_DIRECTION|${p[rateLimit]}|${p[priority]}|$DISABLED">>/tmp/scc_csv
        else
          printf "$COLOR%8s %45s %11s %22s %10s %25s %15s %5s %8s %5s %9s %9s %9s$UNCOLOR\n" "$RULE_ID" "${p[target]}" "$TYPE" "$SCOPE" "$EXPIRE" "$CRONTIME" "$TAG" "$DIRECTION" "$ACTION" "${p[protocol]}" "${p[localPort]}" "${p[remotePort]}" "$DISABLED"
        fi;

        unset p
    done

    echo ""
    echo "Note: * - created from alarm, ** - created from network flow"

    echo ""
    echo "QoS Rules:"
    cat /tmp/scc_csv | column -t -s '|' -n | sed 's=\ "\([^"]*\)\"= \1  =g'

    echo ""
    echo ""
}

is_router() {
    GW=$(/sbin/ip route show | awk '/default via/ {print $3}')
    if [[ $GW == $1 ]]; then
        return 0
    else
        return 1
    fi
}

is_firewalla() {
    IP=$(/sbin/ip addr show dev eth0 | awk '/inet /' | awk '$NF=="eth0" {print $2}' | fgrep -v 169.254. | fgrep -v -w 0.0.0.0 | fgrep -v -w 255.255.255.255 | awk -F/ '{print $1}')
    if [[ $IP == $1 ]]; then
        return 0
    else
        return 1
    fi
}

is_simple_mode() {
    MODE=$(redis-cli get mode)
    if [[ $MODE == "spoof" ]]; then
        return 0
    fi

    return 1
}

check_hosts() {
    echo "----------------------- Devices ------------------------------"

    # read all enabled newDeviceTag tags
    if [[ "$(redis-cli hget sys:features new_device_tag)" == "1" ]]; then
      NEW_DEVICE_TAGS=( $(redis-cli hget policy:system newDeviceTag | jq "select(.state == true) | .tag") )
      while read POLICY_KEY; do
        test -n "$POLICY_KEY" && NEW_DEVICE_TAGS+=( $(redis-cli hget $POLICY_KEY newDeviceTag | jq "select(.state == true) | .tag") );
      done < <(redis-cli keys 'policy:network:*')
    else
      NEW_DEVICE_TAGS=( )
    fi

    local DEVICES=$(redis-cli keys 'host:mac:*')
    printf "%35s %15s %25s %25s %20s %7s %6s %6s %10s %7s %8s %20s %10s\n" "Host" "NETWORKNAME" "NAME" "IP" "MAC" "Monitor" "B7" "Online" "vpnClient" "FlowIn" "FlowOut" "Group" "Emerg Acc"
    NOW=$(date +%s)
    FRCC=$(curl -s "http://localhost:8837/v1/config/active")
    for DEVICE in $DEVICES; do

        local DEVICE_MAC=${DEVICE/host:mac:/""}
        # hide vpn_profile:*
        if [[ ${DEVICE_MAC,,} == "vpn_profile:"* ]]; then
            continue
        fi

        declare -A h
        read_hash h $DEVICE

        local DEVICE_ONLINE_TS=${h[lastActiveTimestamp]}
        DEVICE_ONLINE_TS=${DEVICE_ONLINE_TS%.*}
        if [[ ! -n $DEVICE_ONLINE_TS ]]; then
            local DEVICE_ONLINE="N/A"
        elif (($DEVICE_ONLINE_TS < $NOW - 2592000)); then # 30days ago, hide entry
            unset h
            continue
        elif (($DEVICE_ONLINE_TS > $NOW - 1800)); then
            local DEVICE_ONLINE="yes"
        else
            local DEVICE_ONLINE="no"
        fi

        local DEVICE_NAME=${h[bname]}
        local DEVICE_NETWORK_NAME=
        if [[ -n "$FRCC" ]]; then
            local DEVICE_INTF=${h[intf]}
            DEVICE_NETWORK_NAME=$(echo "$FRCC"| jq -r ".interface|..|select(.uuid?==\"${DEVICE_INTF}\")|.name")
            # : ${DEVICE_NETWORK_NAME:='NA'}
        fi
        local DEVICE_IP=${h[ipv4Addr]}
        local DEVICE_MAC=${DEVICE/host:mac:/""}
        local DEVICE_MAC_VENDOR=${h[macVendor]}
        local POLICY_MAC="policy:mac:${DEVICE_MAC}"
        local DEVICE_MONITORING=${h[monitor]}
        local DEVICE_EMERGENCY_ACCESS=false
        if [[ ${h[acl]} == "false" ]]; then
            DEVICE_EMERGENCY_ACCESS="true"
        fi

        if [[ ! -n $DEVICE_MONITORING ]]; then
            if ! is_firewalla $DEVICE_IP && ! is_router $DEVICE_IP; then
                DEVICE_MONITORING="true"
            else
                DEVICE_MONITORING="N/A"
            fi
        fi
        local DEVICE_B7_MONITORING_FLAG=$(redis-cli sismember monitored_hosts $DEVICE_IP)
        local DEVICE_B7_MONITORING=""
        if [[ $DEVICE_B7_MONITORING_FLAG == "1" ]]; then
            DEVICE_B7_MONITORING="true"
        else
            DEVICE_B7_MONITORING="false"
        fi

        local DEVICE_VPN="N/A"
        local DEVICE_VPN_INFO=${h[vpnClient]}
        if [[ -n $DEVICE_VPN_INFO ]]; then
            local DEVICE_VPN_TRUE=$(echo $DEVICE_VPN_INFO | grep '\"state\":true')
            local DEVICE_VPN_FALSE=$(echo $DEVICE_VPN_INFO | grep '\"state\":false')
            if [[ -n $DEVICE_VPN_TRUE ]]; then
                DEVICE_VPN="true"
            elif [[ -n $DEVICE_VPN_FALSE ]]; then
                DEVICE_VPN="false"
            fi
        fi

        local DEVICE_FLOWINCOUNT=$(redis-cli zcount flow:conn:in:$DEVICE_MAC -inf +inf)
        local DEVICE_FLOWOUTCOUNT=$(redis-cli zcount flow:conn:out:$DEVICE_MAC -inf +inf)

        local TAGS=$(redis-cli hget $POLICY_MAC tags | sed "s=[][\" ]==g" | sed "s=,= =")
        TAGNAMES=""
        for tag in $TAGS; do
            TAGNAMES="$(redis-cli hget tag:uid:$tag name | tr -d '\n')[$tag],"
        done
        TAGNAMES=$(echo $TAGNAMES | sed 's=,$==')

        # === COLOURING ===
        local COLOR="\e[39m"
        local UNCOLOR="\e[0m"
        local BGCOLOR="\e[49m"
        local BGUNCOLOR="\e[49m"
        if [[ $DEVICE_ONLINE == "yes" && $DEVICE_MONITORING == 'true' && $DEVICE_B7_MONITORING == "false" ]] &&
          ! is_firewalla $DEVICE_IP && ! is_router $DEVICE_IP && is_simple_mode; then
            COLOR="\e[91m"
        elif [ $DEVICE_FLOWINCOUNT -gt 2000 ] || [ $DEVICE_FLOWOUTCOUNT -gt 2000 ]; then
            COLOR="\e[33m" #yellow
        fi
        if [[ ${DEVICE_NAME,,} == "circle"* || ${DEVICE_MAC_VENDOR,,} == "circle"* ]]; then
            BGCOLOR="\e[41m"
        fi

        local MAC_COLOR="$COLOR"
        if [[ $DEVICE_MAC =~ ^.[26AEae].*$ ]] && ! is_firewalla $DEVICE_IP; then
          MAC_COLOR="\e[35m"
        fi

        TAG_COLOR="$COLOR"
        if [[ " ${NEW_DEVICE_TAGS[@]} " =~ " ${TAGS} " ]]; then
          TAG_COLOR="\e[31m"
        fi

        if [ $DEVICE_ONLINE = "no" ]; then
            COLOR=$COLOR"\e[2m" #dim
        fi

        printf "$BGCOLOR$COLOR%35s %15s %25s %25s $MAC_COLOR%20s$COLOR %7s %6s %6s %10s %7s %8s $TAG_COLOR%20s$COLOR %10s$UNCOLOR$BGUNCOLOR\n" "$DEVICE_NAME" "$DEVICE_NETWORK_NAME" "${h[name]}" "$DEVICE_IP" "$DEVICE_MAC" "$DEVICE_MONITORING" "$DEVICE_B7_MONITORING" "$DEVICE_ONLINE" "$DEVICE_VPN" "$DEVICE_FLOWINCOUNT" "$DEVICE_FLOWOUTCOUNT" "$TAGNAMES" "$DEVICE_EMERGENCY_ACCESS"

        unset h
    done

    echo ""
    echo ""
}

check_ipset() {
    echo "---------------------- Active IPset ------------------"
    printf "%25s %10s\n" "IPSET" "NUM"
    local IPSETS=$(sudo iptables -w -L -n | egrep -o "match-set [^ ]*" | sed 's=match-set ==' | sort | uniq)
    for IPSET in $IPSETS; do
        local NUM=$(($(sudo ipset -S $IPSET | wc -l)-1))
        local COLOR=""
        local UNCOLOR="\e[0m"
        if [[ $NUM > 0 ]]; then
            COLOR="\e[91m"
        fi
        printf "%25s $COLOR%10s$UNCOLOR\n" $IPSET $NUM
    done

    echo ""
    echo ""
}

check_sys_features() {
    echo "---------------------- System Features ------------------"
    declare -A FEATURES
    local FILE="$FIREWALLA_HOME/net2/config.json"
    local USERFILE="$HOME/.firewalla/config/config.json"

    # use jq where available
    if [[ "$PLATFORM" == 'gold' || "$PLATFORM" == 'navy' || "$PLATFORM" == 'purple' ]]; then
      if [[ -f "$FILE" ]]; then
        jq -r '.userFeatures // {} | to_entries[] | "\(.key) \(.value)"' $FILE |
        while read key value; do
          FEATURES["$key"]="$value"
        done
      fi

      if [[ -f "$USERFILE" ]]; then
        jq -r '.userFeatures // {} | to_entries[] | "\(.key) \(.value)"' $USERFILE |
        while read key value; do
          FEATURES["$key"]="$value"
        done
      fi
    else
      # lagacy python 2.7 solution
      if [[ -f "$FILE" ]]; then
        local JSON=$(python -c "import json; obj=json.load(open('$FILE')); obj2='\n'.join([key + '=' + str(value) for key,value in obj['userFeatures'].items()]); print obj2;")
        while IFS="=" read -r key value; do
          FEATURES["$key"]="$value"
        done <<<"$JSON"
      fi

      if [[ -f "$USERFILE" ]]; then
        local JSON=$(python -c "import json; obj=json.load(open('$USERFILE')); obj2='\n'.join([key + '=' + str(value) for key,value in obj['userFeatures'].items()]) if obj.has_key('userFeatures') else ''; print obj2;")
        if [[ "$JSON" != "" ]]; then
          while IFS="=" read -r key value; do
            FEATURES["$key"]="$value"
          done <<<"$JSON"
        fi
      fi
    fi

    local HKEYS=$(redis-cli hkeys sys:features)
    for hkey in $HKEYS; do
        FEATURES["$hkey"]=$(redis-cli hget sys:features $hkey)
    done

    for key in ${!FEATURES[*]}; do
        check_each_system_config $key ${FEATURES[$key]}
    done

    echo ""
    echo ""
}

check_sys_config() {
    echo "---------------------- System Configs ------------------"

    local HKEYS=$(redis-cli hkeys sys:config)

    for hkey in $HKEYS; do
        check_each_system_config $hkey $(redis-cli hget sys:config $hkey)
    done

    echo ""
    echo ""
}

check_speed() {
    echo "---------------------- Speed ------------------"
    UNAME=$(uname -m)
    test $UNAME == "x86_64" && curl --connect-timeout 10 -L https://github.com/firewalla/firewalla/releases/download/v1.963/fast_linux_amd64 -o /tmp/fast 2>/dev/null && chmod +x /tmp/fast && /tmp/fast
    test $UNAME == "aarch64" && curl --connect-timeout 10 -L https://github.com/firewalla/firewalla/releases/download/v1.963/fast_linux_arm64 -o /tmp/fast 2>/dev/null && chmod +x /tmp/fast && /tmp/fast
    test $UNAME == "armv7l" && curl --connect-timeout 10 -L https://github.com/firewalla/firewalla/releases/download/v1.963/fast_linux_arm -o /tmp/fast 2>/dev/null && chmod +x /tmp/fast && /tmp/fast
}

check_conntrack() {
    echo "---------------------- Conntrack Count------------------"

    cat /proc/sys/net/netfilter/nf_conntrack_count

    echo ""
    echo ""
}

check_network() {
    if [[ $PLATFORM != "gold" && $PLATFORM != "purple" ]]; then
        return
    fi

    echo "---------------------- Network ------------------"
    curl localhost:8837/v1/config/interfaces -o /tmp/scc_interfaces &>/dev/null
    INTFS=$(cat /tmp/scc_interfaces | jq 'keys' | jq -r .[])

    echo "Interface,Name,UUID,Enabled,IPv4,Gateway,IPv6,Gateway6,DNS" >/tmp/scc_csv
    for INTF in $INTFS; do
      cat /tmp/scc_interfaces | jq -r ".[\"$INTF\"] | if (.state.ip6 | length) == 0 then .state.ip6 |= [] else . end | [\"$INTF\", .config.meta.name, .config.meta.uuid[0:8], .config.enabled, .state.ip4, .state.gateway, (.state.ip6 | join(\"|\")), .state.gateway6, (.state.dns // [] | join(\";\"))] | @csv" >>/tmp/scc_csv
    done

    > /tmp/scc_csv_multline
    while read -r LINE; do
      mapfile -td ',' COL <<< $LINE
      mapfile -td '|' IP6 < <(echo ${COL[6]}| xargs) #remove quotes with xargs
      if [[ ${#IP6[@]} -gt 1 ]]; then
        for IDX in "${!IP6[@]}"; do
          if [ $IDX -eq 0 ]; then
            echo -n "${COL[0]},${COL[1]},${COL[2]},${COL[3]},${COL[4]},${COL[5]},\"${IP6[0]}\",${COL[7]},${COL[8]}" >> /tmp/scc_csv_multline
          else
            echo '"","","","","","","'${IP6[$IDX]}'","",""' >> /tmp/scc_csv_multline
          fi
        done
      else
        echo $LINE >> /tmp/scc_csv_multline
      fi
    done < /tmp/scc_csv
    cat /tmp/scc_csv_multline | column -t -s, -n | sed 's=\"\([^"]*\)\"=\1  =g'
    echo ""

    #check source NAT
    WANS=( $(cat /tmp/scc_interfaces | jq -r ". | to_entries | .[] | select(.value.config.meta.type == \"wan\") | .key") )
    SOURCE_NAT=( $(curl localhost:8837/v1/config/active 2>/dev/null | jq -r ".nat | keys | .[]" | cut -d - -f 2 | sort | uniq) )
    echo "WAN Interfaces:"
    for WAN in "${WANS[@]}"; do
      if [[ " ${SOURCE_NAT[@]} " =~ " ${WAN} " ]]; then
        printf "%10s: Source NAT ON\n" $WAN
      else
        printf "\e[31m%10s: Source NAT OFF\e[0m\n" $WAN
      fi
    done
    echo ""
    echo ""
}

check_portmapping() {
  echo "------------------ Port Forwarding ------------------"

  (
    echo "type,active,Proto,ExtPort,toIP,toPort,toMac,fw,description"
    redis-cli get extension.portforward.config |
      jq -r '.maps[] | select(.state == true) | "\"\(._type // "Forward")\",\"\(.active)\",\"\(.protocol)\",\"\(.dport)\",\"\(.toIP)\",\"\(.toPort)\",\"\(.toMac)\",\"\(.autoFirewall)\",\"\(.description)\""'
    redis-cli hget sys:scan:nat upnp |
      jq -r '.[] | "\"UPnP\",\"\(.expire)\",\"\(.protocol)\",\"\(.public.port)\",\"\(.private.host)\",\"\(.private.port)\",\"N\/A\",\"N\/A\",\"\(.description)\""'
  ) |
  column -t -s, -n | sed 's=\"\([^"]*\)\"=\1  =g'
  echo ""
  echo ""
}

check_dhcp() {
    echo "---------------------- DHCP ------------------"
    find /blog/ -mmin -120 -name "dhcp*log.gz" |
      sort | xargs zcat -f |
      jq -r '.msg_types=(.msg_types|join("|"))|[."ts", ."server_addr", ."mac", ."host_name", ."requested_addr", ."assigned_addr", ."lease_time", ."msg_types"]|@csv' |
      sed 's="==g' | grep -v "INFORM|ACK" |
      awk -F, 'BEGIN { OFS = "," } { "date -d @"$1 | getline d;$1=d;print}' |
      column -s "," -t -n
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
  sudo docker ps
  echo ""
  echo ""
}

usage() {
    echo "Options:"
    echo "  -s  | --service"
    echo "  -n  | --network"
    echo "  -sc | --config"
    echo "  -sf | --feature"
    echo "  -r  | --rule"
    echo "  -i  | --ipset"
    echo "  -d  | --dhcp"
    echo "  -re | --redis"
    echo "        --docker"
    echo "  -f  | --fast | --host"
    echo "  -h  | --help"
    return
}

FAST=false
while [ "$1" != "" ]; do
    case $1 in
    -s | --service)
        shift
        check_systemctl_services
        FAST=true
        ;;
    -n | --network)
        shift
        check_network
        FAST=true
        ;;
    -sc | --config)
        shift
        check_system_config
        check_sys_config
        FAST=true
        ;;
    -sf | --feature)
        shift
        check_sys_features
        FAST=true
        ;;
    -r | --rule)
        shift
        check_policies
        check_tc_classes
        FAST=true
        ;;
    -i | --ipset)
        shift
        check_ipset
        FAST=true
        ;;
    -d | --dhcp)
        shift
        check_dhcp
        FAST=true
        ;;
    -re | --redis)
        shift
        check_redis
        FAST=true
        ;;
    -f | --fast | --host)
        check_hosts
        shift
        FAST=true
        ;;
    -p | --port)
        check_portmapping
        shift
        FAST=true
        ;;
    --docker)
        check_docker
        shift
        FAST=true
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
    check_sys_config
    check_policies
    check_tc_classes
    check_ipset
    check_conntrack
    check_dhcp
    check_redis
    check_network
    check_portmapping
    check_hosts
    check_docker
    test -z $SPEED || check_speed
fi
