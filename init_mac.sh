#!/bin/bash

MARKER=/var/run/mac_init_done
MAC_FILE=/etc/network/if-pre-up.d/hardcode_mac
CID=$(cat /sys/block/mmcblk0/device/cid)

generate_mac() {
    echo -n $CID | md5sum | sed 's/^\(..\)\(..\)\(..\)\(..\)\(..\).*/02:\1:\2:\3:\4:\5/'
}

write_mac() {
    mac=$(generate_mac)
    cat > $MAC_FILE <<EOS
#!/bin/sh

/sbin/ifconfig eth0 hw ether $mac

EOS
}

if [[ ! -e $MARKER ]]; then
    write_mac
    date > $MARKER
fi

exit 0
