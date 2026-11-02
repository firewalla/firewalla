#!/bin/bash

# shellcheck source=iptables_common.sh
source "$(dirname "$0")/iptables_common.sh"

create_route_chains

{
  iptables-save -t mangle | grep -vE "^:FW_S?RT[ _]| FW_S?RT[ _]|^COMMIT"
  cat "$route_file"
  echo 'COMMIT'
} > "$iptables_file"

{
  ip6tables-save -t mangle | grep -vE "^:FW_S?RT[ _]| FW_S?RT[ _]|^COMMIT"
  cat "$route_file"
  echo 'COMMIT'
} > "$ip6tables_file"

iptables-restore "$iptables_file"
ip6tables-restore "$ip6tables_file"


# all sets will be rebuild on policy enforcement
# policy related c_bd_* sets are dealt with in Node

{
  for set in $(ipset list -name | grep "^c_rt_"); do
    echo "flush -! $set"
  done

  for set in $(ipset list -name | grep "^c_rt_"); do
    echo "destroy -! $set"
  done
} > "${ipset_destroy_file}"

ipset restore -! --file "${ipset_destroy_file}"

