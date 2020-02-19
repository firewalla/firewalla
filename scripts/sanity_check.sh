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

    dmesg | grep '1c30000.ethernet' | grep 'Link is Down' -C 3 || echo "Nothing Found"

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

    find /home/pi/logs/ -type f -mtime -2 -exec grep "Possibly Unhandled Rejection" -A 10 {} \;

    echo ""
    echo ""
}

check_exception() {
    echo "----------------------- Node Exceptions ----------------------------"

    find /home/pi/logs/ -type f -mtime -2 -exec egrep -H -i '##### CRASH #####' -A 20 {} \;

    echo ""
    echo ""
}

check_reboot() {
    echo "----------------------- Reboot Record ------------------------------"

    sudo grep REBOOT /var/log/syslog

    echo ""
    echo ""
}

check_each_system_config() {
    local VALUE=$2
    if [[ $VALUE == "" ]]; then
        VALUE="false"
    fi
    printf "%15s %20s\n" "$1" "$VALUE"
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
    printf "%5s %30s %10s %25s %10s %15s\n" "Rule" "Target" "Type" "Device" "Expire" "Scheduler"
    for RULE in $RULES; do
        local RULE_ID=${RULE/policy:/""}
        local TARGET=$(redis-cli hget $RULE target)
        local TYPE=$(redis-cli hget $RULE type)
        local SCOPE=$(redis-cli hget $RULE scope)
        local ALARM_ID=$(redis-cli hget $RULE aid)
        local FLOW_DESCRIPTION=$(redis-cli hget $RULE flowDescription)

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
        printf "%8s %30s %10s %25s %10s %15s\n" "$RULE_ID" "$TARGET" "$TYPE" "$SCOPE" "$EXPIRE" "$CRONTIME"
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

check_hosts() {
    echo "----------------------- Devices ------------------------------"
    local DEVICES=$(redis-cli keys 'host:mac:*')
    printf "%35s %35s %25s %25s %10s %10s %10s %10s\n" "Host" "NAME" "IP" "MAC" "Monitored" "B7" "Online" "vpnClient"
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

        local COLOR=""
        local UNCOLOR="\e[0m"
        if [[ $DEVICE_ONLINE == "yes" && $DEVICE_B7_MONITORING == "false" ]]; then
          if ! is_firewalla $DEVICE_IP && ! is_router $DEVICE_IP; then
            COLOR="\e[91m"
          fi
        fi
        printf "$COLOR %35s %35s %25s %25s %10s %10s %10s %10s $UNCOLOR\n" "$DEVICE_NAME" "$DEVICE_USER_INPUT_NAME" "$DEVICE_IP" "$DEVICE_MAC" "$DEVICE_MONITORING" "$DEVICE_B7_MONITORING" "$DEVICE_ONLINE" "$DEVICE_VPN"
    done

    echo ""
    echo ""
}

check_iptables() {
    echo "---------------------- Active IPset ------------------"
    printf "%25s %10s\n" "IPSET" "NUM"
    local IPSETS=$(sudo iptables -w -L -n | egrep -o "(\<c_[^ ]*\>|blocked_[^ ]*)" | sort | uniq)
    for IPSET in $IPSETS; do
        local NUM=$(sudo ipset list $IPSET -terse | tail -n 1 | sed 's=Number of entries: ==')
        printf "%25s %10s\n" $IPSET $NUM
    done

    echo ""
    echo ""
}

check_sys_features() {
    echo "---------------------- System Features ------------------"

    local HKEYS=$(redis-cli hkeys sys:features)

    for hkey in $HKEYS; do
      check_each_system_config $hkey $(redis-cli hget sys:features $hkey)
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
    check_sys_features
    check_sys_config
    check_policies
    check_iptables
fi
check_hosts
