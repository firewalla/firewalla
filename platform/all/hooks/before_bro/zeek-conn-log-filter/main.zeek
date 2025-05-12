@load base/protocols/conn

# This is probably not so great to reach into the Conn namespace..
module Conn;

hook Conn::log_policy(rec: Conn::Info, id: Log::ID, filter: Log::Filter)
{
  # no need to log dns traffic in conn.log. DNS payload will be captured in dns.log
  if (rec?$service && rec$service == "dns")
    break;
  # no need to log ssl traffic with 0 resp bytes.
  # It usually happens when connection is blocked by TLS kernel module. These logs will be discarded in firemain as well, so simply suppress them in zeek to reduce CPU overhead of firemain
  if (rec?$service && rec$service == "ssl" && rec?$resp_bytes && rec$resp_bytes == 0)
    break;

  # no need to log tcp connections that are directly reset
  if (rec?$proto && rec$proto == tcp && rec?$history && rec$history == "R")
    break;
  if (rec?$proto && rec$proto == tcp && rec?$conn_state && rec$conn_state == "REJ")
    break;
}