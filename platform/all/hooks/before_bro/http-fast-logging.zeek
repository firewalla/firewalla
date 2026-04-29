##! This script makes http log generated right after http headers are parsed

@load base/protocols/conn

module HTTP;

redef record Info += {
    orig_l2_addr: string &log &optional;
    resp_l2_addr: string &log &optional;
};

event http_begin_entity(c: connection, is_orig: bool) &priority = -5
{
  if ( c$orig?$l2_addr )
    c$http$orig_l2_addr = c$orig$l2_addr;

  if ( c$resp?$l2_addr )
    c$http$resp_l2_addr = c$resp$l2_addr;

  if ( c$http?$status_code && ! code_in_range(c$http$status_code, 100, 199) )
    Log::write(HTTP::LOG, c$http);
}