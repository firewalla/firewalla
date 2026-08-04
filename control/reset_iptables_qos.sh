#!/bin/bash

# shellcheck source=iptables_common.sh
source "$(dirname "$0")/iptables_common.sh"


# not flushing qos_off sets

create_qos_chains

{
  sudo iptables-save -t mangle | grep -vE "^:FW_QOS[ _]| FW_QOS[ _]|^COMMIT"
  cat "$qos_file"
  echo 'COMMIT'
} > "$iptables_file"

{
  sudo ip6tables-save -t mangle | grep -vE "^:FW_QOS[ _]| FW_QOS[ _]|^COMMIT"
  cat "$qos_file"
  echo 'COMMIT'
} > "$ip6tables_file"

# install out-of-tree sch_cake.ko if applicable
installSchCakeModule

sudo iptables-restore "$iptables_file"
sudo ip6tables-restore "$ip6tables_file"

# policy related c_bd_* sets are dealt with in Node

create_tc_rules

