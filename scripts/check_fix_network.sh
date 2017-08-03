#!/bin/bash

LOGGER=/usr/bin/logger
IFCONFIG=/sbin/ifconfig
NSLOOKUP=/usr/bin/nslookup
IPCMD=/sbin/ip

timeout() {
    kind=$1
    case $kind in
        eth) echo 500 ;;
        *) echo 10 ;;
    esac
}

check() {
    kind=$1
    rc=1
    case $kind in
        eth)
            eth_carrier=$(cat /sys/class/net/eth0/carrier)
            [[ "$eth_carrier" -eq 1 ]] && rc=0
            ;;
        ip)
            ip_addr=$($IFCONFIG eth0 |grep 'inet addr'|awk '{print $2}' | awk -F: '{print $2}')
            [[ -n "$ip_addr" ]] && rc=0
            ;;
        gw)
            default_gw=$($IPCMD route | grep default | awk '{print $3}')
            if [[ -n "$default_gw" ]]
            then
                ping -c1 -w3 $default_gw &>/dev/null && rc=0
            fi
            ;;
        dns)
            $NSLOOKUP -timeout=1 github.com &>/dev/null && rc=0
            ;;
        github)
            GITHUB_STATUS_API=https://status.github.com/api.json
            sc=`curl -s -o /dev/null -w "%{http_code}" $GITHUB_STATUS_API`
            [[ "$sc" == "200" ]] && rc=0
            ;;
    esac
    return $rc
}

save() {
    kind=$1
    rc=1
    case $kind in
        eth) # nothing to save
            ;;
        ip)
            $IFCONFIG eth0 |grep 'inet addr'|awk '{print $2}' | awk -F: '{print $2}' > /var/run/saved_ip
            ;;
        gw)
            $IPCMD route | grep default | awk '{print $3}' > /var/run/saved_gw
            ;;
        dns)
            cp -f /etc/resolv.conf{,.bak}
            ;;
        github) # nothing to save
            ;;
    esac
    return $rc
}

try_saved() {
    kind=$1
    rc=1
    case $kind in
        eth)
            /sbin/ifdown eth0
            sleep 2
            /sbin/ifup eth0
            ;;
        ip)
            $IFCONFIG eth0 $(cat /var/run/saved_ip)
            ;;
        gw)
            $IPCMD route add default via $(cat /var/run/saved_gw) dev eth0
            ;;
        dns)
            cp -f /etc/resolv.conf{.bak,}
            ;;
        github) # nothing to try
            ;;
    esac
    return $rc
}

# ------
# MAIN
# ------

for k in eth ip gw dns github
do
    # check timeout
    t=$(timeout $x)
    ok=1
    echo -n "- checking $k ... "
    while [[ $t -gt 0 ]]
    do
        check $k && { ok=0; break; }
        (( t=t-1 ))
        sleep 1
    done

    if [[ $ok -eq 0 ]]
    then
        $LOGGER "$k OK, save it"
        echo OK
        save $k
    else
        $LOGGER "$k fail, try last saved config"
        echo FAIL
        try_saved $k
    fi
done
