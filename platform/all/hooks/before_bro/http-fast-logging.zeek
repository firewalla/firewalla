##! This script makes http log generated right after http headers are parsed

@load base/protocols/conn

module HTTP;

event http_begin_entity(c: connection, is_orig: bool) &priority = -5
{
  if ( c$http?$status_code && ! code_in_range(c$http$status_code, 100, 199) )
    Log::write(HTTP::LOG, c$http);
}