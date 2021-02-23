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
    echo ""
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

# TODO: multi-interface
GATEWAY="$(redis-cli hget sys:network:info eth0 | jq -r .gateway_ip)"
FIREWALLA="$(redis-cli hget sys:network:info eth0 | jq -r .ip_address)"
SUBNET=${FIREWALLA%.*}
FIREWALLA2="$(redis-cli hget sys:network:info eth0:0 | jq -r .ip_address |grep . || echo 255.255.255.255)"
SUBNET2=${FIREWALLA2%.*}

EXCLUDE=($GATEWAY $FIREWALLA $FIREWALLA2)

declare -A HOST
declare -A TCP
declare -A UDP
declare -A SRCPORT
declare -A DESTPORT
declare -A DEST
declare -A CONN

zcat -f $FILES |
grep -v "$GATEWAY\"\|$FIREWALLA\"\|$FIREWALLA2\"\|198.51.100.99\|0.0.0.0\|f\(f0\|e[89abcde]\).:.*\"" |
jq -r '. | "\(.proto) \(."id.orig_h") \(."id.orig_p") \(."id.resp_h") \(."id.resp_p") \(.conn_state) \(.local_orig) \(.local_resp)"' |
while read proto orig oport resp rport state local_orig local_resp; do
    #host=""
    # if [[ "$orig" == "$GATEWAY" || "$orig" == "$FIREWALLA" || "$orig" == "$FIREWALLA2" ||
    #       "$resp" == "$GATEWAY" || "$resp" == "$FIREWALLA" || "$resp" == "$FIREWALLA2" ||
    #       # ff0 broadcast, fe[89abcde] link local & site local
    #       "$orig" =~ f(f0|e[89abcde]).:.* ||
    #       "$resp" =~ f(f0|e[89abcde]).:.* ||
    #       # Firewalla dns block
    #       "$orig" == "198.51.100.99" || "$orig" == "0.0.0.0" ||
    #       "$resp" == "198.51.100.99" || "$resp" == "0.0.0.0"
    # ]]; then continue; fi
    if [[ "$local_orig" == "true" ]]; then
        if [[ "$local_resp" == "true" ]]; then
            continue;
        else
            host=$orig;
            dest=$resp;
            srcPort=$oport;
            destPort=$rport;
        fi
    else
        if [[ "$local_resp" == "true" ]]; then
            host=$resp;
            dest=$oirg
            srcPort=$rport;
            destPort=$oport;
        else
            # TODO: ipv6 check
            if [[ "${orig%.*}" == "$SUBNET" || "${orig%.*}" == "$SUBNET2" ]]; then
                host=$orig;
                dest=$resp;
                srcPort=$oport;
                destPort=$rport;
            elif [[ "${resp%.*}" == "$SUBNET" || "${resp%.*}" == "$SUBNET2" ]]; then
                host=$resp;
                dest=$oirg
                srcPort=$rport;
                destPort=$oport;
            else
                continue;
            fi
        fi
    fi

    ((HOST[$host]=1));
    ((SRCPORT[$host, $srcPort]=1));
    ((DESTPORT[$host, $destPort]=1));
    ((DEST[$host, $dest]=1));
    ((SRCPORT["total", $srcPort]=1));
    ((DESTPORT["total", $destPort]=1));
    ((DEST["total", $dest]=1));

    # only check conn_state for TCP connections
    if [[ "$proto" == "tcp" ]]; then
        ((CONN[$host, "tcp"]++));
        ((CONN[$host, $state]++));
        ((CONN["total", "tcp"]++));
        ((CONN["total", $state]++));
    else
        ((CONN[$host, "udp"]++));
        ((CONN["total", "udp"]++));
    fi

done

((HOST["total"]=1));


STATES=("SF" "S0" "S1" "REJ" "S2" "S3" "RSTO" "RSTR" "RSTOS0" "RSTRH" "SH" "SHR" "OTH")

printf '%-30s' "HOST"
printf '%-10s' "SrcPort"
printf '%-10s' "DestPort"
printf '%-10s' "DestHost"
printf '%-10s' "UDP"
printf '%-10s' "TCP"
for state in ${STATES[@]}; do
    printf '%-10s' $state
done
echo ""

# count unique source port, dest port, dest host
declare -A SRCPORT_COUNT
declare -A DESTPORT_COUNT
declare -A DESTHOST_COUNT

for key in "${!SRCPORT[@]}"; do
  ((SRCPORT_COUNT["${key%%,*}"]++))
done
for key in "${!DESTPORT[@]}"; do
  ((DESTPORT_COUNT["${key%%,*}"]++))
done
for key in "${!DEST[@]}"; do
  ((DESTHOST_COUNT["${key%%,*}"]++))
done

for host in "${!HOST[@]}"; do
    printf '%-30s' "$host"
    printf '%-10s' ${SRCPORT_COUNT[$host]}
    printf '%-10s' ${DESTPORT_COUNT[$host]}
    printf '%-10s' ${DESTHOST_COUNT[$host]}
    printf '%-10s' ${CONN[$host, "udp"]}
    printf '%-10s' ${CONN[$host, "tcp"]}
    for state in ${STATES[@]}; do
        printf '%-10s' ${CONN[$host, $state]}
    done
    echo ""
done |
sort -rn -k6
