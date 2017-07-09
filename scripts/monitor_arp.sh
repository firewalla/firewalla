#!/bin/bash
basedir=$(dirname $0)
basedir=$(cd $basedir;pwd)

echo "usage:"
echo "monitor_arp.sh gateway_ip router_mac walla_mac"
echo "mac address can be partial"
gateway_ip=$1
router_mac=$2
walla_mac=$3
if [ -z "$gateway_ip" ] || [ -z "$router_mac" ] || [ -z "$walla_mac" ]; then
	echo "invalid arguments."
	exit 1
fi
log_file=$basedir/log.$$
on=0
off=0
interupt=0
begin=$(date +%s)
spoof_on="unknown"
ARP_CMD="arp -an"
if uname -a | grep Microsoft &>/dev/null;  then
	ARP_CMD="/mnt/c/Windows/System32/ARP.EXE -a"
fi
while [ true ]; do
	sleep 1
	if $ARP_CMD 2>/dev/null | grep "$gateway_ip" | grep -i "$router_mac" &>/dev/null; then
		if [[ "$spoof_on" == "yes" ]]; then
			let interupt=$interupt+1
		fi
		spoof_on="no";
		let off=$off+1
	fi

	if $ARP_CMD 2>/dev/null  | grep "$gateway_ip" | grep -i "$walla_mac" &>/dev/null; then
		spoof_on="yes"
		let on=$on+1
	fi

	rate=$(echo "scale=2;$on*100/($on+$off)" | bc -l)
	end=$(date +%s)
	interupt_freq_minute=$(echo "scale=2;$interupt*60/($end-$begin)" | bc -l)
	interupt_freq_hour=$(echo "scale=2;$interupt*3600/($end-$begin)" | bc -l)
	date=$(date +"%F %T")
	echo $date spoof_on $spoof_on spoof_ratio_percentage: $rate interupt frequency: $interupt_freq_minute times/minute $interupt_freq_hour times/hour| tee -a $log_file
done
