```
root@nanopineo:/var/log# dmesg |grep eth0
[   16.222031] dwmac-sun8i 1c30000.ethernet eth0: device MAC address 86:a9:69:12:98:fd
[   16.227199] dwmac-sun8i 1c30000.ethernet eth0: No MAC Management Counters available
[   16.227218] dwmac-sun8i 1c30000.ethernet eth0: PTP not supported by HW
[   16.227564] IPv6: ADDRCONF(NETDEV_UP): eth0: link is not ready
[   19.369003] dwmac-sun8i 1c30000.ethernet eth0: Link is Up - 100Mbps/Full - flow control rx/tx
[   19.369056] IPv6: ADDRCONF(NETDEV_CHANGE): eth0: link becomes ready
root@nanopineo:/var/log# dmesg |grepmmc
grepmmc: command not found
root@nanopineo:/var/log# dmesg |grep mmc
[    0.000000] Kernel command line: root=UUID=7609f045-7116-4f72-a13e-99b20cda5240 rootwait rootfstype=ext4 console=tty1 console=ttyS0,115200 hdmi.audio=EDID:0 disp.screen0_output_mode=1920x1080p60 panic=10 consoleblank=0 loglevel=1 ubootpart=bcf97591-01 ubootsource=mmc usb-storage.quirks=   sunxi_ve_mem_reserve=0 sunxi_g2d_mem_reserve=0 sunxi_fb_mem_reserve=16 cgroup_enable=memory swapaccount=1
[    4.641294] sunxi-mmc 1c0f000.mmc: Got CD GPIO
[    4.703753] sunxi-mmc 1c0f000.mmc: base:0xe0bb5000 irq:23
[    4.786438] mmc0: host does not support reading read-only switch, assuming write-enable
[    4.789322] mmc0: new high speed SDHC card at address aaaa
[    4.790127] mmcblk0: mmc0:aaaa SC16G 14.8 GiB 
[    4.792559]  mmcblk0: p1
[    6.115325] EXT4-fs (mmcblk0p1): mounted filesystem with writeback data mode. Opts: (null)
[    8.068725] EXT4-fs (mmcblk0p1): re-mounted. Opts: commit=600,errors=remount-ro
[   12.233244] EXT4-fs (mmcblk0p1): resizing filesystem from 362496 to 3849616 blocks
[   12.308251] EXT4-fs (mmcblk0p1): resized filesystem to 3849616
root@nanopineo:/var/log# 
```
