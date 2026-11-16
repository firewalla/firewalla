#!/bin/bash

# shellcheck source=iptables_common.sh
source "$(dirname "$0")/iptables_common.sh"

# Check if --dry-run parameter is provided
DRY_RUN=false
if [[ "$1" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "Running in dry-run mode - no iptables-restore or ipset restore will be executed"
fi

reset_ipset

if [[ $MANAGED_BY_FIREROUTER != "yes" ]]; then
  sudo iptables -w -F FORWARD
  sudo iptables -w -t nat -F PREROUTING
  sudo ip6tables -w -F FORWARD
  sudo ip6tables -w -t nat -F PREROUTING
fi


reset_ip_rules

create_filter_table


# ============= NAT =============
{
echo '*nat'

cat << EOF
-N FW_PREROUTING

-N FW_POSTROUTING


# create POSTROUTING VPN chain
-N FW_POSTROUTING_OPENVPN
-A FW_POSTROUTING -j FW_POSTROUTING_OPENVPN

# create POSTROUTING WIREGUARD chain
-N FW_POSTROUTING_WIREGUARD
-A FW_POSTROUTING -j FW_POSTROUTING_WIREGUARD

# nat POSTROUTING port forward hairpin chain
-N FW_POSTROUTING_PORT_FORWARD
-A FW_POSTROUTING -m conntrack --ctstate DNAT -j FW_POSTROUTING_PORT_FORWARD
-N FW_POSTROUTING_HAIRPIN
# create POSTROUTING dmz host chain and add it to the end of port forward chain
-N FW_POSTROUTING_DMZ_HOST
-A FW_POSTROUTING_PORT_FORWARD -j FW_POSTROUTING_DMZ_HOST
# create POSTROUTING pbr chain
-N FW_PR_SNAT
-A FW_POSTROUTING -m conntrack --ctdir ORIGINAL -j FW_PR_SNAT
-N FW_VC_SNAT
-A FW_POSTROUTING -j FW_VC_SNAT

-N FW_PR_SNAT_DEV
-N FW_PR_SNAT_DEV_1
-A FW_PR_SNAT_DEV -j FW_PR_SNAT_DEV_1
-N FW_PR_SNAT_DEV_2
-A FW_PR_SNAT_DEV -j FW_PR_SNAT_DEV_2
-N FW_PR_SNAT_DEV_3
-A FW_PR_SNAT_DEV -j FW_PR_SNAT_DEV_3
-N FW_PR_SNAT_DEV_4
-A FW_PR_SNAT_DEV -j FW_PR_SNAT_DEV_4
-N FW_PR_SNAT_DEV_5
-A FW_PR_SNAT_DEV -j FW_PR_SNAT_DEV_5
-N FW_PR_SNAT_DEV_G
-N FW_PR_SNAT_DEV_G_1
-A FW_PR_SNAT_DEV_G -j FW_PR_SNAT_DEV_G_1
-N FW_PR_SNAT_DEV_G_2
-A FW_PR_SNAT_DEV_G -j FW_PR_SNAT_DEV_G_2
-N FW_PR_SNAT_DEV_G_3
-A FW_PR_SNAT_DEV_G -j FW_PR_SNAT_DEV_G_3
-N FW_PR_SNAT_DEV_G_4
-A FW_PR_SNAT_DEV_G -j FW_PR_SNAT_DEV_G_4
-N FW_PR_SNAT_DEV_G_5
-A FW_PR_SNAT_DEV_G -j FW_PR_SNAT_DEV_G_5
-N FW_PR_SNAT_NET
-N FW_PR_SNAT_NET_1
-A FW_PR_SNAT_NET -j FW_PR_SNAT_NET_1
-N FW_PR_SNAT_NET_2
-A FW_PR_SNAT_NET -j FW_PR_SNAT_NET_2
-N FW_PR_SNAT_NET_3
-A FW_PR_SNAT_NET -j FW_PR_SNAT_NET_3
-N FW_PR_SNAT_NET_4
-A FW_PR_SNAT_NET -j FW_PR_SNAT_NET_4
-N FW_PR_SNAT_NET_5
-A FW_PR_SNAT_NET -j FW_PR_SNAT_NET_5
-N FW_PR_SNAT_NET_G
-N FW_PR_SNAT_NET_G_1
-A FW_PR_SNAT_NET_G -j FW_PR_SNAT_NET_G_1
-N FW_PR_SNAT_NET_G_2
-A FW_PR_SNAT_NET_G -j FW_PR_SNAT_NET_G_2
-N FW_PR_SNAT_NET_G_3
-A FW_PR_SNAT_NET_G -j FW_PR_SNAT_NET_G_3
-N FW_PR_SNAT_NET_G_4
-A FW_PR_SNAT_NET_G -j FW_PR_SNAT_NET_G_4
-N FW_PR_SNAT_NET_G_5
-A FW_PR_SNAT_NET_G -j FW_PR_SNAT_NET_G_5
-N FW_PR_SNAT_GLOBAL
-N FW_PR_SNAT_GLOBAL_1
-A FW_PR_SNAT_GLOBAL -j FW_PR_SNAT_GLOBAL_1
-N FW_PR_SNAT_GLOBAL_2
-A FW_PR_SNAT_GLOBAL -j FW_PR_SNAT_GLOBAL_2
-N FW_PR_SNAT_GLOBAL_3
-A FW_PR_SNAT_GLOBAL -j FW_PR_SNAT_GLOBAL_3
-N FW_PR_SNAT_GLOBAL_4
-A FW_PR_SNAT_GLOBAL -j FW_PR_SNAT_GLOBAL_4
-N FW_PR_SNAT_GLOBAL_5
-A FW_PR_SNAT_GLOBAL -j FW_PR_SNAT_GLOBAL_5

-A FW_PR_SNAT -j FW_PR_SNAT_DEV
-A FW_PR_SNAT -j FW_PR_SNAT_DEV_G
-A FW_PR_SNAT -j FW_PR_SNAT_NET
-A FW_PR_SNAT -j FW_PR_SNAT_NET_G
-A FW_PR_SNAT -j FW_PR_SNAT_GLOBAL

# nat blackhole 8888
-N FW_NAT_HOLE
-A FW_NAT_HOLE -p tcp -j REDIRECT --to-ports 8888
-A FW_NAT_HOLE -p udp -j REDIRECT --to-ports 8888
-A FW_NAT_HOLE -j RETURN


# a special chain mainly for red/blue to redirect VPN connection on overlay IP to primary IP if two subnets are the same
-N FW_PREROUTING_VPN_OVERLAY
-A FW_PREROUTING -j FW_PREROUTING_VPN_OVERLAY

# VPN client chain to mark VPN client inbound connection
-N FW_PREROUTING_VC_INBOUND
-A FW_PREROUTING -j FW_PREROUTING_VC_INBOUND

# DNAT related chain comes first
# create port forward chain in PREROUTING, this is used in ipv4 only
-N FW_PREROUTING_EXT_IP
-A FW_PREROUTING -j FW_PREROUTING_EXT_IP
-N FW_PREROUTING_VC_EXT_IP
-A FW_PREROUTING -j FW_PREROUTING_VC_EXT_IP
-N FW_PRERT_PORT_FORWARD
-N FW_PRERT_VC_PORT_FORWARD
# create dmz host chain, this is used in ipv4 only
-N FW_PREROUTING_DMZ_HOST
-A FW_PREROUTING_DMZ_HOST -p tcp -m multiport --dports 22,53,8853,8837,8833,8834,8835 -j RETURN
-A FW_PREROUTING_DMZ_HOST -p udp -m multiport --dports 53,8853 -j RETURN
# add dmz host chain to the end of port forward chain
-A FW_PRERT_PORT_FORWARD -j FW_PREROUTING_DMZ_HOST
-A FW_PRERT_VC_PORT_FORWARD -j FW_PREROUTING_DMZ_HOST

# create vpn client dns redirect chain in FW_PREROUTING
-N FW_PREROUTING_DNS_VPN_CLIENT

# initialize nat dns fallback chain, which is traversed if acl is off
-N FW_PREROUTING_DNS_FALLBACK

# fire.walla must always resolve via dnsmasq regardless of bypass status
-N FW_PREROUTING_DNS_FIRE_WALLA
-A FW_PREROUTING -j FW_PREROUTING_DNS_FIRE_WALLA

# create regular dns redirect chain in FW_PREROUTING
-N FW_PREROUTING_DNS_VPN
-A FW_PREROUTING -j FW_PREROUTING_DNS_VPN
-N FW_PREROUTING_DNS_WG
-A FW_PREROUTING -j FW_PREROUTING_DNS_WG
-N FW_PREROUTING_DNS_DEFAULT
# skip FW_PREROUTING_DNS_DEFAULT chain if acl or dns booster is off
-A FW_PREROUTING -m set ! --match-set acl_off_set src,src -m set ! --match-set no_dns_caching_set src,src -j FW_PREROUTING_DNS_DEFAULT
-A FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT
# traverse DNS fallback chain if default chain is not taken
-A FW_PREROUTING -j FW_PREROUTING_DNS_FALLBACK

# redirect blue hole ip 80/443 port to localhost
-A FW_PREROUTING -p tcp --destination ${BLUE_HOLE_IP} --destination-port 80 -j REDIRECT --to-ports 8880
-A FW_PREROUTING -p tcp --destination ${BLUE_HOLE_IP} --destination-port 443 -j REDIRECT --to-ports 8883
# redirect local http request to port 8833
-A FW_PREROUTING -p tcp -m tcp --dport 80 -m set --match-set monitored_net_set src,src -m addrtype --dst-type LOCAL  -j REDIRECT --to-ports 8833
EOF

if [[ $MANAGED_BY_FIREROUTER == "yes" ]]; then
  if sudo iptables -w -t nat -L FR_WIREGUARD -n &>/dev/null; then
    echo '-A FW_PREROUTING_DMZ_HOST -j FR_WIREGUARD'
  fi
  if sudo iptables -w -t nat -L FR_AMNEZIA_WG -n &>/dev/null; then
    echo '-A FW_PREROUTING_DMZ_HOST -j FR_AMNEZIA_WG'
  fi
fi

echo 'COMMIT'
} >> "$iptables_file"


{
echo '*nat'

cat << EOF
-N FW_PREROUTING

-N FW_POSTROUTING
-N FW_VC_SNAT
-A FW_POSTROUTING -j FW_VC_SNAT

# create POSTROUTING VPN chain
-N FW_POSTROUTING_OPENVPN
-A FW_POSTROUTING -j FW_POSTROUTING_OPENVPN

# nat blackhole 8888
-N FW_NAT_HOLE
-A FW_NAT_HOLE -p tcp -j REDIRECT --to-ports 8888
-A FW_NAT_HOLE -p udp -j REDIRECT --to-ports 8888
-A FW_NAT_HOLE -j RETURN

# VPN client chain to mark VPN client inbound connection
-N FW_PREROUTING_VC_INBOUND
-A FW_PREROUTING -j FW_PREROUTING_VC_INBOUND

# create vpn client dns redirect chain in FW_PREROUTING
-N FW_PREROUTING_DNS_VPN_CLIENT

# initialize nat dns fallback chain, which is traversed if acl is off
-N FW_PREROUTING_DNS_FALLBACK

# fire.walla must always resolve via dnsmasq regardless of bypass status
-N FW_PREROUTING_DNS_FIRE_WALLA
-A FW_PREROUTING -j FW_PREROUTING_DNS_FIRE_WALLA

# create regular dns redirect chain in FW_PREROUTING
-N FW_PREROUTING_DNS_VPN
-A FW_PREROUTING -j FW_PREROUTING_DNS_VPN
-N FW_PREROUTING_DNS_WG
-A FW_PREROUTING -j FW_PREROUTING_DNS_WG
-N FW_PREROUTING_DNS_DEFAULT
# skip FW_PREROUTING_DNS_DEFAULT chain if acl or dns booster is off
-A FW_PREROUTING -m set ! --match-set acl_off_set src,src -m set ! --match-set no_dns_caching_set src,src -j FW_PREROUTING_DNS_DEFAULT
-A FW_PREROUTING -j FW_PREROUTING_DNS_VPN_CLIENT
# traverse DNS fallback chain if default chain is not taken
-A FW_PREROUTING -j FW_PREROUTING_DNS_FALLBACK
# redirect local http request to port 8833
-A FW_PREROUTING -p tcp -m tcp --dport 80 -m set --match-set monitored_net_set src,src -m addrtype --dst-type LOCAL  -j REDIRECT --to-ports 8833

COMMIT
EOF
} >> "$ip6tables_file"


# ============= mangle =============
mangle_file=${FIREWALLA_HIDDEN}/run/iptables/mangle

create_route_chains

create_qos_chains

{
cat << EOF
-N FW_OUTPUT

# restore fwmark for reply packets of inbound connections
-A FW_OUTPUT -m connmark ! --mark 0x0/0xffff -m conntrack --ctdir REPLY -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff

# the sequence is important, higher priority rule is placed after lower priority rule
-N FW_PREROUTING

# do not change fwmark if it is an existing outbound connection, both for session sticky and reducing iptables overhead
-A FW_PREROUTING -m connmark ! --mark 0x0/0xffff -m conntrack --ctdir ORIGINAL -m set --match-set c_lan_set src,src -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff
# restore mark on a REPLY packet of an existing connection
-A FW_PREROUTING -m connmark ! --mark 0x0/0xffff -m conntrack --ctdir REPLY -j CONNMARK --restore-mark --nfmask 0xffff --ctmask 0xffff
-A FW_PREROUTING -m mark ! --mark 0x0/0xffff -j RETURN
# always check first 4 original packets of a new connection, this is mainly for tls match
-A FW_PREROUTING -m connbytes --connbytes 4 --connbytes-dir original --connbytes-mode packets -j RETURN

EOF

cat "$route_file"

cat << EOF
# save the nfmark to connmark, which will be restored for subsequent packets of this connection and reduce duplicate chain traversal
-A FW_PREROUTING -m set --match-set c_lan_set src,src -m conntrack --ctdir ORIGINAL -m mark ! --mark 0x0/0xffff -j CONNMARK --save-mark --nfmask 0xffff --ctmask 0xffff

-N FW_FORWARD
EOF

cat "$qos_file"

} > "$mangle_file"

{
  echo '*mangle'
  cat "$mangle_file"
  echo 'COMMIT'
} >> "$iptables_file"

{
  echo '*mangle'
  cat "$mangle_file"
  echo 'COMMIT'
} >> "$ip6tables_file"

function tlsModuleSupported() {
  local module_name=$1
  if [[ ${module_name} = "xt_tls" && ${XT_TLS_SUPPORTED} != "yes" ]]; then
    return 1
  fi
  if [[ ${module_name} = "xt_udp_tls" && ${XT_UDP_TLS_SUPPORTED} != "yes" ]]; then
    return 1
  fi
  return 0
}

# Return 0 (needs a kernel module (re)load) only when the module is supported on this
# platform AND it is not loaded yet, or the loaded ko differs from the bundled one.
# Return 1 otherwise so we can skip the disruptive rmmod/restore cycle.
# The userspace .so is checked separately by tlsSoNeedsUpdate: installing it does not
# require reloading the module, so a .so-only change must not trigger the cycle.
function tlsKoNeedsUpdate() {
  local module_name=$1
  tlsModuleSupported "${module_name}" || return 1

  # not loaded yet -> needs install
  if ! lsmod | grep -wq "${module_name}"; then
    return 0
  fi

  # loaded but its hostset proc directory is missing -> module is not working, needs reinstall
  if [[ ! -d "/proc/net/${module_name}/hostset" ]]; then
    return 0
  fi

  # is the loaded module the one built from the bundled .ko? srcversion when the build has
  # one, GNU build-id otherwise (see scripts/tls_module_id.sh). When neither side yields a
  # comparable id we cannot tell, and leave the loaded module alone.
  local ko_path
  ko_path=$(get_tls_ko_path "${module_name}")
  if [[ -f $ko_path ]]; then
    tls_module_matches_ko "${module_name}" "$ko_path"
    case $? in
      1)
        echo "${module_name}: loaded module differs from the bundled ko, reload needed"
        return 0
        ;;
      2)
        echo "${module_name}: cannot determine whether the loaded module matches ${ko_path}, leaving it loaded"
        ;;
    esac
  fi

  return 1
}

