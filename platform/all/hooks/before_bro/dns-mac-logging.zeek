##! This script adds link-layer address (MAC) information to the connection logs

@load base/protocols/conn

module DNS;

redef record Info += {
  ## Link-layer address of the originator, if available.
  orig_l2_addr: string    &log &optional;
  ## Link-layer address of the responder, if available.
  resp_l2_addr: string    &log &optional;
};

event dns_end(c: connection, msg: dns_msg) &priority=10
{
  if ( c$orig?$l2_addr )
    c$dns$orig_l2_addr = c$orig$l2_addr;

  if ( c$resp?$l2_addr )
    c$dns$resp_l2_addr = c$resp$l2_addr;
}