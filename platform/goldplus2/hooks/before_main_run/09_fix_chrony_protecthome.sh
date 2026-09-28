#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

SERVICE_FILE="/media/root-ro/usr/lib/systemd/system/chrony.service"

if [[ ! -f "$SERVICE_FILE" ]]; then
    exit 0
fi


check_protecthome_disabled() {
  grep -q "^ProtectHome=no$" "$SERVICE_FILE"
}


disable_protecthome() {
  local tmp="${SERVICE_FILE}.tmp.$$"
  local orig_lines
  orig_lines=$(wc -l < "$SERVICE_FILE")

  if grep -qE "^[[:space:]]*ProtectHome=" "$SERVICE_FILE"; then
    sed -E 's/^[[:space:]]*ProtectHome=.*/ProtectHome=no/' "$SERVICE_FILE" | sudo tee "$tmp" >/dev/null
  else
    sed '/^\[Service\]$/a ProtectHome=no' "$SERVICE_FILE" | sudo tee "$tmp" >/dev/null
  fi

  if [[ $(wc -l < "$tmp") -lt $orig_lines ]] || ! grep -q "^ProtectHome=no$" "$tmp"; then
    sudo rm -f "$tmp"
    return 1
  fi

  sudo tee "$SERVICE_FILE" < "$tmp" >/dev/null
  local write_rc=$?
  sudo rm -f "$tmp"
  return $write_rc
}


if ! check_protecthome_disabled; then
  mount -t ext4 | grep "/media/root-ro" | awk '{print $6}' | grep -q -w rw
  writable=$?
  if [[ ! writable -eq 0 ]]; then
    sudo mount -o remount,rw /media/root-ro || exit 1
  fi

  disable_protecthome
  disable_rc=$?

  remount_ro_rc=0
  if [[ ! writable -eq 0 ]]; then
    sudo mount -o remount,ro /media/root-ro
    remount_ro_rc=$?
  fi

  if [[ $disable_rc -ne 0 ]]; then
    exit 1
  fi

  # ProtectHome=yes sandboxes chrony away from /home/*, but /etc/resolv.conf
  # on this platform is a symlink into pi's home dir; without this it can't
  # resolve NTP pool hostnames and falls back to orphan mode.
  sudo systemctl daemon-reload

  # Check systemd's own resolved value, not the raw file: a duplicate or
  # whitespace-variant ProtectHome line elsewhere in the unit could still
  # win even though our line landed correctly.
  if [[ "$(systemctl show chrony.service -p ProtectHome --value)" != "no" ]]; then
    exit 1
  fi

  sudo systemctl restart chrony.service

  if [[ $remount_ro_rc -ne 0 ]]; then
    exit 1
  fi
fi

exit 0
