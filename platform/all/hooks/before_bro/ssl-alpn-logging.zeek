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

event ssl_client_hello(c: connection, version: count, record_version: count, possible_ts: time, client_random: string, session_id: string, ciphers: index_vec, comp_methods: index_vec)
        {
        ## server hello might get lost when a domain was blocked, ssl log might not be generated until connection timeout.
        ## as a workaround we log a record once we get clientHello.
        Log::write(SSL::LOG, c$ssl);
        }