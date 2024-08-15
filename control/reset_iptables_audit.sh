#!/bin/bash

# shellcheck source=iptables_common.sh
source "$(dirname "$0")/iptables_common.sh"

reset_ipset

create_filter_table

# remove entries that related to blocking set as well, so we could remove those sets later
{
  sudo iptables-save -t mangle | grep -v "set c_b._"
} >> "$iptables_file"
{
  sudo ip6tables-save -t mangle | grep -v "set c_b._"
} >> "$ip6tables_file"


sudo iptables-restore "$iptables_file"
sudo ip6tables-restore "$ip6tables_file"


# most policy created, block/allow related set starts with c_b._
# as too many sets are reused between allow/block and route/qos, and hard to distinguish
# route/qos rules are re-enforced in Node after this to make sure that necessary sets are correctly rebuilt
{
  for set in $(sudo ipset list -name | grep "^c_b._"); do
    echo "flush -! $set"
  done
  for set in $(sudo ipset list -name | grep "^c_b._"); do
    echo "destroy -! $set"
  done
} > "${ipset_destroy_file}"

sudo ipset restore -! --file "${ipset_destroy_file}"
