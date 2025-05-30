##! Local site policy. Customize as appropriate. 
##!
##! This file will not be overwritten when upgrading or reinstalling!

redef ignore_checksums = T;
redef SSL::disable_analyzer_after_detection = T;

#@load site/sqlite.bro

# This script logs which scripts were loaded during each run.
@load misc/loaded-scripts

# Apply the default tuning scripts for common tuning settings.
@load tuning/defaults
@load tuning/json-logs

# Load the scan detection script.
@load misc/scan

# Log some information about web applications being used by users 
# on your network.
#@load misc/app-stats

# Detect traceroute being run on the network.  
@load misc/detect-traceroute

# Generate notices when vulnerable versions of software are discovered.
# The default is to only monitor software found in the address space defined
# as "local".  Refer to the software framework's documentation for more 
# information.
@load frameworks/software/vulnerable

# Detect software changing (e.g. attacker installing hacked SSHD).
@load frameworks/software/version-changes
@load frameworks/software/windows-version-detection

# This adds signatures to detect cleartext forward and reverse windows shells.
@load-sigs frameworks/signatures/detect-windows-shells

# Load all of the scripts that detect software in various protocols.
@load protocols/ftp/software
@load protocols/smtp/software
@load protocols/ssh/software
@load protocols/http/software
# The detect-webapps script could possibly cause performance trouble when 
# running on live traffic.  Enable it cautiously.
#@load protocols/http/detect-webapps

# This script detects DNS results pointing toward your Site::local_nets 
# where the name is not part of your local DNS zone and is being hosted 
# externally.  Requires that the Site::local_zones variable is defined.
@load protocols/dns/detect-external-names

# Script to detect various activity in FTP sessions.
@load protocols/ftp/detect

# Scripts that do asset tracking.
#@load protocols/conn/known-hosts
@load protocols/conn/known-services
@load protocols/ssl/known-certs

# This script enables SSL/TLS certificate validation.
@load protocols/ssl/validate-certs

# This script prevents the logging of SSL CA certificates in x509.log
@load protocols/ssl/log-hostcerts-only

# Uncomment the following line to check each SSL certificate hash against the ICSI
# certificate notary service; see http://notary.icsi.berkeley.edu .
# @load protocols/ssl/notary

# If you have libGeoIP support built in, do some geographic detections and 
# logging for SSH traffic.
@load protocols/ssh/geo-data
# Detect hosts doing SSH bruteforce attacks.
@load protocols/ssh/detect-bruteforcing
# Detect logins using "interesting" hostnames.
@load protocols/ssh/interesting-hostnames

# Detect SQL injection attacks.
@load protocols/http/detect-sqli

#### Network File Handling ####

# Enable MD5 and SHA1 hashing for all files.
@load frameworks/files/hash-all-files

# Detect SHA1 sums in Team Cymru's Malware Hash Registry.
@load frameworks/files/detect-MHR

# Uncomment the following line to enable detection of the heartbleed attack. Enabling
# this might impact performance a bit.
@load policy/protocols/ssl/heartbleed

# enable link-layer address information to connection logs
@load policy/protocols/conn/mac-logging

redef restrict_filters += [["not-mdns"] = "not port 5353"];
# randomly drop ssl packets without SYN/FIN/RST based on the first bit of the most significant byte of TCP checksum(tcp header offset +16), this can reduce 50% traffic, also check first byte of tcp payload to inspect ssl handshake
redef restrict_filters += [["random-pick-ssl"] = "not (ip and tcp and port 443 and tcp[13] & 0x7 == 0 and (len >= 1000 || tcp[13] == 0x10) and (tcp[((tcp[12] & 0xf0) >> 4) * 4] != 0x16) and tcp[16] & 0x8 != 0)"];
redef restrict_filters += [["random-pick-ssl-ipv6"] = "not (ip6 and tcp and port 443 and ip6[40 + 13] & 0x7 == 0 && (len >= 1000 || ip6[40 + 13] == 0x10) and (ip6[40 + ((ip6[40 + 12] & 0xf0) >> 4) * 4] != 0x16) and ip6[40 + 16] & 0x8 != 0)"];

#redef Communication::listen_interface = 127.0.0.1;

@load base/protocols/dhcp

@load /home/pi/.firewalla/run/zeek/scripts/bro-long-connection
@load /home/pi/.firewalla/run/zeek/scripts/bro-heartbeat
@load /home/pi/.firewalla/run/zeek/scripts/heartbeat-flow
@load /home/pi/.firewalla/run/zeek/scripts/zeek-conn-log-filter
@load /home/pi/.firewalla/run/zeek/scripts/well-known-server-ports
@load /home/pi/.firewalla/run/zeek/scripts/dns-mac-logging.zeek
@load /home/pi/.firewalla/run/zeek/scripts/http-fast-logging.zeek

# make udp inactivity timeout consistent with net.netfilter.nf_conntrack_udp_timeout_stream
redef udp_inactivity_timeout = 3 min;

redef dpd_buffer_size = 65536;

# this variable is introduced in zeek 6.0 and default value is T, indicating whether Zeek should automatically consider private address ranges "local".
redef Site::private_address_space_is_local = F;
