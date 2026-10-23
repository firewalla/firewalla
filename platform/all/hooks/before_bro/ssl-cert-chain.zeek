##! For connections whose certificate validation failed, log the issuer and
##! validity window of every server-sent certificate and indicate which one(s)
##! caused the failure.
##!
##! Zeek's x509_verify() does not expose OpenSSL's error depth, so the culprit
##! is inferred from validation_code and the presented chain.
##! All index-based fields line up with cert_chain_fps. Zeek before 4.0 logs
##! no cert_chain_fps, so for those it is logged here too, for failed connections.
##!
##! Supersedes cert-chain-issuers.zeek; don't load both (same field name).

@load base/misc/version
@load protocols/ssl/validate-certs

module SSL;

export {
	redef record Info += {
		## Issuer DN of each server-sent certificate, same order as cert_chain_fps.
		cert_chain_issuers: vector of string &log &optional;
		## notBefore of each server-sent certificate as whole epoch seconds,
		## same order as cert_chain_fps.
		cert_chain_not_valid_before: vector of int &log &optional;
		## notAfter of each server-sent certificate as whole epoch seconds,
		## same order as cert_chain_fps.
		cert_chain_not_valid_after: vector of int &log &optional;
		## Indexes into cert_chain_fps of the cert(s) that caused the failure.
		## Unset when the culprit can't be determined from the presented chain.
		validation_failed_certs: vector of count &log &optional;
		## Issuer DN of each cert in validation_failed_certs, same order.
		validation_failed_issuers: vector of string &log &optional;
	};
}

@if ( Version::number < 40000 )
redef record Info += {
	## SHA-256 of each server-sent certificate (DER), as newer Zeek logs it.
	cert_chain_fps: vector of string &log &optional;
};
@endif

# OpenSSL X509_V_ERR_* codes (x509_vfy.h).
const ERR_UNABLE_TO_GET_ISSUER_CERT = 2;
const ERR_CERT_NOT_YET_VALID = 9;
const ERR_CERT_HAS_EXPIRED = 10;
const ERR_DEPTH_ZERO_SELF_SIGNED_CERT = 18;
const ERR_SELF_SIGNED_CERT_IN_CHAIN = 19;
const ERR_UNABLE_TO_GET_ISSUER_CERT_LOCALLY = 20;
const ERR_UNABLE_TO_VERIFY_LEAF_SIGNATURE = 21;

# Indexes of the issuer -> subject path from the leaf through the presented
# certs, leaf first. Mirrors how OpenSSL builds the path, so misordered chains
# and extra unrelated certs are handled.
function chain_path(chain: vector of Files::Info): vector of count
	{
	local path: vector of count = vector(0);
	local cur = 0;
	local found = F;
	local parent_i = 0;

	while ( |path| < |chain| )
		{
		local cert = chain[cur]$x509$certificate;
		if ( cert$issuer == cert$subject )
			break;

		found = F;
		for ( i in chain )
			{
			if ( i != cur && chain[i]?$x509 &&
			     chain[i]$x509$certificate$subject == cert$issuer )
				{
				found = T;
				parent_i = i;
				break;
				}
			}

		if ( ! found )
			break;

		cur = parent_i;
		path[|path|] = cur;
		}

	return path;
	}

# validate-certs sets validation_status/code at priority 20; run after it.
hook ssl_finishing(c: connection) &priority=10
	{
	if ( ! c$ssl?$validation_code || c$ssl$validation_status == "ok" )
		return;

	if ( ! c$ssl?$cert_chain || |c$ssl$cert_chain| == 0 ||
	     ! c$ssl$cert_chain[0]?$x509 )
		return;

	local chain = c$ssl$cert_chain;

	# Issuer and validity window of every presented cert. Placeholders (empty
	# string, epoch 0) keep indexes aligned with cert_chain_fps if a cert
	# failed to parse.
	local issuers: vector of string = vector();
	local not_before: vector of int = vector();
	local not_after: vector of int = vector();
@if ( Version::number < 40000 )
	local fps: vector of string = vector();
@endif
	for ( i in chain )
		{
		if ( chain[i]?$x509 )
			{
			local ci = chain[i]$x509$certificate;
			issuers[|issuers|] = ci$issuer;
			# double_to_int is missing before zeek 4.0; unary + makes the count an int
			not_before[|not_before|] = +double_to_count(floor(time_to_double(ci$not_valid_before)));
			not_after[|not_after|] = +double_to_count(floor(time_to_double(ci$not_valid_after)));
@if ( Version::number < 40000 )
			fps[|fps|] = sha256_hash(x509_get_certificate_string(chain[i]$x509$handle));
@endif
			}
		else
			{
			issuers[|issuers|] = "";
			not_before[|not_before|] = +0;  # +0 is an int literal; plain 0 is a count
			not_after[|not_after|] = +0;
@if ( Version::number < 40000 )
			fps[|fps|] = "";
@endif
			}
		}
	c$ssl$cert_chain_issuers = issuers;
	c$ssl$cert_chain_not_valid_before = not_before;
	c$ssl$cert_chain_not_valid_after = not_after;
@if ( Version::number < 40000 )
	c$ssl$cert_chain_fps = fps;
@endif

	local code = c$ssl$validation_code;
	local path = chain_path(chain);
	local top = path[|path| - 1];
	local failed: vector of count = vector();
	local now = network_time();  # x509_verify's default verify time

	if ( code == ERR_DEPTH_ZERO_SELF_SIGNED_CERT ||
	     code == ERR_UNABLE_TO_VERIFY_LEAF_SIGNATURE )
		failed[0] = 0;

	# Code 2 (UNABLE_TO_GET_ISSUER_CERT) means OpenSSL's path ended on a cert
	# from the trust store, not a presented one, so it is left unset.
	else if ( code == ERR_UNABLE_TO_GET_ISSUER_CERT_LOCALLY ||
	          code == ERR_SELF_SIGNED_CERT_IN_CHAIN )
		failed[0] = top;

	else if ( code == ERR_CERT_HAS_EXPIRED || code == ERR_CERT_NOT_YET_VALID )
		{
		for ( p in path )
			{
			local pc = chain[path[p]]$x509$certificate;
			if ( ( code == ERR_CERT_HAS_EXPIRED && pc$not_valid_after < now ) ||
			     ( code == ERR_CERT_NOT_YET_VALID && pc$not_valid_before > now ) )
				failed[|failed|] = path[p];
			}
		}

	if ( |failed| == 0 )
		return;

	local failed_issuers: vector of string = vector();
	for ( f in failed )
		failed_issuers[|failed_issuers|] = issuers[failed[f]];

	c$ssl$validation_failed_certs = failed;
	c$ssl$validation_failed_issuers = failed_issuers;
	}
