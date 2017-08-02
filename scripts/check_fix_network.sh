#!/bin/bash


SLEEP_INTERVAL=${SLEEP_INTERVAL:-5}
LOGGER=/usr/bin/logger

get_value() {
    kind=$1
    case $kind in
        ip)
            /sbin/ifconfig eth0 |grep 'inet addr'|awk '{print $2}' | awk -F: '{print $2}'
            ;;
        gw)
            /sbin/route -n | awk '$1=="0.0.0.0" {print $2}'
            ;;
        dns)
            grep nameserver /etc/resolv.conf | awk '{print $2}'
            ;;
    esac
}

save_values() {
    r=0
    for kind in ip gw dns
    do
        value=$(get_value $kind)
        [[ -n "$value" ]] || continue
        file=/var/run/saved_${kind}
        $LOGGER "Save $kind value $value in $file"
        rm -f $file
        echo "$value" > $file || r=1
    done
    return $r
}

set_value() {
    kind=$1
    saved_value=$2
    case ${kind} in
        ip)
            /sbin/ifconfig eth0 ${saved_value}
            ;;
        gw)
            /sbin/route add default gw ${saved_value} eth0
            ;;
        dns)
            echo "nameserver ${saved_value}" >> /etc/resolv.conf
            ;;
    esac
}

restore_values() {
    r=0
    for kind in ip gw dns
    do
        file=/var/run/saved_${kind}
        [[ -e "$file" ]] || continue
        saved_value=$(cat $file)
        [[ -n "$saved_value" ]] || continue
        $LOGGER "Restore $kind saved value ${saved_value} from $file"
        set_value $kind $saved_value || r=1
    done
    return $r
}

sleep ${SLEEP_INTERVAL}
rc=0
cmd=$1
case $cmd in
    save)
        save_values
        ;;
    restore)
        restore_values
        ;;
    *)
        # check if current IP exists
        current_ip=$(get_value ip)
        if [[ -n "$current_ip" ]]
        then
            save_values
        else
            restore_values
        fi
        ;;
esac
sleep ${SLEEP_INTERVAL}

exit $rc
