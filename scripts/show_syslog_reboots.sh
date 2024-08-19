#!/bin/bash

CMD=$(basename $0)
: ${NUM_REBOOTS:=10}
: ${THRESHOLD_HANG:=900}

show_reboot() {
    cat <<EOT

==> $1 <==
EOT
    sudo zgrep -anP '(\x00+|fake-hwclock.data|FIREONBOOT.UPGRADE.DATE.SYNC.DONE)' -B1 $1 | sed 's/\x0\x0*/NULLS/g' | reformat
}

reformat() {
    printf "\nLINENO\tTIMESTAMP\tNOTE\n"
    echo '-------------------------------------'
    lno= ; ts= ;boot=
    while read line
    do
    #echo ">>line<<"; echo "$line"
        case "$line" in
            \-\-)
              continue
              ;;
          *NULLS*)
              lno=$(echo "$line" | awk -F: '{print $1}')
              boot='power cycle'
              ;;
          *FIREONBOOT.UPGRADE.DATE.SYNC.DONE*)
              ts=$(echo "$line" | sed 's/[0-9]*:\(.*\([ :][0-9][0-9]\)\{3\}\).*/\1/')
              ;;
          *'Unable to read saved clock information: /data/fake-hwclock.data'*)
              lno=$(echo "$line" | awk -F: '{print $1}')
              this_ts=$(echo "$line" | sed 's/[0-9]*:\(.*\([ :][0-9][0-9]\)\{3\}\).*/\1/')
              ts=$this_ts
              this_ts=$(date +%s -d "$this_ts")
              last_ts=$(echo "$last_line" | sed 's/[0-9]*-\(.*\([ :][0-9][0-9]\)\{3\}\).*/\1/')
              if [[ -n "$last_ts" ]]; then
                  ts=$last_ts
                  last_ts=$(date +%s -d "$last_ts")
                  if (( this_ts - last_ts > THRESHOLD_HANG )); then
                      boot='hang/power off'
                  else
                      boot=reboot
                  fi
              else
                  boot='hang/power off'
              fi
	      ;;
        esac
        if [[ -n "$ts" && -n "$boot" ]]
        then
            printf "%d\t%s\t%s\n" "$lno" "$ts" "$boot"
            lno= ; boot= ; ts=
        fi
        last_line=$line
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
        m) NUM_REBOOTS=$OPTARG ; shift 2 ;;
        h) usage; exit 0 ;;
    esac
done
TARGET_DIR=${1:-'/var/log'}

for f in $(ls -tr $TARGET_DIR/syslog*)
do
    show_reboot $f
done
