#!/bin/bash
shopt -s lastpipe

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
  local -i width=${1:?} # Mandatory column width
  local -- str=${2:?} # Mandatory input string
  local -i length=$((${#str} > width ? width : ${#str}))
  local -i offset=$((${#str} - length))
  local -i pad_left=$((width - length))
  printf '%*s%s' $pad_left '' "${str:offset:length}"
}

is_firewalla() {
    local IP=$(/sbin/ip addr show dev eth0 | awk '/inet /' | awk '$NF=="eth0" {print $2}' | fgrep -v 169.254. | fgrep -v -w 0.0.0.0 | fgrep -v -w 255.255.255.255 | awk -F/ '{print $1}')
    if [[ $IP == $1 ]]; then
        return 0
    else
        return 1
    fi
}

is_router() {
    GW=$(/sbin/ip route show | awk '/default via/ {print $3}')
    if [[ $GW == $1 ]]; then
        return 0
    else
        return 1
    fi
}

is_simple_mode() {
    MODE=$(redis-cli get mode)
    if [[ $MODE == "spoof" ]]; then
        echo T
    fi

    echo F
}

# reads redis hash with key $2 into associative array $1
read_hash() {
  # make an alias of $1, https://unix.stackexchange.com/a/462089
  declare -n hash="$1"
  local arr=()
  # as hash value might contain \n, have to use a non-standard delimiter here
  # use \x03 as delimiter as redis-cli doesn't seems to operate with \x00
  local output=$(redis-cli -d $'\3' hgetall $2)
  readarray -d $'\3' -t arr < <(echo -n "$output")
  for ((i=0; i<${#arr[@]}; i++)); do
    hash["${arr[$i]}"]="${arr[$i+1]}"
    ((i++))
  done
}

declare -A NETWORK_UUID_NAME
frcc_done=0
frcc() {
    if [ "$frcc_done" -eq "0" ]; then
        curl localhost:8837/v1/config/active -s -o /tmp/scc_config

        jq -r '.interface | to_entries[].value | to_entries[].value.meta | .uuid, .name' /tmp/scc_config |
        while mapfile -t -n 2 ARY && ((${#ARY[@]})); do
            NETWORK_UUID_NAME[${ARY[0]}]=${ARY[1]}
        done

        frcc_done=1
    fi
}

test() {
  frcc
  local DEVICES=$(redis-cli keys 'host:mac:*')
  printf "%35s %15s %28s %18s %18s %5s %15s %15s %30s %10s\n" "Host" "NETWORKNAME" "NAME" "IP" "MAC" "Group" "type" "brand" "model" "os"
  local NOW=$(date +%s)
  local RCC=$(curl -s "http://localhost:8837/v1/config/active")
  local SIMPLE_MODE=$(is_simple_mode)
  for DEVICE in $DEVICES; do
    local MAC=${DEVICE/host:mac:/""}
    # hide vpn_profile:*
    if [[ ${MAC,,} == "vpn_profile:"* ]]; then
      continue
    fi

    declare -A h
    read_hash h $DEVICE

    local ONLINE
    local ONLINE_TS=${h[lastActiveTimestamp]}
    local ONLINE_TS=${ONLINE_TS%.*}
    if [[ ! -n $ONLINE_TS ]]; then
      ONLINE="N/A"
    elif (($ONLINE_TS < $NOW - 2592000)); then # 30days ago, hide entry
      unset h
      continue
    elif (($ONLINE_TS > $NOW - 1800)); then
      ONLINE="yes"
    else
      ONLINE="no"
    fi

    local NETWORK_NAME=
    if [[ -n ${h[intf]} ]]; then NETWORK_NAME=${NETWORK_UUID_NAME[${h[intf]}]}; fi
    local IP=${h[ipv4Addr]}
    local MAC_VENDOR=${h[macVendor]}

    local type="" model="" brand="" os=""
    eval "$(jq -r 'to_entries[] | select(.key == ("type", "model", "brand", "os")) | "\(.key)=\(.value)"' <<< ${h[detect]})"

    # === COLOURING ===
    local COLOR="\e[39m"
    local UNCOLOR="\e[0m"
    local BGCOLOR="\e[49m"
    local BGUNCOLOR="\e[49m"
    if [[ $SIMPLE_MODE == "T" && $ONLINE == "yes" && $MONITORING == 'true' && $B7_MONITORING == "false" ]] &&
      ! is_firewalla $IP && ! is_router $IP; then
        COLOR="\e[91m"
    fi
    if [[ ${h[bname],,} == "circle"* || ${MAC_VENDOR,,} == "circle"* ]]; then
      BGCOLOR="\e[41m"
    fi

    local MAC_COLOR="$COLOR"
    if [[ $MAC =~ ^.[26AEae].*$ ]] && ! is_firewalla $IP; then
      MAC_COLOR="\e[35m"
    fi

    if [ $ONLINE = "no" ]; then
      COLOR=$COLOR"\e[2m" #dim
    fi

    printf "$BGCOLOR$COLOR%35s%16s%29s %18s $MAC_COLOR%18s$COLOR %5s %15s %15s %30s %10s $UNCOLOR$BGUNCOLOR\n" "${h[bname]}" "$(align::right 15 " $NETWORK_NAME")" "$(align::right 28 " ${h[name]}")" "$IP" "$MAC" "$TAGS" "$type" "$brand" "$model" "$os"

    unset h
  done
}

test
