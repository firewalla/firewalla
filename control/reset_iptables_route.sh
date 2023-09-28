#!/bin/bash

# shellcheck source=iptables_common.sh
source "$(dirname "$0")/iptables_common.sh"

reset_ip_rules

create_route_chains

{
  sudo iptables-save -t mangle | grep -vE "^:FW_S?RT[ _]| FW_S?RT[ _]|^COMMIT"
  cat "$route_file"
  echo 'COMMIT'
} > "$iptables_file"

{
  sudo ip6tables-save -t mangle | grep -vE "^:FW_S?RT[ _]| FW_S?RT[ _]|^COMMIT"
  cat "$route_file"
  echo 'COMMIT'
} > "$ip6tables_file"

sudo iptables-restore "$iptables_file"
sudo ip6tables-restore "$ip6tables_file"


# all sets will be rebuild on policy enforcement
# policy related c_bd_* sets are dealt with in Node

{
  for set in $(sudo ipset list -name | grep "^c_rt_"); do
    echo "flush -! $set"
  done

  for set in $(sudo ipset list -name | grep "^c_rt_"); do
    echo "destroy -! $set"
  done
} > "${ipset_file}"

sudo ipset restore -! --file "${ipset_file}"

