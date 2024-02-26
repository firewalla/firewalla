@load base/protocols/conn

# This is probably not so great to reach into the Conn namespace..
module Conn;

hook Conn::log_policy(rec: Conn::Info, id: Log::ID, filter: Log::Filter)
{
  # no need to log dns traffic in conn.log. DNS payload will be captured in dns.log
  if (rec$service == "dns")
    break;
}