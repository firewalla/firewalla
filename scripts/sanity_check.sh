#!/bin/bash

check_cloud() {
    echo -n "  checking cloud access ... "
    curl_result=$(curl -w '%{http_code}' -Lks --connect-timeout 5 https://firewalla.encipher.io)
    test $curl_result == '200' && echo OK || { echo "fail($curl_result)"; return 1; }
    return 0
}

check_process() {
    echo -n "  checking process $1 ... "
    ps -ef | grep -w $1 | grep -qv grep && echo OK || { echo fail; return 1; }
    return 0
}

check_partition() {
    echo -n "  checking partition $1 ... "
    mount | grep -qw $1 && echo OK || { echo fail; return 1; }
    return 0
}

check_zram() {
    echo -n "  checking zram ... "
    test $(swapon -s | wc -l) -eq 5 && echo OK || { echo fail; return 1; }
    return 0
}

check_file() {
    echo -n "  check file $1 ... "
    if [[ -n "$2" ]]
    then
        grep -q "$2" $1 && echo OK || { echo fail; return 1; }
    else
        test -f $1 && echo OK || { echo fail; return 1; }
    fi
    return 0
}

check_dmesg_ethernet() {
    echo "----------------------- Ethernet Link Up/Down in dmesg ----------------------------"

    dmesg --time-format iso | grep '1c30000.ethernet' | grep 'Link is Down' -C 3 || echo "Nothing Found"

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
    if [[ -n "$git_output" || $? -ne 0 ]]
    then
        echo fail
        _rc=1
    elif [[ $remote_origin != $(git remote -v | awk '/origin/ {print $2}' | uniq) ]]
    then
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
    local ACTUAL_STATUS=$(systemctl show -p SubState $SERVICE_NAME | sed 's/SubState=//')
    printf "%20s %10s %10s\n" $SERVICE_NAME $EXPECTED_STATUS $ACTUAL_STATUS

}

check_systemctl_services() {
    echo "----------------------- System Services ----------------------------"
    printf "%20s %10s %10s\n" "Service Name" "Expect" "Actual"

    check_each_system_service fireapi "running"
    check_each_system_service firemain "running"
    check_each_system_service firemon "running"
    check_each_system_service firemasq "running"
    check_each_system_service firekick "dead"
    check_each_system_service redis-server "running"
    check_each_system_service openvpn@server "running"
    check_each_system_service watchdog "running"
    check_each_system_service brofish "running"
    check_each_system_service firewalla "dead"
    check_each_system_service fireupgrade "dead"

    echo ""
    echo ""
}

check_rejection() {
    echo "----------------------- Node Rejections ----------------------------"

    find /home/pi/logs/ -type f -mtime -2 -exec grep -a "Possibly Unhandled Rejection" -A 10 {} \;

    echo ""
    echo ""
}

check_exception() {
    echo "----------------------- Node Exceptions ----------------------------"

    find /home/pi/logs/ -type f -mtime -2 -exec egrep -a -H -i '##### CRASH #####' -A 20 {} \;

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
    printf "%30s %20s\n" "$1" "$VALUE"
}

get_redis_key_with_no_ttl() {
    local OUTPUT=$(redis-cli info keyspace | tail -n 1 | awk -F: '{print $2}')
    local TOTAL=$(echo $OUTPUT | sed 's/keys=//' | sed 's/,.*$//')
    local EXPIRES=$(echo $OUTPUT | sed 's/.*expires=//' | sed 's/,.*$//')
    local NOTTL=$(( $TOTAL - $EXPIRES ))

    local COLOR=""
    local UNCOLOR="\e[0m"
    if [[ $NOTTL -gt 1000 ]]; then
        COLOR="\e[91m"
    fi

    echo -e "$COLOR $NOTTL $UNCOLOR"
}

check_system_config() {
    echo "----------------------- System Config ------------------------------"
    check_each_system_config Mode $(redis-cli get mode)
    check_each_system_config "Adblock" $(redis-cli hget policy:system adblock)
    check_each_system_config "Family" $(redis-cli hget policy:system family)
    check_each_system_config "Monitor" $(redis-cli hget policy:system monitor)
    check_each_system_config "vpnAvailable" $(redis-cli hget policy:system vpnAvaliable)
    check_each_system_config "vpn" $(redis-cli hget policy:system vpn)
    check_each_system_config "Redis Usage" $(redis-cli info | grep memory_human | awk -F: '{print $2}')
    check_each_system_config "Redis Total Key" $(redis-cli dbsize)
    check_each_system_config "Redis key without ttl"  "$(get_redis_key_with_no_ttl)"

    echo ""
    echo ""
}

check_policies() {
    echo "----------------------- Blocking Rules ------------------------------"
    local RULES=$(redis-cli keys 'policy:*' | egrep "policy:[0-9]+$" | sort -t: -n -k 2)
    printf "%5s %30s %10s %25s %10s %15s %15s %10s %15s\n" "Rule" "Target" "Type" "Device" "Expire" "Scheduler" "Tag" "Direction" "Action"
    for RULE in $RULES; do
        local RULE_ID=${RULE/policy:/""}
        local TARGET=$(redis-cli hget $RULE target)
        local TYPE=$(redis-cli hget $RULE type)
        local SCOPE=$(redis-cli hget $RULE scope)
        local ALARM_ID=$(redis-cli hget $RULE aid)
        local FLOW_DESCRIPTION=$(redis-cli hget $RULE flowDescription)
        local ACTION=$(redis-cli hget $RULE action)
        if [[ "x$ACTION" == "x" ]]; then
            ACTION="block"
        fi
        local DIRECTION=$(redis-cli hget $RULE direction)
        if [[ "x$DIRECTION" == "x" || "x$DIRECTION" == "xbidirection" ]]; then
            DIRECTION="both"
        fi
        local TAG=$(redis-cli hget $RULE tag)
        if [[ "x$TAG" != "x" ]]; then
            TAG="${TAG:2:13}"
        fi
        TAG="${TAG/\"]/}"

        if [[ ! -n $SCOPE ]]; then
            SCOPE="All Devices"
        fi
        local EXPIRE=$(redis-cli hget $RULE expire)
        if [[ ! -n $EXPIRE ]]; then
            EXPIRE="Infinite"
        fi
        local CRONTIME=$(redis-cli hget $RULE cronTime)
        if [[ ! -n $CRONTIME ]]; then
            CRONTIME="Always"
        fi
        if [[ -n $ALARM_ID ]]; then
            RULE_ID="* $RULE_ID"
        elif [[ -n $FLOW_DESCRIPTION ]]; then
            RULE_ID="** $RULE_ID"
        fi
        printf "%8s %30s %10s %25s %10s %15s %15s %10s %15s\n" "$RULE_ID" "$TARGET" "$TYPE" "$SCOPE" "$EXPIRE" "$CRONTIME" "$TAG" "$DIRECTION" "$ACTION"
    done

    echo ""
    echo "Note: * - created from alarm, ** - created from network flow"
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
    local DEVICES=$(redis-cli keys 'host:mac:*')
    printf "%35s %35s %25s %25s %10s %10s %10s %10s %12s %13s %20s\n" "Host" "NAME" "IP" "MAC" "Monitored" "B7" "Online" "vpnClient" "FlowInCount" "FlowOutCount" "Group"
    NOW=$(date +%s)
    for DEVICE in $DEVICES; do
        local DEVICE_NAME=$(redis-cli hget $DEVICE bname)
        local DEVICE_USER_INPUT_NAME=$(redis-cli hget $DEVICE name)
        local DEVICE_IP=$(redis-cli hget $DEVICE ipv4Addr)
        local DEVICE_MAC=${DEVICE/host:mac:/""}
        local POLICY_MAC="policy:mac:${DEVICE_MAC}"
        local DEVICE_MONITORING=$(redis-cli hget $POLICY_MAC monitor)
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

        local DEVICE_ONLINE_TS=$(redis-cli hget $DEVICE lastActiveTimestamp)
        DEVICE_ONLINE_TS=${DEVICE_ONLINE_TS%.*}
        if [[ ! -n $DEVICE_ONLINE_TS ]]; then
            local DEVICE_ONLINE="N/A"
            else
                if (( $DEVICE_ONLINE_TS > $NOW - 1800 )); then
                    local DEVICE_ONLINE="yes"
                else
                    local DEVICE_ONLINE="no"
                fi
        fi

        local DEVICE_VPN="N/A"
        local DEVICE_VPN_INFO=$(redis-cli hget $POLICY_MAC vpnClient)
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

        local COLOR=""
        local UNCOLOR="\e[0m"
        if [[ $DEVICE_ONLINE == "yes" && $DEVICE_B7_MONITORING == "false" ]]; then
          if ! is_firewalla $DEVICE_IP && ! is_router $DEVICE_IP && is_simple_mode; then
            COLOR="\e[91m"
          fi
        fi
        local TAGS=$(redis-cli hget $POLICY_MAC tags | sed "s=\[==" | sed "s=\]==" | sed "s=,= =")
        TAGNAMES=""
        for tag in $TAGS; do
            TAGNAMES="$(redis-cli hget tag:uid:$tag name | tr -d '\n')[$tag],"
        done
        TAGNAMES=$(echo $TAGNAMES | sed 's=,$==')
        printf "$COLOR %35s %35s %25s %25s %10s %10s %10s %10s %12s %13s %20s$UNCOLOR\n" "$DEVICE_NAME" "$DEVICE_USER_INPUT_NAME" "$DEVICE_IP" "$DEVICE_MAC" "$DEVICE_MONITORING" "$DEVICE_B7_MONITORING" "$DEVICE_ONLINE" "$DEVICE_VPN" "$DEVICE_FLOWINCOUNT" "$DEVICE_FLOWOUTCOUNT" "$TAGNAMES"
    done

    echo ""
    echo ""
}

check_iptables() {
    echo "---------------------- Active IPset ------------------"
    printf "%25s %10s\n" "IPSET" "NUM"
    local IPSETS=$(sudo iptables -w -L -n | egrep -o "match-set [^ ]*" | sed 's=match-set ==' | sort | uniq)
    for IPSET in $IPSETS; do
        local NUM=$(sudo ipset list $IPSET -terse | tail -n 1 | sed 's=Number of entries: ==')
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
    if [[ -f "$FILE" ]]; then
        local JSON=$(python -c "import json; obj=json.load(open('$FILE')); obj2='\n'.join([key + '=' + str(value) for key,value in obj['userFeatures'].items()]); print obj2;")
        while IFS="=" read -r key value
        do
            FEATURES["$key"]="$value"
        done <<< "$JSON"
    fi

    FILE="$HOME/.firewalla/config/config.json"
    if [[ -f "$FILE" ]]; then
        local JSON=$(python -c "import json; obj=json.load(open('$FILE')); obj2='\n'.join([key + '=' + str(value) for key,value in obj['userFeatures'].items()]) if obj.has_key('userFeatures') else ''; print obj2;")
        if [[ "$JSON" != "" ]]; then
            while IFS="=" read -r key value
            do
                FEATURES["$key"]="$value"
            done <<< "$JSON"
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
    if [[ $(uname -m) != "x86_64" ]]; then
        return
    fi

    echo "---------------------- Network ------------------"
    curl localhost:8837/v1/config/interfaces -o /tmp/scc_interfaces &>/dev/null
    INTFS=$(cat /tmp/scc_interfaces | jq 'keys' | jq -r .[])

    echo "Interface,Name,UUID,Enabled,IPv4,IPv6,Gateway,Gateway6,DNS" > /tmp/scc_csv
    for INTF in $INTFS; do
        cat /tmp/scc_interfaces | jq -r ".[\"$INTF\"] | [\"$INTF\", .config.meta.name // \"\", .config.meta.uuid[0:8], .config.enabled, .state.ip4 // \"\", (.state.ip6 // [] | join(\",\")), .state.gateway // \"\", .state.gateway6 // \"\", (.state.dns // [] | join(\";\"))] | @csv" >> /tmp/scc_csv
    done
    cat /tmp/scc_csv | column -t -s, | sed 's=\"==g'
    echo ""
    echo ""
}

usage() {
    return
}

FAST=false
while [ "$1" != "" ]; do
    case $1 in
        -f | --fast )           shift
                                FAST=true
                                ;;
        -h | --help )           usage
                                exit
                                ;;
        * )                     usage
                                exit 1
    esac
    shift
done


if [ "$FAST" == false ]; then
    check_systemctl_services
    check_rejection
    check_exception
    check_dmesg_ethernet
    check_reboot
    check_system_config
    check_network
    check_sys_features
    check_sys_config
    check_policies
    check_iptables
    check_conntrack
    test -z $SPEED || check_speed
fi
check_hosts
