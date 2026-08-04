#!/bin/bash

CMD=${0##*/}

err() {
    echo "ERROR: $@" >&2
}
usage() {
    cat <<EOU
usage: $CMD {keys|last|list [<target>]|prom}
cmds:
  keys - show keys in ping results
  last - show latest ping results for all targets
  list - show all ping results for a target
  prom - show latest ping results for all targets in prometheus textfile format
EOU
}

test $# -gt 0 || { usage; exit 0; }

keys=$(redis-cli keys perf:ping:*)
case $1 in
    last)
        for key in $keys
        do
            ip=${key##*:}
            ts_rtt=$(redis-cli zrange $key -1 -1)
            rtt=${ts_rtt#*,}
            ts=${ts_rtt%,*}
            printf "%s\t%16s\t%s\n" $ts $ip $rtt
        done
        ;;
    keys) echo "$keys" | sed -e 's/perf:ping://' ;;
    list)
        test -n "$2" || select key in $(echo "$keys" | sed -e 's/perf:ping://')
        do
            test -n $key && break
        done
        redis-cli zrange perf:ping:${2:-$key} 0 -1 | tr , '\t'
        ;;
    prom)
        gname=$(redis-cli get groupName)
        cat <<EOS
# HELP perf_ping PING performance to given target
# TYPE perf_ping gauge
EOS
        for key in $(redis-cli keys perf:ping:*)
        do
            ip=${key##*:}
            ts_rtt=$(redis-cli zrange $key -1 -1)
            rtt=${ts_rtt#*,}
            ts=${ts_rtt%,*}000
            cat <<EOS
perf_ping{instance="$gname",target="$ip"} $rtt
EOS
        done
        ;;
    *)
        err "unsupported command '$1'"
        exit 1
        ;;
esac
