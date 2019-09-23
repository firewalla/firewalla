#!/bin/bash

shopt -s lastpipe

usage() {
    echo "Usage: conn_check [-h] [-f \"files\"]"
    echo "   -f: wildcard accepted, defaut to /blog/current/conn.log"
    echo ""
    echo "State  | Meaning"
    echo "---------------------------------------------"
    echo "S0     | Connection attempt seen, no reply."
    echo "S1     | Connection established, not terminated."
    echo "SF     | Normal establishment and termination. Note that this is the same symbol as for state S1. You can tell"
    echo "       | the two apart because for S1 there will not be any byte counts in the summary, while for SF there will be."
    echo "REJ    | Connection attempt rejected."
    echo "S2     | Connection established and close attempt by originator seen (but no reply from responder)."
    echo "S3     | Connection established and close attempt by responder seen (but no reply from originator)."
    echo "RSTO   | Connection established, originator aborted (sent a RST)."
    echo "RSTR   | Responder sent a RST."
    echo "RSTOS0 | Originator sent a SYN followed by a RST, we never saw a SYN-ACK from the responder."
    echo "RSTRH  | Responder sent a SYN ACK followed by a RST, we never saw a SYN from the (purported) originator."
    echo "SH     | Originator sent a SYN followed by a FIN, we never saw a SYN ACK from the responder"
    echo "       | (hence the connection was “half” open)."
    echo "SHR    | Responder sent a SYN ACK followed by a FIN, we never saw a SYN from the originator."
    echo "OTH    | No SYN seen, just midstream traffic (a “partial connection” that was not later closed)."
    return
}

PARAMS=""
SKIP_INSTALL=false
FILES="/blog/current/conn.log"

while [[ "$1" != "" ]]; do
    case $1 in
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

dpkg -s jq &> /dev/null

if [ $? -ne 0 ]; then
  echo "jq not found, installing... "
  sudo apt-get update
  sudo apt-get install -y jq
fi

GATEWAY="$(redis-cli hget sys:network:info eth0 | jq -r .gateway_ip)"
FIREWALLA="$(redis-cli hget sys:network:info eth0 | jq -r .ip_address)"
SUBNET=${FIREWALLA%.*}
FIREWALLA2="$(redis-cli hget sys:network:info eth0:0 | jq -r .ip_address)"
SUBNET2=${FIREWALLA2%.*}

EXCLUDE=($GATEWAY $FIREWALLA $FIREWALLA2)

declare -A HOST
declare -A CONN

cat $FILES |
( [[ $FILES == *"/current/"* ]] && cat || gunzip ) |
jq -r "select(.proto == \"tcp\") | \"\(.[\"id.orig_h\"]) \(.[\"id.resp_h\"]) \(.conn_state) \(.local_orig) \(.local_resp)\"" |
while read orig resp state local_orig local_resp; do
    #host=""
    if [[ "$orig" == "$GATEWAY" || "$orig" == "$FIREWALLA" || "$orig" == "$FIREWALLA2" ||
          "$resp" == "$GATEWAY" || "$resp" == "$FIREWALLA" || "$resp" == "$FIREWALLA2" ]]; then continue; fi
    # if [[ "${orig%.*}" == "$SUBNET" || "${orig%.*}" == "$SUBNET2" ]]; then host=$orig; fi
    # if [[ "${resp%.*}" == "$SUBNET" || "${resp%.*}" == "$SUBNET2" ]]; then host=$resp; fi
    # if [[ "$host" == "" ]]; then continue; fi
    if [[ "$local_orig" == "true" ]]
    then
        if [[ "$local_resp" == "true" ]]; then continue; else host=$orig; fi
    else
        host=$resp;
    fi
    ((HOST["$host"]=1));
    ((CONN["${host}all"]++));
    ((CONN["$host$state"]++));
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
sort -rn -k2
