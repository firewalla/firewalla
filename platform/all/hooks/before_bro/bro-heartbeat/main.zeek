@load base/utils/time

module Heartbeat;

export {
    redef enum Log::ID += { LOG };

    type Message: record {
        ts: time        &log;
    };
}

# network_time_init is only available after zeek 4.0
event log_heartbeat()
    {
    local msg: Heartbeat::Message = [$ts=network_time()];

    Log::write(Heartbeat::LOG, msg);

    schedule 1 min { log_heartbeat() };
    }

event zeek_init()
    {
    Log::create_stream(LOG, [$columns=Heartbeat::Message, $path="heartbeat"]);
    event log_heartbeat();
    }
