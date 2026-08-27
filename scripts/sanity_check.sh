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

# Terminal display width (number of columns) of a single Unicode code point,
# returned in $REPLY. Wide CJK characters and most emoji occupy 2 columns;
# combining marks, zero-width joiners, variation selectors and emoji skin-tone
# modifiers occupy 0. Everything else is 1.
# Note: still imperfect for emoji ZWJ sequences (e.g. family emoji), which
# terminals render inconsistently anyway.
charwidth() {
  local -i code=$1
  # zero-width: combining marks (0300-036F etc.), zero-width space/joiner
  # (200B-200F), variation selectors (FE00-FE0F), emoji skin-tone modifiers
  # (1F3FB-1F3FF), BOM (FEFF)
  if (( code == 0 ||
        (code >= 0x0300 && code <= 0x036F) ||
        (code >= 0x0483 && code <= 0x0489) ||
        (code >= 0x0591 && code <= 0x05BD) ||
        (code >= 0x0610 && code <= 0x061A) ||
        (code >= 0x064B && code <= 0x065F) ||
        (code >= 0x200B && code <= 0x200F) ||
        (code >= 0xFE00 && code <= 0xFE0F) ||
        (code >= 0xFE20 && code <= 0xFE2F) ||
        code == 0xFEFF ||
        (code >= 0x1F3FB && code <= 0x1F3FF) )); then
    REPLY=0
  # wide (2 columns): Hangul, CJK ideographs/kana/compat, fullwidth forms, emoji
  elif (( (code >= 0x1100 && code <= 0x115F) ||
          code == 0x2329 || code == 0x232A ||
          code == 0x231A || code == 0x231B ||
          (code >= 0x23E9 && code <= 0x23EC) || code == 0x23F0 || code == 0x23F3 ||
          (code >= 0x25FD && code <= 0x25FE) ||
          (code >= 0x2614 && code <= 0x2615) ||
          (code >= 0x2648 && code <= 0x2653) ||
          code == 0x267F || code == 0x2693 || code == 0x26A1 ||
          (code >= 0x26AA && code <= 0x26AB) ||
          (code >= 0x26BD && code <= 0x26BE) ||
          (code >= 0x26C4 && code <= 0x26C5) ||
          code == 0x26CE || code == 0x26D4 || code == 0x26EA ||
          (code >= 0x26F2 && code <= 0x26F3) || code == 0x26F5 || code == 0x26FA || code == 0x26FD ||
          code == 0x2705 || (code >= 0x270A && code <= 0x270B) || code == 0x2728 ||
          code == 0x274C || code == 0x274E ||
          (code >= 0x2753 && code <= 0x2755) || code == 0x2757 ||
          (code >= 0x2795 && code <= 0x2797) || code == 0x27B0 || code == 0x27BF ||
          (code >= 0x2B1B && code <= 0x2B1C) || code == 0x2B50 || code == 0x2B55 ||
          (code >= 0x2E80 && code <= 0x303E) ||
          (code >= 0x3041 && code <= 0x33FF) ||
          (code >= 0x3400 && code <= 0x4DBF) ||
          (code >= 0x4E00 && code <= 0x9FFF) ||
          (code >= 0xA000 && code <= 0xA4CF) ||
          (code >= 0xAC00 && code <= 0xD7A3) ||
          (code >= 0xF900 && code <= 0xFAFF) ||
          (code >= 0xFE10 && code <= 0xFE19) ||
          (code >= 0xFE30 && code <= 0xFE6F) ||
          (code >= 0xFF00 && code <= 0xFF60) ||
          (code >= 0xFFE0 && code <= 0xFFE6) ||
          (code >= 0x1F300 && code <= 0x1FAFF) ||
          (code >= 0x20000 && code <= 0x3FFFD) )); then
    REPLY=2
  else
    REPLY=1
  fi
}

