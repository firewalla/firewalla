@load base/frameworks/cluster
@load base/protocols/conn

module Conn;

redef record Info += {
        ## Name of the cluster node (worker) that logged this connection.
        node: string &log &optional;
};

event new_connection(c: connection) &priority=-5
        {
        Conn::set_conn(c, F);
        if ( Cluster::is_enabled() )
                c$conn$node = Cluster::node;
        }