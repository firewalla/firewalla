@load base/utils/time

module Heartbeat;

export {
    redef enum Log::ID += { LOG };

    type Message: record {
        ts: time        &log;
    };
}

event network_time_init()
    {
    Log::create_stream(LOG, [$columns=Heartbeat::Message, $path="heartbeat"]);

    event heartbeat()
    }

event heartbeat()
    {
    local msg: Heartbeat::Message = [$ts=network_time()];

    Log::write(Heartbeat::LOG, msg);

    schedule 10mins heartbeat()
    }