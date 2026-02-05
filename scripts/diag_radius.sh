#!/bin/bash

SSID=""
VERSION=""
SSIDS=""
SECRET=""
WG_AP_GATEWAY=""
PLATFORM=""
BOARD_NAME=""
VERBOSE=""
IMAGE=""
RELEASE_CODE=""

function error() {
    echo -e "\033[0;31m$1\033[0m"
}

function success() {
    echo -e "\033[0;32m$1\033[0m"
}

function warn() {
    echo -e "\033[0;33m$1\033[0m"
}

function debug() {
    if [ "$VERBOSE" == "true" ]; then
        echo -e "\033[0;34m$1\033[0m"
    fi
}

function get_release_code() {
    RELEASE_CODE=$(lsb_release -cs | tr -d '\n')
}

function help() {
    cat << EOF
Usage: $0 [OPTIONS]

Diagnose FreeRadius configuration and status.

OPTIONS:
    --ssid SSID        Optional SSID to check
    --verbose          Print debug messages
    -h, --help         Show this help message
EXAMPLES:
    $0
    $0 --ssid MySSID
    $0 --silence
EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --ssid)
            SSID="$2"
            shift 2
            ;;
        --verbose)
            VERBOSE="true"
            shift
            ;;
        -h|--help)
            help
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            help
            exit 1
            ;;
    esac
done

function frcc() {
    curl "http://localhost:8837/v1/config/active" 2>/dev/null | jq "$@"
}

function ap_status() {
    curl "http://localhost:8841/v1/status/ap" 2>/dev/null
}

function get_platform() {
    if [ -f "/etc/firewalla-release" ]; then
        PLATFORM=$(awk -F= '/BOARD=/ {print $2}' /etc/firewalla-release | tr '[:upper:]' '[:lower:]')
    else
        #  u18 Model: Gold
        if [ -f "/etc/firewalla_release" ]; then
            PLATFORM=$(awk '/Model: / {print $2}' /etc/firewalla_release | tr '[:upper:]' '[:lower:]')
        else
            PLATFORM="unknown"
        fi
    fi
    debug $PLATFORM
}

function get_board_name() {
    BOARD_NAME=$(redis-cli get board_name)
    debug $BOARD_NAME
}

function check_box_version() {
    last_comment=$(git -C /home/pi/firewalla log -1 --pretty=%B | tail -n 1)
    # Gold SE 1.981 Beta Patch
    VERSION=$(echo "$last_comment" | grep -oE '[0-9]+\.[0-9]+')
}

function check_radius_assets() {
    check_box_version
    debug "Checking radius assets..."
    if [ "$VERSION" == "1.981" ]; then
        # check if freeradius.tar.gz present
        warn "1.981 detected, checking freeradius assets"
        if [ -f "/home/pi/.firewalla/run/assets/freeradius.tar.gz" ]; then
            success "OK: freeradius.tar.gz exists in the assets.d folder"
            local assets_md5=$(md5sum /home/pi/.firewalla/run/assets/freeradius.tar.gz | awk '{print $1}')
            debug "freeradius.tar.gz md5: $assets_md5"
            if [[ "$assets_md5" != "f52e5f8da6e38938d62288c0435cb42f" ]]; then
                warn "Warn: 1.981 freeradius.tar.gz md5 mismatch: $assets_md5"
            else
                success "OK: 1.981 freeradius.tar.gz md5 matches: $assets_md5"
            fi
        else
            error "Error: freeradius.tar.gz is not in the assets folder"
        fi

        # check if freeradius config scripts present
        if [ -f "/home/pi/.firewalla/config/freeradius/freeradius.js" ]; then
            success "OK: freeradius scripts exists"
        else
            error "Error: freeradius scripts does not exist"
            local cmd="ls -l /home/pi/.firewalla/config/freeradius"
            debug "$cmd"
            eval $cmd
        fi

        # check if customized certificates are present
        if [ -f "/home/pi/.firewalla/config/freeradius/certs" ]; then
            success "OK: customized certificates are present"
        else
            error "Error: customized certificates are not present"
            local cmd="ls -l /home/pi/.firewalla/config/freeradius/certs"
            debug "$cmd"
            eval $cmd
        fi
    fi

    # check if docker compose file is present
    if [ -f "/home/pi/.firewalla/run/docker/freeradius/docker-compose.yml" ]; then
        success "OK: docker compose file exists"
        ## check if docker compose file contains the correct image
        IMAGE=$(grep "image: " /home/pi/.firewalla/run/docker/freeradius/docker-compose.yml | awk '{print $2}' | tr -d "'\"")
        debug "image: $IMAGE"
        if [[ "$VERSION" == "1.981" ]]; then
            if [[ "$IMAGE" != "public.ecr.aws/a0j1s2e9/freeradius:latest" ]]; then
                error "Error: 1.981 radius image not latest: $IMAGE"
            else
                success "OK: 1.981 radius image is latest: $IMAGE"
            fi
        else
            if [[ "$IMAGE" != "public.ecr.aws/a0j1s2e9/freeradius:prod" ]]; then
                warn "Warn: radius image not prod: $IMAGE"
            else
                success "OK: radius image is prod: $IMAGE"
            fi
        fi
        get_release_code
        if [[ "$RELEASE_CODE" == "bionic" ]]; then
            debug "detected u18, checking if security_opt: seccomp=unconfined is present"
            if ! grep -q "seccomp=unconfined" /home/pi/.firewalla/run/docker/freeradius/docker-compose.yml; then
                error "Error: u18 docker compose file does not contain security_opt: seccomp=unconfined"
            else
                success "OK: u18 docker compose file contains security_opt: seccomp=unconfined"
            fi
        fi
    else
        error "Error: docker compose file does not exist"
    fi

    # check if radius image is present
    if sudo docker images -q --filter "reference=$IMAGE" | grep -q .; then
        success "OK:radius image exists: $IMAGE"
        sudo docker images --filter "reference=$IMAGE"
    else
        error "Error: radius image does not exist: $IMAGE"
    fi

    sys_cert_dir="/home/pi/.firewalla/certs/freeradius"
    # check if certificates are present
    caCertReady=$([ -f "${sys_cert_dir}/ca.pem" ] && [ -f "${sys_cert_dir}/ca.key" ] && echo true || echo false)
    serverCertReady=$([ -f "${sys_cert_dir}/server.pem" ] && [ -f "${sys_cert_dir}/server.key" ] && echo true || echo false)
    local cmd="ls -l /home/pi/.firewalla/certs/freeradius"
    debug "$cmd"
    eval $cmd
    if [ "$caCertReady" == "true" ] || [ "$serverCertReady" == "true" ]; then
        success "OK: certificates are present in $sys_cert_dir"
        debug "check certificates in $sys_cert_dir"

        if [ "$VERSION" == "1.981" ]; then
            debug "check certificates in /home/pi/.firewalla/run/docker/freeradius/raddb"
        fi
    else
        error "certificates are not present"
    fi
}