# Space-pad/right-align $2 to a display width of $1 columns, measuring by
# terminal columns (not code points) so CJK and emoji don't break the table.
# Truncates with "..." when too wide.
# @params
# $1: The alignment width
# $2: The string to align
# @stdout
# aligned string
align::right() {
  local -i width=$1 # Mandatory column width
  # Force byte-wise string ops so we can decode UTF-8 ourselves; this is
  # locale-independent (bash's `printf "'c"` does not portably yield a code
  # point for multibyte chars, but does yield the byte value here).
  local LC_ALL=C
  local -- str=$2 # Mandatory input string
  local -i n=${#str} i=0 j clen val cp prev=0
  local -a parts=() pw=()  # per-character byte sequence and its column width
  local -i total=0
  while (( i < n )); do
    printf -v val "%d" "'${str:i:1}"; (( val < 0 )) && (( val += 256 ))
    if   (( val < 0x80 )); then cp=$val;            clen=1
    elif (( val < 0xC0 )); then cp=$val;            clen=1  # stray continuation byte
    elif (( val < 0xE0 )); then cp=$((val & 0x1F)); clen=2
    elif (( val < 0xF0 )); then cp=$((val & 0x0F)); clen=3
    else                        cp=$((val & 0x07)); clen=4
    fi
    (( i + clen > n )) && clen=$(( n - i ))  # guard against truncated input
    for (( j=1; j < clen; j++ )); do
      printf -v val "%d" "'${str:i+j:1}"; (( val < 0 )) && (( val += 256 ))
      cp=$(( (cp << 6) | (val & 0x3F) ))
    done
    charwidth "$cp"
    # ZWJ emoji sequence (e.g. 👨‍💻): a glyph joined by U+200D renders as a
    # single cell, so the part following the joiner adds no extra columns
    (( prev == 0x200D )) && REPLY=0
    prev=$cp
    parts+=( "${str:i:clen}" )
    pw+=( "$REPLY" )
    (( total += REPLY ))
    (( i += clen ))
  done

  local -- out=""
  local -i w=0 k
  if (( total <= width )); then
    out=$str; w=$total
  else
    # truncate to leave 3 columns for the "..." marker
    for (( k=0; k < ${#parts[@]}; k++ )); do
      (( w + pw[k] > width - 3 )) && break
      out+=${parts[k]}; (( w += pw[k] ))
    done
    out+="..."; (( w += 3 ))
  fi
  printf '%*s%s' $(( width - w )) '' "$out"
}

element_in() {
  local e match="$1"
  shift
  for e; do [[ "$e" == "$match" ]] && return 0; done
  return 1
}

ip_to_num() {
  awk -F. '{printf "%.0f", ($1 * 256^3) + ($2 * 256^2) + ($3 * 256) + $4}' <<< "$1"
}

declare -A NETWORK_UUID_NAME
declare -A WGPEER_IP
declare -A WGPEER_NAME
declare -A WGPEER_NID
declare -A WGPEER_NS # redis namespace per peer: wg_peer (wireguard) or awg_peer (amneziawg)
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

        # amneziawg uses the same schema as wireguard, just under a different key (and a
        # different redis peer namespace: wg_peer vs awg_peer); pull peers from both
        jq -r '
          (.interface.wireguard.wg0  | select(.) | {ns:"wg_peer",  v:.}),
          (.interface.amneziawg.awg0 | select(.) | {ns:"awg_peer", v:.})
          | .ns as $ns | .v.meta.uuid as $uuid
          | .v.peers[]? | .publicKey, $ns, $uuid, ([.allowedIPs[] | select(endswith("/32"))][0])' /tmp/scc_config |
        while mapfile -t -n 4 ARY && ((${#ARY[@]})); do
            WGPEER_NS[${ARY[0]}]=${ARY[1]}
            WGPEER_NID[${ARY[0]}]=${ARY[2]}
            WGPEER_IP[${ARY[0]}]=${ARY[3]}
        done

        jq -r '(.interface.wireguard.wg0, .interface.amneziawg.awg0) | select(.) | .extra.peers[]? | .publicKey, .name' /tmp/scc_config |
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
    local DEFAULTFILE="$FIREWALLA_HOME/net2/config.json"
    local PLATFORMFILE="$FIREWALLA_HOME/platform/$PLATFORM/files/config.json"
    local USERFILE="$HOME/.firewalla/config/config.json"
    # config priority low -> high, mirrors net2/config.js aggregateConfig().
    # version/hashset/cloud/msp configs are cloud/redis-sourced and not available
    # offline, so they are skipped here.
    local CONFIG_FILES=("$DEFAULTFILE" "$PLATFORMFILE" "$USERFILE")
    local FILE

    # 1. base userFeatures from config files, later files override earlier ones
    # use jq where available
    if [[ "$PLATFORM" != 'red' && "$PLATFORM" != 'blue' ]]; then
      for FILE in "${CONFIG_FILES[@]}"; do
        [[ -f "$FILE" ]] || continue
        jq -r '.userFeatures // {} | to_entries[] | "\(.key) \(.value)"' "$FILE" |
          while read key value; do
            SF["$key"]="$value"
          done
      done
    else
      # lagacy python 2.7 solution
      for FILE in "${CONFIG_FILES[@]}"; do
        [[ -f "$FILE" ]] || continue
        local JSON=$(python -c "import json; obj=json.load(open('$FILE')); print('\n'.join([key + '=' + str(value) for key,value in obj.get('userFeatures',{}).items()]));")
        if [[ "$JSON" != "" ]]; then
          while IFS="=" read -r key value; do
            SF["$key"]="$value"
          done <<<"$JSON"
        fi
      done
    fi

    # 2. dynamicFeatures override (sys:features redis hash): '1' => true, anything
    #    else => false. Mirrors net2/config.js reloadFeatures().
    declare -A DF
    read_hash DF sys:features
    for key in "${!DF[@]}"; do
      if [[ "${DF[$key]}" == "1" ]]; then
        SF["$key"]=1
      else
        SF["$key"]=0
      fi
    done

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
    printf "%20s %10s %10s %s\n" "$SERVICE_NAME" "$EXPECTED_STATUS" "$RESTART_TIMES" "$ACTUAL_STATUS"
}

check_systemctl_services() {
    echo "----------------------- System Services ----------------------------"
    printf "%20s %10s %10s %s\n" "Service Name" "Expect" "Restarted" "Actual"

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

    print_config 'OS Version' "$(grep VERSION_ID /etc/os-release | cut -d= -f2 | tr -d '"')"
    print_config 'Kernel Version' "$(cut -d' ' -f3-4 /proc/version)"
    echo

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
    print_config "Monitor" "${SP[monitor]:=true}"
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
        local parent_classid=1
        echo "PID: ${RULE_ID}, traffic direction: ${TRAFFIC_DIRECTION}, rate limit: ${RATE_LIMIT}, priority: ${PRIORITY}, disabled: ${DISABLED}"
        if [[ $PLATFORM == "gold" ]]; then
          parent_classid=10
        fi
        if [[ $TRAFFIC_DIRECTION == "upload" ]]; then
          tc class show dev ifb0 classid ${parent_classid}:0x${QOS_HANDLER_ID}
        else
          tc class show dev ifb1 classid ${parent_classid}:0x${QOS_HANDLER_ID}
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
    printf "%7s %52s %11s %25s %10s %25s %5s %9s %5s %9s %9s %3s %8s %15s %20s %20s\n" \
      "No." "Target" "Type" "Scope" "Expire" "Scheduler" "Dir" "Action" "Proto" "LPort" "RPort" "Dis" "Hit" "LastHitTS" "Purpose" "Name"
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
            if [[ "$GUID" == "wg_peer:"* || "$GUID" == "awg_peer:"* ]]; then
                SCOPE="${GUID%%_peer:*}:${WGPEER_NAME[${GUID#*_peer:}]}"
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
          local TS_STR=""
          if [[ -n "${p[lastHitTs]}" ]]; then
            TS_STR="$(date -d "@${p[lastHitTs]}" '+%y-%m-%d %H:%M' 2>/dev/null)"
          fi
          printf "$COLOR%7s %52s %11s %25s %10s %25s %5s %9s %5s %9s %9s %3s %8s %15s %20s %20s$UNCOLOR\n" \
            "$RULE_ID" "$(align::right 52 "$TARGET")" "$TYPE" "$(align::right 25 "$SCOPE")" "$EXPIRE" "$CRONTIME" \
            "$DIRECTION" "$ACTION" "${p[protocol]}" "${p[localPort]}" "${p[remotePort]}" "$DISABLED" "${p[hitCount]}" "$TS_STR" "${p[purpose]:-${p[app_name]}}" "${p[_name]}"
        fi;

        unset p
    done

    D="\e[2m"
    U="\e[0m"
    echo ""
    echo    "    *: created from alarm"
    echo    "   **: created from network flow"
    echo -e "Abbr.: Dir${D}ection$U Proto${D}col$U L${D}ocal${U}Port R${D}emote${U}Port Dis${D}abled$U"

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
    else
      NEW_DEVICE_TAGS=( )
    fi
    while read -r POLICY_KEY; do
      if [ -n "$POLICY_KEY" ]; then
        local nid=${POLICY_KEY/policy:network:/""}
        get_network_policy "$nid"
        if [[ "${SF[new_device_tag]}" == "1" ]]; then
          NEW_DEVICE_TAGS+=( $(jq "select(.state == true) | .tag" <<< ${NP[$nid,newDeviceTag]}) );
        fi
      fi
    done < <(redis-cli keys 'policy:network:*')

    local B7_Placeholder=
    if [[ $SIMPLE_MODE == "T" ]]; then
      B7_Placeholder=' %2s'
    else
      B7_Placeholder='%.s'
    fi
    printf "%35s %15s %16s %18s %3s$B7_Placeholder %2s %11s %7s %6s %3s %3s %3s %3s %3s %3s %3s %3s %3s %3s %3s %3s %3s\n" \
      "Host" "Network" "IP" "MAC" "Mon" "B7" "Ol" "VPNClient" "FlowOut" "FlowIn" "Grp" "Usr" "DvT" "VqL" "Iso" "EA" "DNS" "AdB" "Fam" "SS" "DoH" "Ubd" "NTP"
    NOW=$(date +%s)
    frcc


    local FIREWALLA_MAC="$(ip link list | awk '/ether/ {print $2}' | sort | uniq)"

    local hierarchicalPolicies=('isolation')
    local policyNames=("adblock" "safeSearch" "doh" "unbound" "ntp_redirect")
    local featureNames=("adblock" "safe_search" "doh" "unbound" "ntp_redirect")

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

    local MACs
    mapfile -t MACs < <(redis-cli zrevrangebyscore host:active:mac +inf "$(date -d '30 days ago' +%s)");
    if [[ -z ${MACs[*]} ]]; then
        mapfile -t MACs < <(redis-cli keys 'host:mac:*' | cut -d: -f3-)
    fi

    MACs=( "${MACs[@]}" "${!WGPEER_IP[@]}" )

    for MAC in "${MACs[@]}"; do
        local IS_FIREWALLA
        if echo "$FIREWALLA_MAC" | grep -wiq "$MAC"; then
          IS_FIREWALLA=1 # true
          continue
        else
          IS_FIREWALLA=0 # false
        fi

        if [[ -n ${WGPEER_NAME[$MAC]+x} ]]; then
          local NAME="${WGPEER_NAME[$MAC]}"
          local nid=${WGPEER_NID[$MAC]}
          local POLICY_MAC="policy:${WGPEER_NS[$MAC]}:${MAC}"
          local IP=${WGPEER_IP[$MAC]/\/32/""}
          local taggedMac="${WGPEER_NS[$MAC]}:$MAC"
          local ONLINE=" "
        else
          declare -A h
          read_hash h "host:mac:$MAC"

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

          local nid="${h[intf]}"

          local POLICY_MAC="policy:mac:${MAC}"

          local IP=${h[ipv4Addr]}

          local taggedMac="$MAC"
        fi
        # echo "$NAME $IP $POLICY_MAC $nid"

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

        local NETWORK_NAME=
        if [[ -n $nid ]]; then
          NETWORK_NAME=${NETWORK_UUID_NAME[$nid]}
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

        declare -A p
        read_hash p "$POLICY_MAC"

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
        if ((IS_FIREWALLA)) || is_router "$IP"; then
            MONITORING="NA"
        elif [ -z ${p[monitor]+x} ] || [[ ${p[monitor]} == "true" ]]; then
            MONITORING=""
        else
            MONITORING="F"
        fi
        if [[ $SIMPLE_MODE == "T" ]]; then
          local B7_MONITORING_FLAG=$(redis-cli sismember monitored_hosts "$IP")
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

        local FLOWINCOUNT=$(redis-cli zcard flow:conn:in:$taggedMac)
        # if [[ $FLOWINCOUNT == "0" ]]; then FLOWINCOUNT=""; fi
        local FLOWOUTCOUNT=$(redis-cli zcard flow:conn:out:$taggedMAC)
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
          ((! IS_FIREWALLA)) && ! is_router $IP; then
            FC="\e[91m"
        elif [ $FLOWINCOUNT -gt 5000 ] || [ $FLOWOUTCOUNT -gt 100 ]; then
            FC="\e[33m" #yellow
        fi
        if [[ ${NAME,,} == "circle"* || ${MAC_VENDOR,,} == "circle"* ]]; then
            BGC="\e[41m"
        fi

        local MAC_COLOR="$FC"
        if [[ $MAC =~ ^.[26AEae].*$ ]] && ((! IS_FIREWALLA)) && [[ -z ${WGPEER_NAME[$MAC]+x} ]]; then
          MAC_COLOR="\e[35m"
        fi

        TAG_COLOR="$FC"
        if [[ " ${NEW_DEVICE_TAGS[*]} " =~ " ${TAGS} " ]]; then
          TAG_COLOR="\e[31m"
        fi

        if [ -z "$ONLINE" ] || [ "$ONLINE" == "NA" ]; then
            FC=$FC"\e[2m" #dim
        fi

        printf "$BGC$FC%35s %15s %16s $MAC_COLOR%18s$FC %3s$B7_Placeholder %2s %11s %7s %6s $TAG_COLOR%3s$FC %3s %3s ${fcv[vql,c]}%3s$UC ${fcv[iso,c]}%3s$UC ${fcv[acl,c]}%3s$UC %3s ${fcv[adblock,c]}%3s$UC ${fcv[family,c]}%3s$UC ${fcv[safeSearch,c]}%3s$UC ${fcv[doh,c]}%3s$UC ${fcv[unbound,c]}%3s$UC ${fcv[ntp_redirect,c]}%3s$UC$BGUC\n" \
          "$(align::right 35 "$NAME")" "$(align::right 15 "$NETWORK_NAME")" "$IP" "$(align::right 17 "$MAC")" "$MONITORING" "$B7_MONITORING" "$ONLINE" "$(align::right 11 $VPN)" "$FLOWINCOUNT" \
          "$FLOWOUTCOUNT" "$TAGS" "$USER_TAGS" "$DEVICE_TAGS" "${fcv[vql,v]}" "${fcv[iso,v]}" "${fcv[acl,v]}" "$DNS_BOOST" "${fcv[adblock,v]}" "${fcv[family,v]}" "${fcv[safeSearch,v]}" "${fcv[doh,v]}" "${fcv[unbound,v]}" "${fcv[ntp_redirect,v]}"

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
    echo -e "Abbr.: Mon${D}itoring$U B7${D}(Spoofing Flag)$U Ol${D}(Online)$U DvT${D}(Device Type)$U VqL${D}an$U Iso${D}lation$U EA${D}(Emergency Access)$U SS${D}(Safe Search)$U DoH${D}(DNS over HTTPS)$U Ubd${D}(Unbound)$U NTP${D} Intercept$U"
    echo -e "Note : Feature flags marked in grey are inherented from upper levels, which are tag, network, or system"
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

    # ordered list of "feature_key|display name"; controls both naming and display order
    local featureList=(
        "ipv6|Simple mode IPv6 Support"
        "local_domain|Local Domain"
        "family_protect|Family Protect"
        "adblock|AD Block"
        "doh|DNS over HTTPS"
        "unbound|Unbound"
        "dns_proxy|DNS Proxy"
        "safe_search|Safe Search"
        "external_scan|External Scan"
        "device_online|Device Online Alarm"
        "device_offline|Device Offline Alarm"
        "dual_wan|Internet Connectivity Alarm Dual WAN"
        "single_wan_conn_check|Internet Connectivity Alarm Single WAN"
        "video|Auido/Video Alarm"
        "porn|Porn Alarm"
        "game|Gaming Alarm"
        "vpn|VPN Traffic Alarm"
        "cyber_security|Security Alarm"
        "cyber_security.autoBlock|Malicious Traffic Autoblock"
        "cyber_security.autoUnblock|Malicious Traffic Autoblock Validation"
        "large_upload|Abnormal Upload Alarm"
        "large_upload_2|Large Upload Alarm"
        "abnormal_bandwidth_usage|Abnormal Bandwidth Alarm"
        "vulnerability|Vulnerability Alarm"
        "new_device|New Device Alarm"
        "new_device_tag|Quarantine"
        "new_device_block|New Device Alarm Auto Block"
        "alarm_subnet|Subnet Alarm"
        "alarm_upnp|uPnP Alarm"
        "alarm_openport|Open Port Alarm"
        "acl_alarm|Customized Alarm"
        "vpn_client_connection|VPN Activity Alarm"
        "vpn_disconnect|VPN Connectivity Disconnection Alarm"
        "vpn_restore|VPN Connectivity Restoration Alarm"
        "spoofing_device|Spoofing Device Alarm"
        "sys_patch|System Patch"
        "device_service_scan|Device Service Scan"
        "acl_audit|Blocked Flows"
        "dnsmasq_log_allow|Nonblock DNS Flows"
        "data_plan|Data Plan"
        "data_plan_alarm|Data Plan Alarm"
        "country|Country Data Update"
        "category_filter|Category Bloomfilter"
        "fast_intel|Intel Bloomfilter"
        "network_monitor|Internet Quality Test"
        "network_monitor_alarm|Internet Quality Alarm"
        "network_stats|Network Ping Test"
        "network_status|DNS Server Ping Test"
        "network_speed_test|Auto Speed Test"
        "network_metrics|Network Traffic Metrics"
        "link_stats|dmesg LinkDown Check"
        "rekey|Renew Group Key"
        "rule_stats|Rule Stats"
        "internal_scan|Internal Scan"
        "accounting|Screen Time"
        "wireguard|WireGuard"
        "pcap_zeek|Zeek"
        "pcap_suricata|Suricate"
        "compress_flows|Compress Flow"
        "event_collect|Events"
        "mesh_vpn|Mesh VPN"
        "redirect_httpd|Legacy block service"
        "upstream_dns|Legacy DNS -should be off-"
        "device_detect|Device Identification"
        "local_flow|Local Flow Capture"
        "dns_flow|DNS Flow Capture"
        "dns_flow_record|DNS Flow Record"
        "quic_log_reader|QUIC Log Reader"
        "record_activity_flow|Record Activity Flow"
        "app_time_usage|App Time Usage"
        "local_audit|Local Block Flow"
        "dnsmasq_log_allow_redis|Nonblock DNS Flows Record"
        "fast_speedtest|Capture Speed Test Traffic with conntrack"
        "ntp_redirect|NTP Intercept"
        "weak_password_scan|Weak Password Scan"
        "digitalfence|Digital Fence -WiFi/BT detection-"
        "policy_disturb|Disturb Rules"
        "dap|Device Auto Protect"
        "dap_bg_task|DAP Background Task"
        "clash|Clash Proxy"
        "clashdns|Clash DNS"
        "vpn_relay|VPN Relay"
        "api_relay|API Relay"
        "alarm_vpnclient_internet_pause|VPN Client Alarm Transition Switch"
        "alarm_skip_device_info_enrich|Skip Alarm Device Info Enrich"
        "insane_mode|Insane Mode -lower alarm thresholds-"
        "naughty_monkey|Naughty Monkey"
    )

    declare -A nameMap
    for entry in "${featureList[@]}"; do
        nameMap["${entry%%|*}"]="${entry#*|}"
    done

    # print known features in the order above
    for entry in "${featureList[@]}"; do
        local key="${entry%%|*}"
        [[ -n "${SF[$key]+x}" ]] && print_config "${nameMap[$key]}" "${SF[$key]}" "$key"
    done

    # print any remaining features not listed above (e.g. dynamic features)
    for key in $(printf '%s\n' "${!SF[@]}" | sort); do
        [[ -z "${nameMap[$key]+x}" ]] && print_config "" "${SF[$key]}" "$key"
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

    declare -A DHCP
    declare -a DHCP_INTF
    jq -r '.dhcp // {} | to_entries[] | .key,.value.range.from,.value.range.to' /tmp/scc_config |
      # mapfile -t -n 3 ARY reads 3 lines at a time into array ARY
      # ((${#ARY[@]})) checks if array ARY has any elements (length > 0)
      # Together they read 3 lines at a time until no more lines are left
      while mapfile -t -n 3 ARY && ((${#ARY[@]})); do
        # echo "${ARY[0]},$(ip_to_num "${ARY[1]}"),$(ip_to_num "${ARY[2]}")";
        DHCP_INTF+=("${ARY[0]}")
        DHCP[${ARY[0]},from]=$(ip_to_num "${ARY[1]}")
        DHCP[${ARY[0]},to]=$(ip_to_num "${ARY[2]}")
        DHCP[${ARY[0]},used]=0
        DHCP[${ARY[0]},pool]=$((${DHCP[${ARY[0]},to]} - ${DHCP[${ARY[0]},from]} + 1))
      done

    # Read DHCP leases and convert IP addresses to numbers
    while read -r _ _ ip; do
      if [[ -n "$ip" ]]; then
        ip_num=$(ip_to_num "$ip")
        for intf in "${DHCP_INTF[@]}"; do
          if [[ "$ip_num" -ge "${DHCP[$intf,from]}" && "$ip_num" -le "${DHCP[$intf,to]}" ]]; then
            ((DHCP[$intf,used]++))
          fi
        done
      fi
    done < /home/pi/.router/run/dhcp/dnsmasq.leases

    :>/tmp/scc_csv # clear file
    for INTF in $INTFS; do
      jq -rj ".[\"$INTF\"] | if (.state.ip6 | length) == 0 then .state.ip6 |= [] else . end | [\"$INTF\", .config.meta.name, .config.meta.uuid, .state.ip4, .state.gateway, (.state.ip6 | join(\"|\")), .state.gateway6, (.state.dns // [] | join(\";\"))] | @tsv" /tmp/scc_interfaces >>/tmp/scc_csv
      echo "" >> /tmp/scc_csv
    done

    get_system_policy

    printf "Interface\tName\tUUID\tIPv4\tGateway\tIPv6\tGateway6\tDNS\tvpnClient\tAdB\tFam\tSS\tDoH\tUbd\tNTP\tDHCP\n" >/tmp/scc_csv_multline
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
      local NTP=$(if [[ ${NP[$id,ntp_redirect]} == *"true"* ]]; then echo "T"; fi)

      local DHCP=
      if element_in "${COL[0]}" "${DHCP_INTF[@]}"; then
        DHCP="${DHCP[${COL[0]},used]}/${DHCP[${COL[0]},pool]}"
      fi

      local LINE_COUNT=$(( "${#IP6[@]}" > "${#DNS[@]}" ? "${#IP6[@]}" : "${#DNS[@]}" ));
      [[ $LINE_COUNT -eq 0 ]] && LINE_COUNT=1
      for (( IDX=0; IDX < $LINE_COUNT; IDX++ )); do
        # echo $IDX
        local IP=
        if [[ ${#IP6[@]} -gt $IDX ]]; then
          IP=${IP6[$IDX]}
        fi

        if [[ $IDX -eq 0 ]]; then
          printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
            "${COL[0]}" "${COL[1]}" "${COL[2]:0:8}" "${COL[3]}" "${COL[4]}" "$IP" "${COL[6]}" "${DNS[$IDX]}" \
            "$VPN" "$ADBLOCK" "$FAMILY_PROTECT" "$SAFE_SEARCH" "$DOH" "$UNBOUND" "$NTP" "$DHCP" >> /tmp/scc_csv_multline
        else
          printf "\t\t\t\t\t%s\t\t%s\t\t\n" "$IP" "${DNS[$IDX]}" >> /tmp/scc_csv_multline
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
    mapfile -t -O "${#TAGS[@]}" TAGS < <(redis-cli --scan --pattern 'ssidTag:uid:*' | sort --version-sort)
    get_system_policy

    printf "ID\tType\tName\taffiliated\tvpnClient\tVqL\tIso\tAdB\tFam\tSS\tDoH\tUbd\n" >/tmp/tag_csv
    for TAG in "${TAGS[@]}"; do
      declare -A t
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

    D="\e[2m"
    U="\e[0m"

    echo ""
    echo -e "Abbr.: affiliated${D}Tag$U VqL${D}an$U Iso${D}lation$U SS${D}(Safe Search)$U DoH${D}(DNS over HTTPS)$U Ubd${D}(Unbound)$U"
    echo ""
}

check_ap() {
    echo "---------------------- AP ------------------"
    frcc
    if [ "$(jq 'has("apc")' /tmp/scc_config)" == "false" ]; then
        echo "AP not configured"
        echo ""
        return
    fi

    mapfile -t tags < <(redis-cli --scan --pattern 'tag:uid:*')

    declare -A ssidVlanUserMap
    for tag in "${tags[@]}"; do
      local uid=${tag#tag:uid:}
      get_tag_policy "$uid"
      #echo "uid $uid ${TP[$uid,ssidPSK]}"
      if [[ "${#TP[$uid,ssidPSK]}" -gt 2 ]]; then
        jq -r '.defaultSSIDs[]?, (.vlan as $vlan | .psks | to_entries[] | .key + "," + ($vlan|tostring))' <<< "${TP[$uid,ssidPSK]}" |
        while read -r ssidVlan; do
          ssidVlanUserMap["$ssidVlan"]="$uid"
          #echo "ssidVlanUserMap $ssidVlan = $uid"
        done
      fi
    done
  
    # Map SSID IDs to interfaces
    declare -A ssid_intf_map
    
    # Extract all wifiNetworks data in one jq call - format: index|intf|ssidProfiles|aliasSSIDs
    # ssidProfiles format: profile1,profile2,profile3
    # aliasSSIDs format: id1,id2,id3
    jq -r '.apc.assets_template.ap_default.wifiNetworks? // [] | 
      to_entries[] | 
      [
        (.key|tostring),
        (.value.intf // ""),
        ((.value.ssidProfiles // []) | join(",")),
        ((.value.aliasSSIDs // []) | map(.id) | join(","))
      ] | join("|")' /tmp/scc_config |
    while IFS='|' read -r idx network_intf ssid_profiles_str alias_ssids_str; do
      # Only process entries that have ssidProfiles (making it a valid entry)
      if [[ -n "$ssid_profiles_str" ]]; then
        # Map SSID profiles to their interface
        IFS=',' read -ra network_ssid_profiles <<< "$ssid_profiles_str"
        for profile_id in "${network_ssid_profiles[@]}"; do
          if [[ -z "${ssid_intf_map[$profile_id]+x}" ]]; then
            ssid_intf_map["$profile_id"]="$network_intf"
          fi
        done
        
        # Process aliasSSIDs (map them to interface too)
        if [[ -n "$alias_ssids_str" ]]; then
          IFS=',' read -ra alias_ids <<< "$alias_ssids_str"
          for id in "${alias_ids[@]}"; do
            if [[ -z "${ssid_intf_map[$id]+x}" ]]; then
              ssid_intf_map["$id"]="$network_intf"
            fi
          done
        fi
      fi
    done

    printf "Profile\tSSID\tBand\tEncryption\tInterface\tPriSeg\tAddSeg\n" >/tmp/ap_csv
    jq -r '.apc.profile | to_entries[] | [.key, .value.ssid, .value.band, .value.encryption] | @tsv' /tmp/scc_config |
    while read -r LINE; do
      mapfile -td $'\t' COL < <(printf "%s" "$LINE")
      local id="${COL[0]}"
      # only print profile that has an interface mapping (from ssidProfiles or aliasSSIDs)
      if [[ -n "${ssid_intf_map[$id]+x}" ]]; then
        local priSeg=""
        local addSeg=""
        for key in "${!ssidVlanUserMap[@]}"; do
          if [[ "$key" == "$id" ]]; then
            priSeg="${ssidVlanUserMap[$key]}"
          elif [[ "$key" == "$id,"* ]]; then
            [[ -n "$addSeg" ]] && addSeg+=","
            addSeg+="${ssidVlanUserMap[$key]}"
          fi
        done
        
        # Get interface for this SSID from the wifiNetwork entry that contains it
        local ssid_intf="${ssid_intf_map[$id]:-}"
        
        printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "${COL[0]}" "${COL[1]}" "${COL[2]}" "${COL[3]}" "$ssid_intf" "$priSeg" "$addSeg" >>/tmp/ap_csv
      fi

    done

    $COLUMN_OPT -t -s$'\t' /tmp/ap_csv

    unset ssidVlanUserMap
    unset ssid_intf_map

    D="\e[2m"
    U="\e[0m"

    echo ""
    echo -e "Abbr.: PriSeg${D}(PrimaryMicrosegment)$U AddSeg${D}(AdditionalMicrosegment)$U"
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
    (
    printf "ts,server_addr,mac,host_name,requested_addr,assigned_addr,lease_time,msg_types\n"
    find /log/blog/ -mmin -120 -name "dhcp*log.gz" |
      sort | xargs zcat -f |
      jq -r '.msg_types=(.msg_types|join("|"))|[."ts", ."server_addr", ."mac", ."host_name", ."requested_addr", ."assigned_addr", ."lease_time", ."msg_types"]|@csv' |
      sed 's="==g' | grep -v "INFORM|ACK" |
      awk -F, 'BEGIN { OFS = "," } { cmd="date -d @"$1; cmd | getline d;$1=d;print;close(cmd)}'
    ) |
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

check_iptables() {
  local output
  local rc
  output=$(sudo iptables -S 2>&1)
  rc=$?
  if [[ $rc -ne 0 ]]; then
    echo -e "\e[41m>>>>>> iptables -S failed (exit $rc), blocking & routing might not working correctly <<<<<<\e[0m"
    echo "$output"
    echo ""
    echo ""
  fi
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

check_connection() {
  URLs=(
    "https://firewalla.encipher.io"
    "https://api.firewalla.com"
    "https://connect.firewalla.com"
    "https://ota.firewalla.com"
    "https://fireupgrade.s3.us-west-2.amazonaws.com"
    "https://firewalla-ap-update-xyz.s3.us-west-2.amazonaws.com"
    "https://github.com"
    "http://firewalla.com"
  )

  for url in "${URLs[@]}"; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "$url")
    if [[ $code -eq 000 ]]; then
      echo -e "\e[41m>>> $url is NOT reachable <<<\e[0m"
    else
      echo -e "$url is reachable ($code)\e[0m"
    fi
  done
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
    echo "  --ap"
    echo "  -p  | --port"
    echo "  -t  | --tag"
    echo "  -f  | --fast | --host"
    echo "  -e  | --events"
    echo "  -c  | --connection"
    echo "        --iptables"
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
    --ap)
        shift
        FAST=true
        check_ap
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
    -c | --connection)
        shift
        FAST=true
        check_connection
        ;;
    --iptables)
        shift
        FAST=true
        check_iptables
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
    check_ap
    check_tag
    check_hosts
    check_docker
    run_lsusb
    check_eth_count
    check_iptables
    check_connection
    test -z $SPEED || check_speed
fi
