#!/bin/bash

CMD=${0##*/}
DATE_FORMAT='[%Y-%m-%d %H:%M:%S]'
LOG_QUIET=0
LOG_ERROR=1
LOG_WARN=2
LOG_INFO=3
LOG_DEBUG=4

: ${LOGLEVEL:=$LOG_INFO}
test -t 1 || NO_VALUE=_
: ${NO_VALUE:=' '}

# ----------------------------------------------------------------------------
# Functions
# ----------------------------------------------------------------------------

mylog() {
    echo "$(date +"$DATE_FORMAT")$@"
}
mylogn() {
    echo -n "$(date +"$DATE_FORMAT")$@"
}

logdebug() {
    test $LOGLEVEL -ge $LOG_DEBUG || return 0
    if [[ $1 == '-n' ]]; then
        shift
        mylogn "[DEBUG] $@" >&2
    else
        mylog "[DEBUG] $@" >&2
    fi
}

loginfo() {
    test $LOGLEVEL -ge $LOG_INFO || return 0
    if [[ $1 == '-n' ]]; then
        shift
        mylogn "[INFO] $@"
    else
        mylog "[INFO] $@"
    fi
}

logwarn() {
    test $LOGLEVEL -ge $LOG_WARN || return 0
    if [[ $1 == '-n' ]]; then
        shift
        mylogn "[WARN] $@" >&2
    else
        mylog "[WARN] $@" >&2
    fi
}

logerror() {
    test $LOGLEVEL -ge $LOG_ERROR || return 0
    if [[ $1 == '-n' ]]; then
        shift
        mylogn "[ERROR] $@" >&2
    else
        mylog "[ERROR] $@" >&2
    fi
}

usage() {
  cat <<EOU
usage: $CMD

env:

  LOGLEVEL: $LOGLEVEL

examples:

  # List AP station status
  $0

  # List a specific station status
  $0 <station_mac>

EOU
}

print_header() {
    HDR_LENGTH=0
    for connct in $CONN_COLS
    do
        IFS=: read connc conncl conncu <<<$(echo $connct)
        test -n "$conncl" || conncl=-20
        printf "%${conncl}s " ${connc^^}
        let HDR_LENGTH+=${conncl#-}+1
    done
    echo
}

local_api() {
    curl -s "http://localhost:8841/v1/$1"
}

local_simple_post_api() {
    curl -XPOST -s "http://localhost:8841/v1/$1"
}

frcc() {
    local_api config/active
}

hl() {
    ${HEADER:-true} || return 0
    for ((i=0;i<HDR_LENGTH;i++)); do
        echo -n '-'
    done
    echo
}

timeit() {
    return 0
    tnow=$(date +%s%3N)
    echo "TIMEIT $1: $((tnow-tlast))"
    tlast=$tnow
}

displaytime() {
    ${FORMAT_TIME:-true} || {
        echo "$1"
        return 0
    }
    local T=$1
    local D=$((T/60/60/24))
    local H=$((T/60/60%24))
    local M=$((T/60%60))
    local S=$((T%60))
    (( D > 0 )) && printf '%02dd' $D
    (( H > 0 )) && printf '%02dh' $H
    (( M > 0 )) && printf '%02dm' $M
    printf '%02ds\n' $S
}

get_name() {
  m=$1
  result=$(redis-cli --raw hget host:mac:$m name)
  test -n "$result" && {
    echo "$result"
    return 0
  }

  result=$(redis-cli --raw hget host:mac:$m detect|jq -r .name)
  test "$result" == null || {
    echo "$result"
    return 0
  }

  redis-cli --raw hget host:mac:$m bname
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

CONN_COLS='src_name:-30:u src_mac src_ip:-17 dst_name:-30:u dst_mac dst_ip:-17 scan_count:10'
(print_header; hl) >&2
lines=0
timeit begin

conns_data=$(local_api status/conntrack?format=json |\
    jq -r '.sources//empty|to_entries[]| .key as $sip | .value.destinations|to_entries[]|.key as $dip | [ $sip, $dip, .value.scanCount//-1]| @tsv')

if true; then
    test -n "$conns_data" && echo "$conns_data" | while IFS=$'\t' read src_ip dst_ip scan_count
    do
        src_mac=$(redis-cli --raw hget host:ip4:$src_ip mac)
        timeit src_mac
        src_name=$(get_name $src_mac)
        timeit src_name
        dst_mac=$(redis-cli --raw hget host:ip4:$dst_ip mac)
        timeit dst_mac
        dst_name=$(get_name $dst_mac)
        timeit dst_name
        time_now=$(date +%s)
        timeit timestamp

        for connct in $CONN_COLS
        do
                        IFS=: read connc conncl conncu <<<$(echo $connct)
                        timeit $connc
                        test -n "$conncl" || conncl=-20
            case $connc in
                conn_mac) connd=$conn_mac ;;
                src_name) connd=$src_name ;;
                src_mac) connd=$src_mac ;;
                src_ip) connd=$src_ip ;;
                dst_name) connd=$dst_name ;;
                dst_mac) connd=$dst_mac ;;
                dst_ip) connd=$dst_ip ;;
                scan_count) connd=$scan_count ;;
                *) connd=$NO_VALUE ;;
            esac
            test -t 1 || connd=$(echo "$connd" | sed -e "s/ /_/g")
            connd=$(echo "$connd" | sed -e "s/[‘’]/'/g")
            connd=$(echo "$connd" | sed -e "s/'''/'/g")
            conndl=${#connd}
            test "$conncu" == 'u' && {
                conndlu=$(perl -CSAD -E 'say length($ARGV[0])' -- "$connd")
                conndlL=$(echo "$connd" | wc -L)
                let conncld=conndl-conndlu*2+conndlL
                test $conndl -eq $conndlu || {
                if [[ ${conncl:0:1} == '-' ]]; then
                    let conncl=conncl-conncld
                else
                    let conncl=conncl+conncld
                fi
                }
            }
            conncla=${conncl#-}
            if [[ $conndl -gt $conncla ]]
            then
                connd="${connd:0:$(((conncla-2)/2))}..${connd:$((conndl-(conncla-2)/2))}"
            fi
            timeit 'case'
            printf "%${conncl}s " "${connd:-$NO_VALUE}"
            timeit 'printf'
        done
        let lines++
        echo
    done
    sleep 2
fi
timeit 'done'
tty_rows=$(stty size | awk '{print $1}')
(( lines > tty_rows-2 )) && {
    ( hl; print_header ) >&2
}
