@load base/protocols/conn
@load base/utils/time


# This is probably not so great to reach into the Conn namespace..
module Conn;

export {
function set_conn_log_data_hack(c: connection)
    {
    Conn::set_conn(c, T);
    }
}

# Now onto the actual code for this script...

module LongConnection;

export {
    redef enum Log::ID += { LOG };

    # redef enum Notice::Type += {
    #     ## Notice for when a long connection is found.
    #     ## The `sub` field in the notice represents the number
    #     ## of seconds the connection has currently been alive.
    #     LongConnection::found
    # };

    # ## Aliasing vector of interval values as
    # ## "Durations"
    # type Durations: vector of interval;

    # ## The default duration that you are locally
    # ## considering a connection to be "long".
    # const default_durations = Durations(10min, 30min, 1hr, 12hr, 24hrs, 3days) &redef;

    # ## These are special cases for particular hosts or subnets
    # ## that you may want to watch for longer or shorter
    # ## durations than the default.
    # const special_cases: table[subnet] of Durations = {} &redef;
}

redef record connection += {
    ## Offset of the currently watched connection duration by the long-connections script.
    long_conn_offset: count &default=0;
};

event zeek_init() &priority=5
    {
    Log::create_stream(LOG, [$columns=Conn::Info, $path="conn_long"]);
    }

# function get_durations(c: connection): Durations
#     {
#     local check_it: Durations;
#     if ( c$id$orig_h in special_cases )
#         check_it = special_cases[c$id$orig_h];
#     else if ( c$id$resp_h in special_cases )
#         check_it = special_cases[c$id$resp_h];
#     else
#         check_it = default_durations;

#     return check_it;
#     }

function long_callback(c: connection, cnt: count): interval
    {
    # local check_it = get_durations(c);

    
    Conn::set_conn_log_data_hack(c);
    if ( c$orig?$l2_addr )
      c$conn$orig_l2_addr = c$orig$l2_addr;
    if ( c$resp?$l2_addr )
      c$conn$resp_l2_addr = c$resp$l2_addr;
    Log::write(LongConnection::LOG, c$conn);

    # local message = fmt("%s -> %s:%s remained alive for longer than %s",
    #                     c$id$orig_h, c$id$resp_h, c$id$resp_p, duration_to_mins_secs(c$duration));
    # NOTICE([$note=LongConnection::found,
    #         $msg=message,
    #         $sub=fmt("%.2f", c$duration),
    #         $conn=c]);

    # ++c$long_conn_offset;

    # # Keep watching if there are potentially more thresholds.
    # if ( c$long_conn_offset < |check_it| )
    #     return check_it[c$long_conn_offset];
    # else
    #     return -1sec;
    return 1min;
    }

event new_connection(c: connection)
{
    ConnPolling::watch(c, long_callback, 1, 5min);
    # local check = get_durations(c);
    # if ( |check| > 0 )
    #     {
    #     }
}
