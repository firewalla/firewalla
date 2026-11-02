#!/bin/sh
# Name the ethernet NICs by MAC on every boot, before every Firewalla service: the WAN recorded at
# flash time is eth0, every other NIC is eth1.. in ascending MAC order, the same order the installer
# numbers them by.
#
# Why this exists: the kernel names NICs eth0..ethN in probe order, and that order is not stable
# across reboots — a port that was eth2 can come back as eth3. The cloud network config names
# interfaces ("eth0 is the WAN"), so a drifted name silently points at the wrong card: the WAN
# disappears and the box is unreachable. Measured on a 4-port Crystal: 310 boots produced 4
# different kernel orderings, and the WAN card landed on eth2 in 76% of boots and eth3 in 24%.
#
# Only the WAN MAC is read from onboard-config.json (.provision.ifmap.eth0). The LAN ports are all
# in one bridge on Crystal, so naming them by MAC order instead of by a fixed table is enough, and
# it also names a NIC the installer could not see (no driver in the installer, driver in the image).
#
# Why not systemd .link files: the target names and the kernel names are the same eth* pool, so the
# mapping is always a permutation and any drift forms a cycle (eth1 wants eth2's name while eth2
# wants eth1's). udev renames each interface independently and fails with EEXIST on a busy name, so
# a cycle can never resolve — in all 310 measured boots a pure .link setup would have failed.
# Breaking a cycle needs a temporary name, which a declarative .link cannot express. Hence
# park-then-place below: free every target name first, then claim them.
#
# Lives in the firewalla repo as scripts/crystal-ifmap.sh, paired with crystal-ifmap.service.
set -u
CFG=${CRYSTAL_ONBOARD_CONFIG:-/home/pi/.firewalla/onboard-config.json}
MAP=/run/crystal-ifmap                          # /run is tmpfs and always up this early
[ -r "$CFG" ] || { echo "ifmap: no $CFG, nothing to do"; exit 0; }

# A missing or broken jq must not look like an empty config: without the WAN MAC the names are not
# pinned at all, which is a hard failure, not a no-op.
command -v jq >/dev/null 2>&1 || { echo "ifmap: ERROR jq not installed, cannot read $CFG"; exit 1; }
# MACs are lowercased on the way in: sysfs reports lowercase, but a hand-edited config might not.
wan=$(jq -r '.provision.ifmap.eth0 // "" | ascii_downcase' "$CFG") \
  || { echo "ifmap: ERROR could not parse $CFG"; exit 1; }
[ -n "$wan" ] || { echo "ifmap: no .provision.ifmap.eth0 in $CFG, nothing to do"; exit 0; }

# Same NICs the installer counts (e* with a backing device), plus the names this script hands out.
nic_macs(){
  for d in /sys/class/net/*; do
    case $(basename "$d") in e*|ifpark*|unmapped*) ;; *) continue ;; esac
    [ -e "$d/device" ] || continue
    mac=$(cat "$d/address" 2>/dev/null)
    [ -n "$mac" ] && [ "$mac" != "00:00:00:00:00:00" ] && echo "$mac"
  done | LC_ALL=C sort -u
}

iface_of_mac(){
  for d in /sys/class/net/*; do
    [ -e "$d/address" ] || continue
    [ "$(cat "$d/address" 2>/dev/null)" = "$1" ] && { basename "$d"; return 0; }
  done
  return 1
}

# udev may still be probing: let it settle, and wait for the WAN (10s, then proceed anyway).
udevadm settle --timeout=10 2>/dev/null
i=0
while [ "$i" -lt 100 ]; do
  iface_of_mac "$wan" >/dev/null && break
  sleep 0.1; i=$((i + 1))
done
iface_of_mac "$wan" >/dev/null || echo "ifmap: WARN WAN $wan absent, eth0 left unassigned"

# eth0 is always the WAN's, even when it is absent, so a missing WAN never hands eth0 to a LAN port.
echo "eth0 $wan" > "$MAP"
n=1
for mac in $(nic_macs); do
  [ "$mac" = "$wan" ] && continue
  echo "eth$n $mac" >> "$MAP"
  n=$((n + 1))
done

# Already correct on almost every boot: do nothing rather than churn the links.
drift=0
while read -r name mac; do
  cur=$(iface_of_mac "$mac") || continue
  [ "$cur" = "$name" ] || drift=1
done < "$MAP"
[ "$drift" = 1 ] || { echo "ifmap: names already match MACs"; exit 0; }

# Park: free every target name, whoever holds it. An altname can hold a name too, so drop those first.
n=0
while read -r name mac; do
  occ=$(ip -br link show "$name" 2>/dev/null | awk '{print $1; exit}')
  [ -n "$occ" ] || continue
  occ=${occ%%@*}
  if [ "$occ" != "$name" ]; then
    ip link property del altname "$name" dev "$occ" 2>/dev/null   # name was only an altname
    continue
  fi
  ip link set "$occ" down 2>/dev/null
  ip link set "$occ" name "ifpark$n" 2>/dev/null \
    && n=$((n + 1)) \
    || echo "ifmap: ERROR could not park $occ"
done < "$MAP"

# Place: every target name is free now, so each rename is unconditional.
rc=0
while read -r name mac; do
  cur=$(iface_of_mac "$mac") || continue
  [ "$cur" = "$name" ] && continue
  # $cur was only downed if it happened to hold a target name and got parked; the kernel refuses to
  # rename an interface that is UP.
  ip link set "$cur" down 2>/dev/null
  if ip link set "$cur" name "$name" 2>/dev/null; then
    echo "ifmap: $mac -> $name (was $cur)"
  else
    echo "ifmap: ERROR rename $cur -> $name failed"; rc=1
  fi
done < "$MAP"

# Anything still parked was not one of our NICs (no backing device); give it a name outside the pool
# instead of letting it claim a reserved ethN on the next boot.
for d in /sys/class/net/ifpark*; do
  [ -e "$d" ] || continue
  p=$(basename "$d"); mac=$(cat "$d/address" 2>/dev/null)   # read before the rename invalidates $d
  ip link set "$p" name "unmapped${p#ifpark}" 2>/dev/null \
    && echo "ifmap: WARN $mac is not a NIC -> unmapped${p#ifpark}"
done
exit "$rc"
