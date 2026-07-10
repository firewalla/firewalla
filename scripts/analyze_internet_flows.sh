#!/bin/bash

# subscribe_flows.sh
# Usage:
#   ./analyze_internet_flows.sh -m "6C:1F:F7:23:39:CB,00:1A:7D:DA:71:13" -d "20250827,20250828" -a "youtube,internet"

# rc zrange "internet_flows:6C:1F:F7:23:39:CB:20250827" 0 -1
# 1) "{\"begin\":1756264955.22,\"dur\":90.44,\"intf\":\"6dc1c3fa-6238-40fe-b2ee-718dc25733fb\",\"sourceMac\":\"6C:1F:F7:23:39:CB\",\"destination\":\"duzhanread.cdn.bcebos.com\",\"sourceIp\":\"192.168.216.136\",\"destinationIp\":\"61.170.99.35\",\"sourcePort\":[52270],\"destinationPort\":443,\"protocol\":\"tcp\",\"category\":\"\",\"upload\":4066,\"download\":380083}"


mac_list=""
date_list=""

# ====================== parse arguments ======================
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--mac-list)
      mac_list="$2"
      shift 2
      ;;
    -d|--date-list)
      date_list="$2"
      shift 2
      ;;
    -a|--app-list)
      app_list="$2"
      shift 2
      ;;
    *)
      echo "Usage: $0 -m <mac1,mac2,...> -d <date1,date2,...>" >&2
      exit 1
      ;;
  esac
done

declare -A all_flows

