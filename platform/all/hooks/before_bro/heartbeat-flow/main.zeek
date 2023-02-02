@load base/protocols/conn
@load base/utils/time

module HeartbeatFlow;

event log_heartbeat_flow()
    {
    local id: conn_id = [
        $orig_h=0.0.0.0,
        $orig_p=0/unknown,
        $resp_h=0.0.0.0,
        $resp_p=0/unknown
        ];
    local msg: Conn::Info = [
        $ts=network_time(), $uid="0", $id=id, $proto=unknown_transport
    ];

    Log::write(Conn::LOG, msg);

    schedule 30 min { log_heartbeat_flow() };
    }

event network_time_init()
    {
    event log_heartbeat_flow();
    }
