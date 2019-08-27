#!/bin/bash

set +m
shopt -s lastpipe

usage() {
    echo "Usage: conn_check [-sh] [-f files]"
    return
}

PARAMS=""
SKIP_INSTALL=false
FILES="/blog/current/conn.log"

while [[ "$1" != "" ]]; do
    case $1 in
        -s )    shift
                SKIP_INSTALL=true
                ;;
        -f )    shift
                FILES=$1
                shift
                ;;
        -h )    usage
                exit
                ;;
        * )     PARAMS="$PARAMS $1"
                shift
                ;;
    esac
done

if [[ $SKIP_INSTALL == false ]]; then
    sudo apt install -y jq
fi

GATEWAY="$(redis-cli hget sys:network:info eth0 | jq -r .gateway_ip)"
FIREWALLA="$(redis-cli hget sys:network:info eth0 | jq -r .ip_address)"
SUBNET=${FIREWALLA%.*}
FIREWALLA2="$(redis-cli hget sys:network:info eth0:0 | jq -r .ip_address)"
SUBNET2=${FIREWALLA2%.*}

declare -A HOST
declare -A CONN

cat $FILES |
( [[ $FILES == *"/current/"* ]] && cat || gunzip ) |
jq -r "[.[\"id.orig_h\"], .[\"id.resp_h\"], .conn_state] | join(\" \")" |
while read orig resp state; do
    host=""
    if [[ ${orig%.*} == $SUBNET || ${orig%.*} == $SUBNET2 ]]; then host=$orig; fi
    if [[ ${resp%.*} == $SUBNET || ${resp%.*} == $SUBNET2 ]]; then host=$resp; fi
    if [[ $host == "" || $host = $GATEWAY || $host == $FIREWALLA || $host = $FIREWALLA2 ]]; then continue; fi
    ((HOST["$host"]=1));
    ((CONN["${host}all"]++));
    ((CONN["${host}${state}"]++));
done

STATES=("SF" "S0" "S1" "REJ" "S2" "S3" "RSTO" "RSTR" "RSTOS0" "RSTRH" "SH" "SHR" "OTH")

printf '%-30s' "HOST"
printf '%-10s' "All"
for state in ${STATES[@]}; do
    printf '%-10s' $state
done
echo ""

for host in "${!HOST[@]}"; do
    printf '%-30s' "$host"
    printf '%-10s' ${CONN["${host}all"]}
    for state in ${STATES[@]}; do
        printf '%-10s' ${CONN["$host$state"]}
    done
    echo ""
done |
sort -rn -k3