function check_radius_configure() {
    policy=$(redis-cli hget policy:system freeradius_server | jq -c . 2>/dev/null || echo "")
    WG_AP_GATEWAY=$(ip --br a | grep wg_ap | awk '{print $3}' | cut -d'/' -f1)
    if [[ -z "$policy" || "$policy" == "null" ]]; then
        warn "Warn: Freeradius policy is not set"
    else
        success "OK: Freeradius policy is set"
        SECRET=$(echo "$policy" | jq -rc '.radius.options.secret' 2>/dev/null || echo "")
        CLIENTS=$(echo "$policy" | jq -rc '.radius.clients[].ipaddr' 2>/dev/null || echo "")
        TAGS=$(redis-cli keys policy:tag:* | xargs -I {} bash -c 'printf "%s %s\n" {} $(redis-cli hget {} freeradius_server)' | grep -v '^$')
        USERS=$(redis-cli keys policy:tag:* | xargs -I {} redis-cli hget {} freeradius_server | jq -rc . 2>/dev/null | grep -v '^$' | jq -cr '.radius.users[]' 2>/dev/null || echo "")

        echo "policy clients:"
        echo "$CLIENTS"
        echo "policy tags:"
        echo "$TAGS"
        debug "$USERS"
    fi
}

function check_radius_server_status() {
    echo "######### Checking Radius Server Status ###############"
    enabled=$(redis-cli hget sys:features freeradius_server)
    if [ "$enabled" == "1" ]; then
        debug "feature freeradius_server $enabled"
        success "OK: Freeradius feature is enabled"
    else
        warn "Warn: Freeradius feature is disabled"
    fi

    if sudo docker ps -q -f "name=freeradius_freeradius_1" | grep -q .; then
        if [ "$enabled" == "1" ]; then
            success "OK: Freeradius container is running."
            check_radius_assets
            check_radius_configure
        else
            error "Error: Freeradius feature is disabled but container is running"
            exit 1
        fi
    else
        if [ "$enabled" == "1" ]; then
            error "Freeradius feature is enabled but container is not running"
            check_radius_assets
        else
            success "OK: Freeradius container is running"
            sudo docker ps  -f "name=freeradius_freeradius_1"
        fi
    fi
}

function get_all_ssids() {
    ## if frcc not contains apc.profile, then return
    local profile_check=$(frcc '.apc.profile' 2>/dev/null)
    if [[ -z "$profile_check" || "$profile_check" == "null" ]]; then
        return
    fi
    SSIDS=$(frcc -r '.apc.profile | .[] | select (.encryption == "wpa2") | .ssid')
}

function check_radius_ssids() {
    echo "######### Checking SSID ###############"
    get_all_ssids
    if [ "$SSID" != "" ]; then
        # if SSID is in $SSIDS, then check the config
        if [[ " $SSIDS " == *" $SSID "* ]]; then
            check_ssid_config $SSID
        else
            error "SSID $SSID is not found as wpa2 or wpa3 enterprise mode"
        fi
    else
        get_all_ssids
        if [ "$SSIDS" == "" ]; then
            return
        fi
        for ssid in $SSIDS; do
            check_ssid_config $ssid
        done
    fi
}

