const google_play_store_ports = { 5228/tcp };
const dns_over_tls_ports = { 853/tcp };

redef likely_server_ports += { google_play_store_ports, dns_over_tls_ports };