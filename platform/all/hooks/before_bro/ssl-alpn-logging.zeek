# site/log-orig-alpn.zeek
@load base/protocols/ssl

redef record SSL::Info += {
        ## Application layer protocol negotiation extension sent by the client.
        orig_alpn: vector of string &log &optional;
};



event ssl_extension_application_layer_protocol_negotiation(c: connection, is_client: bool, names: string_vec)
        {
        if ( ! c?$ssl )
                return;

        if ( is_client )
                c$ssl$orig_alpn = names;
        }