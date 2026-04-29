hook SSL::ssl_finishing(c: connection) &priority=-200
{
	if (c$ssl?$cert_chain)
		delete c$ssl$cert_chain;
	if (c$ssl?$client_cert_chain)
		delete c$ssl$client_cert_chain;
}
