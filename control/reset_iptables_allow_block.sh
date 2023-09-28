#!/bin/bash

# shellcheck source=iptables_common.sh
source "$(dirname "$0")/iptables_common.sh"

reset_ipset

reset_ip_rules

create_filter_table

sudo iptables-restore "$iptables_file"
sudo ip6tables-restore "$ip6tables_file"


# most policy created, block/allow related set starts with c_b._
{
  for set in $(sudo ipset list -name | grep "^c_b._"); do
    echo "flush -! $set"
  done
  for set in $(sudo ipset list -name | grep "^c_b._"); do
    echo "destroy -! $set"
  done
} > "${ipset_file}"

sudo ipset restore -! --file "${ipset_file}"
