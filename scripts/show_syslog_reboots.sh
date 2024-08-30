#!/bin/bash

CMD=$(basename $0)
: ${NUM_REBOOTS:=10}
: ${THRESHOLD_HANG:=900}

err() {
    echo "ERROR: $@" >&2
}

show_reboot() {
    cat <<EOT

==> $1 <==
EOT
    zgrep -anP '(\x00+|fake-hwclock.data)' $1 | sed 's/\x0\x0*/NULLS/g' | reformat $1
}

reformat() {
    file=$1
    case $file in
        *.gz) CAT=zcat ;;
        *) CAT=cat ;;
    esac
    printf "\nLINENO\tTIMESTAMP\tNOTE\n"
    echo '-------------------------------------'
    lno= ; boot= ; last_ts= ; next_ts=
    while read line
    do
    #echo ">>line<<"; echo "$line"
        case "$line" in
          *NULLS*)
              boot_lno=$(echo "$line" | awk -F: '{print $1}')
              boot_ts=$(echo "$line" | awk '{print $1" "$2" "$3}' | sed 's/[0-9]*://')
              last_date=$($CAT $file | head -$boot_lno | cut -d: -f1 | uniq | tail -2 |head -1)
              last_ts=$($CAT $file | head -$boot_lno | cut -d\  -f1-3 | uniq | fgrep -a "$last_date" | tail -1)
              lno=$($CAT $file|head -$boot_lno | fgrep -an "$last_ts" | tail -1|awk -F: '{print $1}')
              boot='power cycle'
              ;;
          *'Unable to read saved clock information: /data/fake-hwclock.data'*)
              boot_lno=$(echo "$line" | awk -F: '{print $1}')
              boot_ts=$(echo "$line" | awk '{print $1" "$2" "$3}' | sed 's/[0-9]*://')
              last_date=$($CAT $file | head -$boot_lno | cut -d: -f1 | uniq | tail -2 |head -1)
              last_ts=$($CAT $file|head -$boot_lno | cut -d\  -f1-3 | uniq | fgrep -a "$last_date" | tail -1)
              lno=$($CAT $file|head -$boot_lno | fgrep -an "$last_ts" | tail -1|awk -F: '{print $1}')
              next_ts=$($CAT $file | sed -n "$boot_lno,\$p" |fgrep -am 1 FIREONBOOT.UPGRADE.DATE.SYNC.DONE | cut -d\  -f1-3)
              if [[ -n "$last_ts" && -n "$next_ts" ]]; then
                  last_ts_epoch=$(date +%s -d "$last_ts")
                  next_ts_epoch=$(date +%s -d "$next_ts")
                  if (( next_ts_epoch - last_ts_epoch > THRESHOLD_HANG )); then
                      boot='hang/power off'
                  else
                      boot='reboot'
                  fi
              fi
          ;;
        esac
        if [[ -n "$lno" && -n "$boot" && -n "$last_ts" ]]
        then
            printf "%d\t%s\t%s\n" "$lno" "$last_ts" "$boot"
            lno= ; boot= ; last_ts=
        fi
    done | tail -$NUM_REBOOTS
}

usage() {
    cat <<EOU
usage: $CMD [-m <max_number_of_reboots_to_show>]
EOU
}

test $UID -eq 0 || {
   err must run with root privilege
   exit 1
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

