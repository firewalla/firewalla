#!/usr/bin/env bash

# device-timeline.sh
# Usage:
#   ./device-timeline.sh -h
#   ./device-timeline.sh -m "6C:1F:F7:23:39:CB"

# Parse arguments
device_mac=""

while getopts "hm:" opt; do
    case $opt in
        h)
            echo "Usage: $0 -m mac"
            echo "  -m: Device MAC address"
            echo "  -h: Show this help message"
            exit 0
            ;;
        m)
            device_mac="$OPTARG"
            ;;
        \?)
            echo "Invalid option: -$OPTARG" >&2
            echo "Usage: $0 -m mac"
            exit 1
            ;;
    esac
done

if [ -z "$device_mac" ]; then
    echo "Error: MAC address is required"
    echo "Usage: $0 -m mac"
    exit 1
fi

echo "Device MAC: $device_mac"
echo "Getting device timeline..."

function copy_ap_log() {
    ## Copy AP syslog and ap.log to box
    # Check if sshpass is installed
    if ! command -v sshpass &> /dev/null; then
        echo "Warning: sshpass is not installed. Skipping AP log reading."
        echo "Install with: sudo apt-get install sshpass"
        return 1
    fi
    
    data=`curl -s localhost:8841/v1/status/ap | jq -r '.info | to_entries[] | "\(.key),\(.value.licenseUuid),\(.value.name)"'`
    config=`curl -s localhost:8841/v1/config/active | jq -r '.assets | to_entries[] | "\(.key),\(.value.publicKey),\(.value.sysConfig.seq)"'`
    wgdata=`sudo wg show wg_ap dump`
    for line in $data
    do
        read uid lid name< <(echo "$line"| awk -F"," '{print $1" "$2" "$3}')
        seq=$(echo "$config" | grep $uid | awk -F"," '{print $3}')
        pass=$(echo -n "firewalla:$seq:$lid:$uid" | shasum -a 256 | cut -f1 -d" " | xxd -r -p | base64 | cut -c 6-15)
        pubkey=$(echo "$config" | grep $uid | awk -F"," '{print $2}')
        ipaddr=$(echo "$wgdata" | grep $pubkey | awk '{print $4}' | cut -f1 -d "/")
        mkdir -p /tmp/log/ap
        sshpass -p $pass scp -P 8842 -o StrictHostkeyChecking=no -o HostKeyAlgorithms=+ssh-rsa root@$ipaddr:/root/syslog /tmp/log/ap/$uid.syslog
        sshpass -p $pass scp -P 8842 -o StrictHostkeyChecking=no -o HostKeyAlgorithms=+ssh-rsa root@$ipaddr:/var/log/ap.log /tmp/log/ap/$uid.ap.log
    done
}

copy_ap_log

## AP events 
# {"ap":"20:6D:31:61:00:24","band":"5g","bssid":"32:6D:31:61:00:27","channel":36,"intf":"ath14","mac":"42:71:A1:E0:C0:DD","mesh":false,"reason":null,"rssi":-37,"ssid":"Test_710GF_mlo","system_event":"station_connect","ts":1760093674529}
# {"ap":"20:6D:31:61:00:24","band":"2g","bssid":"2A:6D:31:61:00:26","channel":5,"intf":"ath02","mac":"42:71:A1:E0:C0:DD","mesh":false,"reason":null,"rssi":-33,"ssid":"Test_710GF_mlo","system_event":"station_disconnect","ts":1760093674479}
ap_events_raw=$(curl -s -H 'Content-Type: application/json' -XGET "http://127.0.0.1:8841/v1/event_history/$device_mac"| jq -r '.[]')
ap_events=$(echo "$ap_events_raw" | jq -r '[.ts, "[event] Device \(.mac) \(.system_event) on SSID \(.ssid) " + (. | tojson)] | @tsv')

## AP log
## ap_log_raw
# root@Office:~# grep -i "3E:BC:99:52:15:1A" syslog | grep hostapd
# Fri Oct 10 12:57:58 2025 daemon.info hostapd: ath13: STA 3e:bc:99:52:15:1a IEEE 802.11: authenticated
# Fri Oct 10 12:57:58 2025 daemon.info hostapd: ath13: STA 3e:bc:99:52:15:1a IEEE 802.11: associated (aid 1)
ap_log_raw=$(grep -h -i "$device_mac" /tmp/log/ap/*.syslog 2>/dev/null | grep hostapd)

# Parse ap_log_raw to format: (timestamp_ms, log_line)
ap_log=$(echo "$ap_log_raw" | while IFS= read -r line; do
    if [ -z "$line" ]; then
        continue
    fi
    # Extract timestamp (first 5 fields: "Fri Oct 10 12:57:58 2025")
    timestamp=$(echo "$line" | awk '{print $1, $2, $3, $4, $5}')
    data=$(echo "$line" | cut -d' ' -f8-)
    # Convert to epoch seconds, then to milliseconds
    # Linux date format: date -d "string" "+%s"
    ts_sec=$(date -d "$timestamp" "+%s" 2>/dev/null)
    if [ -n "$ts_sec" ]; then
        ts_ms=$((ts_sec * 1000))
        # Output: timestamp_ms<tab>original_line
        printf "%s\t%s\n" "$ts_ms" "[hostapd] $data"
    fi
done)

## DHCP leases
# cat /home/pi/.router/run/dhcp/dnsmasq.leases
# 1760234169 68:da:73:ac:11:07 192.168.20.144 XinniGes-Air 01:68:da:73:ac:11:07
# 1760238702 3e:bc:99:52:15:1a 10.93.177.21 iPhone 01:3e:bc:99:52:15:1a
dhcp_leases_raw=$(cat /home/pi/.router/run/dhcp/dnsmasq.leases | grep -i "$device_mac")
dhcp_leases=$(echo "$dhcp_leases_raw" | while IFS= read -r line; do
    if [ -z "$line" ]; then
        continue
    fi
    # Extract timestamp (first field) and rest of line
    timestamp=$(echo "$line" | awk '{print $1}')
    data=$(echo "$line" | cut -d' ' -f2-)

    # Convert timestamp from seconds to milliseconds
    ts_ms=$((timestamp * 1000))
    # Output: timestamp_ms<tab>original_line
    printf "%s\t%s\n" "$ts_ms" "[dhcp] $data"
done)

## Merge and sort by timestamp (ascending order, stable sort to preserve original order for same timestamps)
timeline=$(printf "%s\n%s\n" "$ap_events" "$ap_log" "$dhcp_leases" | sort -s -t$'\t' -k1 -n)

echo ""
echo "=== Device Timeline (sorted by timestamp) ==="

echo "$timeline" | while IFS=$'\t' read -r ts_ms data; do
    if [ -z "$ts_ms" ]; then
        continue
    fi
    # Convert milliseconds to seconds
    ts_sec=$((ts_ms / 1000))
    # Convert to readable date format with timezone
    date_str=$(date -d "@$ts_sec" "+%Y-%m-%d %H:%M:%S %Z" 2>/dev/null)
    if [ -n "$date_str" ]; then
        printf "%s\t%s\n" "$date_str" "$data"
    fi
done