function ip_in_clients() {
    local ip="$1"
    while IFS= read -r client_entry; do
        if [ -z "$client_entry" ]; then
            continue
        fi
        # Trim whitespace from client_entry
        client_entry=$(echo "$client_entry" | xargs)
        if [ "$client_entry" == "$ip" ]; then
            return 0
        fi
    done <<< "$CLIENTS"
    return 1
}

function check_ssid_config() {
    profile=$(frcc '.apc.profile | .[] | select(.ssid == "'$1'")')
    debug "profile: $profile"
    ## check radius server wg_ap ip address
    radius_server_addr=$(echo "$profile" | jq -rc '.radius.server' 2>/dev/null || echo "")
    if [ "$radius_server_addr" != "$WG_AP_GATEWAY" ]; then
        error "Error: apc radius server ${radius_server_addr} does not match wg_ap gateway ${WG_AP_GATEWAY}"
    else
        success "OK: apc radius server matches wg_ap gateway $WG_AP_GATEWAY"
    fi

    ## check radius server secret
    secret=$(echo "$profile" | jq -rc '.key' 2>/dev/null || echo "")
    if [ "$secret" != "$SECRET" ]; then
        error "Error: apc secret ${secret:0:3}*** does not match policy ${SECRET:0:3}***"
    else
        success "OK: apc secret matches policy"
    fi

    wg_pubkeys=$(ap_status | jq -r ".info[].wgPubKey" 2>/dev/null || echo "")
    wg_dump=$(sudo wg show wg_ap dump)
    for wg_pubkey in $wg_pubkeys; do
        read ap_vpn_ip < <(echo "$wg_dump"| awk "\$1==\"$wg_pubkey\" {print \$4}")
        ## ap_vpn_ip should be in the CLIENTS list
        if ip_in_clients "$ap_vpn_ip"; then
            success "OK: ap $wg_pubkey wg_ap address $ap_vpn_ip is in the policy"
        else
            error "Error: ap $wg_pubkey wg_ap address $ap_vpn_ip is not in the policy clients $CLIENTS"
        fi
    done
}

function check_clients_config() {
    echo '----------------------------------------------------'
    echo "######### Checking Radius Client Config ###############"
    echo
    echo "clients.conf"
    sudo docker exec -it freeradius_freeradius_1 sed -n '/#  i.e. The entry from the smallest possible network./,/#############/p' clients.conf | head -n -1

    get_platform
    get_board_name
    if [[ "$PLATFORM" == "orange" || "$BOARD_NAME" == "orange" ]]; then
        warn "Orange platform detected"
        sudo docker exec -it freeradius_freeradius_1 sed -n '/client localhost {/,/# IPv6 Client/p' clients.conf | grep -v '^[[:space:]]*#' | grep -v '^[[:space:]]*$'
    fi
}

function check_user_config() {
    echo '----------------------------------------------------'
    echo "######### Checking Radius User Config ###############"
    echo
    echo "wpa3/users"
    sudo docker exec -it freeradius_freeradius_1 cat /etc/freeradius/wpa3/users
    echo
    echo "wpa3/users-policy"
    sudo docker exec -it freeradius_freeradius_1 cat /etc/freeradius/wpa3/users-policy
}

function check_eap_config() {
    echo '----------------------------------------------------'
    echo "######### Checking Radius Client Config ###############"
    echo
    echo "mods-available/eap"
    sudo docker exec -it freeradius_freeradius_1 sed -n '/tls-config tls-common {/,/#  Client certificates can be validated via an/p' mods-available/eap | grep -v '^[[:space:]]*#' | grep -v '^[[:space:]]*$'
    echo

}

function check_container_config() {
    check_clients_config
    check_user_config
    check_eap_config
}

function check_radius_log() {
    echo '----------------------------------------------------'
    echo "######### Checking Radius Log ###############"
    echo
    echo '/home/pi/.forever/freeradius/radius.log'
    grep -i "error" /home/pi/.forever/freeradius/radius.log | tail -n 100 | while IFS= read -r line; do
        error "$line"
    done


    echo
    echo '/home/pi/.forever/freeradius/radauth'
    if [ -d "/home/pi/.forever/freeradius/radauth" ]; then
        find /home/pi/.forever/freeradius/radauth -type f -exec grep -i "access-reject" {} + 2>/dev/null | tail -n 100 | while IFS= read -r line; do
            error "$line"
        done
    fi

    echo
    echo '/home/pi/.forever/freeradius/radacct'
    if [ -d "/home/pi/.forever/freeradius/radacct" ]; then
        if [ "$SSID" != "" ]; then
            find /home/pi/.forever/freeradius/radacct -type f -exec grep -i "$SSID" {} + 2>/dev/null | tail -n 10
        else
            find /home/pi/.forever/freeradius/radacct -type f -exec grep -i "acct_status_type" {} + 2>/dev/null | tail -n 10
        fi
    fi
}

check_radius_server_status
check_radius_ssids
check_container_config
check_radius_log