# Return 0 when the bundled userspace .so differs from the installed one (or is not
# installed at all). Only the .so needs to be copied in that case.
function tlsSoNeedsUpdate() {
  local module_name=$1
  tlsModuleSupported "${module_name}" || return 1

  local src_so installed_so
  src_so=$(get_tls_so_path "${module_name}")
  installed_so=$(get_tls_so_installed_path "${module_name}")
  [[ -n "$src_so" ]] || return 1
  if [[ ! -f $installed_so ]] || [[ $(sha256sum "$installed_so" | awk '{print $1}') != $(sha256sum "$src_so" | awk '{print $1}') ]]; then
    return 0
  fi

  return 1
}

if [[ $XT_TLS_SUPPORTED == "yes" || $XT_UDP_TLS_SUPPORTED == "yes" ]]; then
  module_names=("tls" "udp_tls")

  # ko and .so are checked separately: reloading the kernel module means rmmod plus a
  # tls-rule-free iptables restore, while the .so is just a file copy. Modules whose ko
  # changed are reloaded (installTLSModule installs their .so too), the rest only get
  # their .so refreshed.
  modules_to_reload=()
  so_to_update=()
  for module_name in "${module_names[@]}"; do
    if tlsKoNeedsUpdate "xt_${module_name}"; then
      modules_to_reload+=("$module_name")
    elif tlsSoNeedsUpdate "xt_${module_name}"; then
      so_to_update+=("$module_name")
    fi
  done

  echo "Modules to reload: ${modules_to_reload[*]}"
  echo "Shared objects to update: ${so_to_update[*]}"

  # a .so-only change affects neither the loaded module nor existing rules, install it in
  # place. Must happen before the iptables-restore at the end of this script, which may
  # contain "-m tls" rules parsed by this .so.
  for module_name in "${so_to_update[@]}"; do
    installTLSSharedObject "xt_${module_name}"
  done

  if [[ ${#modules_to_reload[@]} -gt 0 ]]; then
    # existence of "-m tls" or "-m udp_tls" rules prevents kernel module from being updated, resotre with a tls-clean version first
    sudo iptables-save > "$iptables_file.orig"
    sudo ip6tables-save > "$ip6tables_file.orig"

    grep -vE "\-m tls|\-m udp_tls" "$iptables_file.orig" | sudo iptables-restore
    grep -vE "\-m tls|\-m udp_tls" "$ip6tables_file.orig" | sudo ip6tables-restore
    for module_name in "${modules_to_reload[@]}"; do
      if lsmod | grep -w "xt_${module_name}"; then
        sudo rmmod "xt_${module_name}"
        if [[ $? -eq 0 ]]; then
          installTLSModule "xt_${module_name}"
        fi
      else
        installTLSModule "xt_${module_name}"
      fi
    done

    sudo iptables-restore "$iptables_file.orig"
    sudo ip6tables-restore "$ip6tables_file.orig"
  fi
fi

# install out-of-tree sch_cake.ko if applicable
installSchCakeModule

normalize_chain_declarations "$iptables_file" "$ip6tables_file"

# jump rules from the builtin chains into the FW_ chains, applied in both modes since
# the skeleton no longer carries them
install_fw_hooks

if [[ "$DRY_RUN" == "false" ]]; then
  # --noflush: the skeleton only declares FW_ chains now, a flush would drop every
  # rule owned by firerouter, docker and upnp
  sudo iptables-restore --noflush "$iptables_file"
  sudo ip6tables-restore --noflush "$ip6tables_file"
else
  echo "Skipping iptables-restore in dry-run mode"
  echo "Would restore IPv4 rules from: $iptables_file"
  echo "Would restore IPv6 rules from: $ip6tables_file"
fi


# as allow rules are removed, we remove registered upnp services as well.
# firerouter_upnp@* services are always running, restart is fine
sudo rm /var/run/upnp.*.leases
sudo systemctl restart firerouter_upnp*
redis-cli hdel sys:scan:nat upnp


{
  # This will remove all customized ip sets that are not referred in iptables after initialization
  for set in $(sudo ipset list -name | grep "^c_"); do
    echo "flush -! $set"
  done
  # flush before destory, some ipsets may be referred in other ipsets and cannot be destroyed at the first run
  for set in $(sudo ipset list -name | grep "^c_"); do
    echo "destroy -! $set"
  done
} > "${ipset_destroy_file}"

if [[ "$DRY_RUN" == "false" ]]; then
  sudo ipset restore -! --file "${ipset_destroy_file}"
else
  echo "Skipping ipset restore in dry-run mode"
  echo "Would restore ipset from: ${ipset_destroy_file}"
fi

if [[ $MANAGED_BY_FIREROUTER == "yes" ]]; then
  sudo iptables -w -N DOCKER-USER &>/dev/null
  sudo iptables -w -F DOCKER-USER
  sudo iptables -w -A DOCKER-USER -p tcp -m tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
  sudo iptables -w -A DOCKER-USER -j RETURN
fi

create_tc_rules

sudo ebtables -t nat --concurrent -N FW_PREROUTING -P RETURN &>/dev/null
sudo ebtables -t nat --concurrent -F FW_PREROUTING
sudo ebtables -t nat --concurrent -Lx PREROUTING | grep "^-j FW_PREROUTING" || sudo ebtables -t nat --concurrent -A PREROUTING -j FW_PREROUTING
