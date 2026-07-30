#!/bin/sh
# Enforce the flash-time MAC -> ethN mapping from onboard-config.json. Runs before every Firewalla
# service, on every boot.
#
# Why this exists: the kernel names NICs eth0..ethN in probe order, and that order is not stable
# across reboots — a port that was eth2 can come back as eth3. The cloud network config names
# interfaces ("eth0 is the WAN"), so a drifted name silently points at the wrong card: the WAN
# disappears and the box is unreachable. Measured on a 4-port Crystal: 310 boots produced 4
# different kernel orderings, and the WAN card landed on eth2 in 76% of boots and eth3 in 24%.
#
# MAC is the only durable identity, so the installer records a MAC -> name table into
# onboard-config.json (.provision.ifmap) and this script makes the kernel names match it.
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

# MACs are lowercased on the way in: sysfs reports lowercase, but a hand-edited config might not.
jq -r '.provision.ifmap // {} | to_entries[] | "\(.key) \(.value | ascii_downcase)"' "$CFG" 2>/dev/null | sort > "$MAP"
want=$(grep -c '^eth' "$MAP")
[ "$want" -gt 0 ] || { echo "ifmap: no .provision.ifmap in $CFG, nothing to do"; exit 0; }

iface_of_mac(){
  for d in /sys/class/net/*; do
    [ -e "$d/address" ] || continue
    [ "$(cat "$d/address" 2>/dev/null)" = "$1" ] && { basename "$d"; return 0; }
  done
  return 1
}

# udev may still be probing: wait until every mapped NIC has registered (10s, then proceed anyway).
i=0
while [ "$i" -lt 100 ]; do
  have=0
  while read -r name mac; do
    iface_of_mac "$mac" >/dev/null && have=$((have + 1))
  done < "$MAP"
  [ "$have" -ge "$want" ] && break
  sleep 0.1; i=$((i + 1))
done
[ "$have" -ge "$want" ] || echo "ifmap: WARN only $have/$want mapped NICs present — placing those"

# Already correct on almost every boot: do nothing rather than churn the links.
drift=0
while read -r name mac; do
  cur=$(iface_of_mac "$mac") || continue
  [ "$cur" = "$name" ] || drift=1
done < "$MAP"
[ "$drift" = 1 ] || { echo "ifmap: names already match MACs"; exit 0; }

# Park: free every target name, whoever holds it (a mapped NIC on the wrong name, or an unmapped
# card that squatted it). An altname can hold a name too, so drop those first.
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
  cur=$(iface_of_mac "$mac") || { echo "ifmap: WARN $mac absent, $name left unassigned"; continue; }
  [ "$cur" = "$name" ] && continue
  if ip link set "$cur" name "$name" 2>/dev/null; then
    echo "ifmap: $mac -> $name (was $cur)"
  else
    echo "ifmap: ERROR rename $cur -> $name failed"; rc=1
  fi
done < "$MAP"

# Anything still parked is a card the table doesn't know about; give it a name outside the pool
# instead of letting it claim a reserved ethN on the next boot.
for d in /sys/class/net/ifpark*; do
  [ -e "$d" ] || continue
  p=$(basename "$d"); mac=$(cat "$d/address" 2>/dev/null)   # read before the rename invalidates $d
  ip link set "$p" name "unmapped${p#ifpark}" 2>/dev/null \
    && echo "ifmap: WARN $mac not in table -> unmapped${p#ifpark}"
done
exit "$rc"
