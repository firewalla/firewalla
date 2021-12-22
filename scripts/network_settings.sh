#!/bin/bash

get_value() {
  kind=$1
  case $kind in
    ip)
      sudo /sbin/ip addr show dev eth0 |
        awk '/inet /' |
        awk '$NF=="eth0" {print $2}' |
        fgrep -v 169.254. |
        fgrep -v -w 0.0.0.0 |
        fgrep -v -w 255.255.255.255 |
        head -n 1
      ;;
    gw)
      sudo /sbin/ip route show dev eth0 |
        awk '/default via/ {print $3}' |
        grep -oE "\b([0-9]{1,3}\.){3}[0-9]{1,3}\b" |
        fgrep -v -w 0.0.0.0 |
        fgrep -v -w 255.255.255.255
      ;;
  esac
}

save_values() {
  r=0
  $LOGGER "Save working values of ip/gw/dns"
  for kind in ip gw
  do
    value=$(get_value $kind)
    test -n "$value" || { r=1; break; }
    file=/home/pi/.firewalla/run/saved_${kind}
    rm -f $file
    $LOGGER "Current $kind is $value"
    echo "$value" > $file || { r=1; break; }
  done

  if [[ -f /etc/resolv.conf ]]
  then
    $LOGGER "Current dns is ..."
    cat /etc/resolv.conf |$LOGGER
    sudo /bin/cp -f /etc/resolv.conf /home/pi/.firewalla/run/saved_resolv.conf || r=1
  else
    r=1
  fi

  if [[ $r -eq 1 ]]
  then
    $ERR "Invalid value in IP/GW/DNS detected, save nothing"
    rm -rf /home/pi/.firewalla/run/saved_*
  fi

  return $r
}

set_value() {
  kind=$1
  saved_value=$2
  case ${kind} in
    ip)
      sudo /sbin/ip addr flush dev eth0 # flush legacy ips on eth0
      sudo /sbin/ip addr replace ${saved_value} dev eth0
      # 'ip addr flush dev eth0' will flush overlay IP address
      [[ -x /etc/network/if-pre-up.d/subintf ]] && sudo /etc/network/if-pre-up.d/subintf
      ;;
    gw)
      sudo /sbin/ip route replace default via ${saved_value} dev eth0 # upsert current default route
      ;;
  esac
}

restore_values() {
  r=0
  $LOGGER "Restore saved values of ip/gw/dns"
  for kind in ip gw
  do
    file=/home/pi/.firewalla/run/saved_${kind}
    [[ -e "$file" ]] || continue
    saved_value=$(cat $file)
    [[ -n "$saved_value" ]] || continue

    $LOGGER "Restoring value of $kind, $saved_value"
    set_value $kind $saved_value || r=1
  done
  if [[ -e /home/pi/.firewalla/run/saved_resolv.conf ]]; then
    $LOGGER "Restoring value of dns..."
    cat /home/pi/.firewalla/run/saved_resolv.conf |$LOGGER
    sudo /bin/cp -f /home/pi/.firewalla/run/saved_resolv.conf /etc/resolv.conf
  else
    r=1
  fi
  sleep 3
  return $r
}

UNAME=$(uname -m)

case "$UNAME" in
  "x86_64")
    export FIREWALLA_PLATFORM=gold
    ;;
  "aarch64")
    if [[ -e /etc/firewalla-release ]]; then
      BOARD=$( . /etc/firewalla-release 2>/dev/null && echo $BOARD || cat /etc/firewalla-release )
    else
      BOARD='unknown'
    fi
    case $BOARD in
      navy)
        export FIREWALLA_PLATFORM=navy
        ;;
      blue)
        export FIREWALLA_PLATFORM=blue
        ;;
      ubt)
        export FIREWALLA_PLATFORM=ubt
        ;;
      purple)
        export FIREWALLA_PLATFORM=purple
        ;;
      *)
        ;;
    esac
    ;;
  "armv7l")
    export FIREWALLA_PLATFORM=red
    ;;
  *)
    ;;
esac
