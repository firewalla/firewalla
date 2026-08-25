##! This script adds VLAN information to the connection log.

@load base/protocols/conn

module Conn;

redef record Info += {
        ## The outer VLAN for this connection, if applicable.
        vlan: int      &log &optional;

        ## The inner VLAN for this connection, if applicable.
        inner_vlan: int      &log &optional;
};

event new_connection(c: connection) &priority=-5
        {
        Conn::set_conn(c, F);
        if ( c?$vlan )
                c$conn$vlan = c$vlan;

        if ( c?$inner_vlan )
                c$conn$inner_vlan = c$inner_vlan;
        }