retrieve_internet_flows_from_redis() {
  # Key format: "internet_flows:youtube:6C:1F:F7:23:39:CB:20250827"
  # Key format: "internet_flows:internet:6C:1F:F7:23:39:CB:20250827"

  local macArray=() dateArray=() appArray=() key_list=()
  
  [ -n "$mac_list" ] && IFS=',' read -ra macArray <<< "$mac_list"
  [ -n "$date_list" ] && IFS=',' read -ra dateArray <<< "$date_list"
  [ -n "$app_list" ] && IFS=',' read -ra appArray <<< "$app_list"
  
  if [ ${#macArray[@]} -eq 0 ] && [ ${#dateArray[@]} -eq 0 ] && [ ${#appArray[@]} -eq 0 ]; then
    key_list=($(redis-cli --scan --pattern "internet_flows:*" | sort -u))
  else
    local macs=("${macArray[@]}") dates=("${dateArray[@]}") apps=("${appArray[@]}")
    [ ${#macArray[@]} -eq 0 ] && macs=("*")
    [ ${#dateArray[@]} -eq 0 ] && dates=("*")
    [ ${#appArray[@]} -eq 0 ] && apps=("*")
    
    for app in "${apps[@]}"; do
      for mac in "${macs[@]}"; do
        for date in "${dates[@]}"; do
          local pattern="internet_flows:${app}:${mac}:${date}"
          local matched_keys=($(redis-cli --scan --pattern "$pattern"))
          key_list+=("${matched_keys[@]}")
        done
      done
    done
    
    key_list=($(printf "%s\n" "${key_list[@]}" | sort -u))
  fi

  for key in "${key_list[@]}"; do
    local data=$(redis-cli zrange "$key" 0 -1 2>/dev/null)
    if [ -n "$data" ]; then
      all_flows["$key"]="$data"
    fi
  done
}

get_app_network_activity() {
  if [[ $# -ne 3 ]]; then
    echo "Usage: get_app_network_activity <app_name> <mac_address> <date_string>" >&2
    return 1
  fi

  local app=$1
  local mac=$2
  local date_str=$3
  local app_time_usage

  local begin_ts end_ts
  if ! begin_ts=$(date -d "$date_str" "+%s" 2>/dev/null); then
    echo "Error: Invalid start date format for '$date_str'" >&2
    return 1
  fi
  if ! end_ts=$(date -d "$date_str +1 day" "+%s" 2>/dev/null); then
    echo "Error: Invalid end date format for '$date_str +1 day'" >&2
    return 1
  fi
  
  local json_payload
  local json_payload="{
    \"item\": \"appTimeUsage\",
    \"begin\": $begin_ts,
    \"end\": $end_ts,
    \"granularity\": \"day\",
    \"type\": \"host\",
    \"apps\": [\"$app\"]
  }"

  local api_url="http://localhost:8834/v1/encipher/complex?command=get&target=$mac"

  local response=$(curl -s -X POST \
    --header 'Content-Type: application/json' \
    --header 'Accept: application/json' \
    -d "$json_payload" \
    "$api_url")
  
  local curl_exit_code=$?
  
  if [[ $curl_exit_code -ne 0 ]]; then
    echo "Error: curl request failed with exit code $curl_exit_code" >&2
    return 1
  fi
  
  local intervals
  if [[ "$app" == "internet" ]]; then
    # extract internetTimeUsage.devices[mac].intervals
    intervals=$(echo "$response" | jq -r --arg mac "$mac" '
      .data.internetTimeUsage.devices[$mac].intervals? // empty
    ')
  else
    # extract appTimeUsage.app.devices[mac].intervals
    intervals=$(echo "$response" | jq -r --arg app "$app" --arg mac "$mac" '
      .data.appTimeUsage[$app].devices[$mac].intervals? // empty
    ')
  fi

  if [[ -n "$intervals" && "$intervals" != "null" ]]; then
    echo ""
    echo "Network Activity:"
    echo "----------------------------------------"
    echo "$intervals" | jq -c '.[]' | while read -r interval; do
      if [[ -n "$interval" ]]; then
        begin=$(echo "$interval" | jq -r '.begin')
        end=$(echo "$interval" | jq -r '.end')
            
        begin_time=$(date -d "@$begin" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "INVALID_TIME")
        end_time=$(date -d "@$end" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "INVALID_TIME")

        echo "  Interval: $begin_time to $end_time (Duration: $(( (end - begin) / 60 )) minutes)"
      fi
    done
    echo "----------------------------------------"
  else
    echo "No intervals found... (no network activity)"
  fi
  return 0
}

print_flows_statistics() {
  if ! declare -p all_flows &>/dev/null; then
    echo "Error: 'all_flows' associative array not found!" >&2
    return 1
  fi

  for key in "${!all_flows[@]}"; do
    echo ""
    echo "Flow List for $key:"
    echo ""
    echo -e "time\t\t\tduration\tmac\t\tdestination\t\tsourceIp\t\tdestinationIp\t\tsourcePort\tdestinationPort\tprotocol\tcategory\tupload\t\tdownload\t\ttotal\tapp"

    IFS=$'\n' read -d '' -ra flows <<< "${all_flows[$key]}"

    declare -A destination_count  
    declare -A destination_begins 

    destination_count=()
    destination_begins=()

    for flow in "${flows[@]}"; do
      if ! read -r begin dur mac destination sourceIp destinationIp sourcePort destinationPort protocol category upload download app<<< \
          $(echo "$flow" | jq -r '[.begin, .dur, .mac, .destination, .sourceIp, .destinationIp, .sourcePort, .destinationPort, .protocol, .category, .upload, .download, .app] | 
      map(if type == "string" and (. == "" or test(" ")) then @sh else tostring end) | 
      join(" ")'); then
          echo "Error: Failed to parse JSON flow: $flow" >&2
          continue
      fi

      upload_kb=$(echo "scale=2; $upload / 1024" | bc)
      download_kb=$(echo "scale=2; $download / 1024" | bc)
      total_kb=$(echo "scale=2; ($upload + $download) / 1024" | bc)

      time=$(date -d "@$begin" "+%Y-%m-%d %H:%M:%S" 2>/dev/null)
      if [ $? -ne 0 ]; then
          time="INVALID_TIME"
      fi

      printf "%s\t%.2f\t%s\t%s\t%s\t%s\t%d\t%d\t%s\t%s\t%sKB\t%sKB\t%sKB\t%s\n" \
          "$time" "$dur" "$mac" "$destination" "$sourceIp" "$destinationIp" \
          "$sourcePort" "$destinationPort" "$protocol" "$category" \
          "$upload_kb" "$download_kb" "$total_kb" "$app"

      if [[ -n "$destination" && -n "$begin" ]]; then
          ((destination_count["$destination"]++))
          destination_begins["$destination"]+=" $begin"
      fi
    done

    echo ""
    echo "Destination Statistics:"
    echo -e "Destination\t\tCount\tOccurrence"

    for dest in "${!destination_count[@]}"; do
      echo "$dest ${destination_count[$dest]} "
    done | sort -nr | while read -r dest count; do
      # dest="'$dest'"
      begins=($(echo "${destination_begins[$dest]}" | tr ' ' '\n' | sort -n))
      all_time=""
      for begin in "${begins[@]}"; do
        begin_time=$(date -d "@$begin" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "INVALID_TIME")
        all_time+="$begin_time, "
      done
      all_time=${all_time%, }  
      printf "%s\t\t%d\t%s\n" "$dest" "$count" "$all_time"
    done

    app=$(echo "$key" | cut -d':' -f2)
    mac=$(echo "$key" | cut -d':' -f3-8)
    date=$(echo "$key" | cut -d':' -f9)

    get_app_network_activity $app $mac $date

  done
}

# ====================== main ======================

retrieve_internet_flows_from_redis

print_flows_statistics
