@load base/utils/time

module Heartbeat;

export {
    redef enum Log::ID += { LOG };

    type Message: record {
        ts: time        &log;
    };
}

event bro_init()
    {
    Log::create_stream(LOG, [$columns=Heartbeat::Message, $path="heartbeat"]);
    }

event network_time_init()
    {
    local msg: Heartbeat::Message = [$ts=network_time()];

    Log::write(Heartbeat::LOG, msg);

    schedule 1 min { network_time_init() };
    }
