#!/bin/bash

CMD=$(basename $0)
: ${NUM_REBOOTS:=10}

show_reboot() {
    cat <<EOT

==> $1 <==
EOT
    sudo zgrep -anP '(\x00+|Booting Linux|FIREONBOOT.UPGRADE.DATE.SYNC.DONE)' $1 | tac | grep -B2  -aP '(\x00+|Booting)' | tac | reformat
}

reformat() {
    printf "\nLINENO\tTIMESTAMP\tNOTE\n"
    echo '-------------------------------------'
    lno= ; ts= ;boot=reboot
    while read line
    do
    #echo ">>line<<"; echo "$line"
        case "$line" in
          *Booting*)
              lno=$(echo "$line" | awk -F: '{print $1}')
              ;;
          *Inserted*)
              boot='power cycle'
              ;;
          *FIREONBOOT.UPGRADE.DATE.SYNC.DONE*)
              ts=$(echo "$line" | sed 's/[0-9]*:\(.*\([ :][0-9][0-9]\)\{3\}\).*/\1/')
              ;;
        esac
        if [[ -n "$ts" ]]
        then
            printf "%d\t%s\t%s\n" "$lno" "$ts" "$boot"
            lno= ; ts= ; boot=reboot
        fi
    done | tail -$NUM_REBOOTS
}

usage() {
    cat <<EOU
usage: $CMD [-m <max_number_of_reboots_to_show>]
EOU
}

while getopts ":hm:" opt
do
    case $opt in
        m) NUM_REBOOTS=$OPTARG ;;
	h) usage; exit 0 ;;
    esac
done

for f in $(ls -tr /var/log/syslog*)
do
    show_reboot $f
done
