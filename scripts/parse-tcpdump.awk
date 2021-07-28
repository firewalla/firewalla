# extrace dBM
match($0, /-?[0-9]+dBm/, strength) {
	STRENGTH=strength[0]
}

# extract sender MAC address
match($0, /SA(:[a-f0-9]{2}){6}/, mac) {
	gsub(/SA:/, "", mac[0])
	MAC=mac[0]
}

# extract SSID with Probe Request"t (SSID)" regex
match($0, /Probe Request \(.*\)/, ssid) { 

	# substitute "t (" and trailing ")" in-place
	gsub(/(Probe Request \(|\))/, "", ssid[0])

	# if there is a non-empty SSID
	if (length(ssid[0]) != 0) { 

		# escape commas
		# gsub(/,/, "\\,", ssid[0])
		SSID=ssid[0]

		# extract TIMESTAMP
		gsub(/\.[0-9]+/, "", $1)
		TIMESTAMP=strftime("%F") " " $1 

		# print them to stdout
		print TIMESTAMP " " STRENGTH " " MAC " " SSID ""
		system("") # flush the buffer
	}
}
