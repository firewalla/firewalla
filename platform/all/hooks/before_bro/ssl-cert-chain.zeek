##! For connections whose certificate validation failed, log the issuer and
##! validity window of each cert on the verification path, and indicate which
##! one(s) caused the failure.
##!
##! The path is built the way OpenSSL builds it, from the leaf through the
##! presented certs, trusted-first. It ends at the first cert whose issuer is in
##! the trust store; that root's fp and validity window are appended last, with
##! no issuer entry of its own since the last issuer already names it.
##! Presented certs off that path (e.g. a cross-signed copy of a store root, or
##! unrelated extras) are left out.
##! Zeek's x509_verify() does not expose OpenSSL's error depth, so the culprit
##! is inferred from validation_code and that path.
##! All index-based fields line up with cert_chain_fps, which is rewritten in path
##! order for failed connections (Zeek before 4.1 logs none, so it is added);
##! cert_chain_issuers is one shorter when the root is appended.
##!
##! Supersedes cert-chain-issuers.zeek; don't load both (same field name).

@load base/misc/version
@load protocols/ssl/validate-certs

module SSL;

export {
	redef record Info += {
		## Subject DN of each cert on the verification path, same order as
		## cert_chain_fps.
		cert_chain_subjects: vector of string &log &optional;
		## Issuer DN of each cert on the verification path, same order as
		## cert_chain_fps, without an entry for an appended store root.
		cert_chain_issuers: vector of string &log &optional;
		## notBefore of each cert on the verification path as whole epoch
		## seconds, same order as cert_chain_fps.
		cert_chain_not_valid_before: vector of int &log &optional;
		## notAfter of each cert on the verification path as whole epoch
		## seconds, same order as cert_chain_fps.
		cert_chain_not_valid_after: vector of int &log &optional;
		## Indexes into cert_chain_fps of the cert(s) that caused the failure.
		## Unset when the culprit can't be determined from the path.
		validation_failed_certs: vector of count &log &optional;
		## Issuer DN of each cert in validation_failed_certs, same order.
		validation_failed_issuers: vector of string &log &optional;
	};
}

@if ( Version::number < 40100 )
redef record Info += {
	## SHA-256 of each certificate (DER), as newer Zeek logs it.
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
# X509_V_ERR_INVALID_CA is 24 in OpenSSL 1.1 but 79 in 3.0, where 24 is another
# error, so it is matched by its message.
const INVALID_CA_STATUS = "invalid CA certificate";

type CertMeta: record {
	fp: string;
	not_before: int;
	not_after: int;
};

# Trust-store roots by the subject parsed from their DER. SSL::root_certs keys
# can't be matched against a parsed issuer: they lack the RFC 2253 escaping of
# commas inside values (e.g. "O=GoDaddy.com\, Inc.").
global trust_roots: table[string] of CertMeta;

# Cert time as whole epoch seconds. Zeek before 8.0 converts the ASN.1 UTC time
# with mktime(), i.e. as local time, so the local UTC offset at t is added back.
function cert_epoch(t: time): int
	{
	# double_to_int is missing before zeek 4.0; unary + makes the count an int
	local secs = +double_to_count(floor(time_to_double(t)));
@if ( Version::number < 80000 )
	local z = strftime("%z", t);  # e.g. "+0800"
	local off = +(to_count(z[1:3]) * 3600 + to_count(z[3:5]) * 60);
	secs += z[0] == "-" ? -off : off;
@endif
	return secs;
	}

function cert_meta(cert: X509::Certificate, der: string): CertMeta
	{
	return CertMeta($fp=sha256_hash(der),
		$not_before=cert_epoch(cert$not_valid_before),
		$not_after=cert_epoch(cert$not_valid_after));
	}

event zeek_init()
	{
	for ( dn in SSL::root_certs )
		{
		local der = SSL::root_certs[dn];
		local rc = x509_parse(x509_from_der(der));
		trust_roots[rc$subject] = cert_meta(rc, der);
		}
	}

# OpenSSL's test for a cert above the leaf that isn't a store root: basicConstraints
# CA:TRUE, and keyUsage, if present, allows certificate signing.
function invalid_ca(x: X509::Info): bool
	{
	if ( ! x?$basic_constraints || ! x$basic_constraints$ca )
		return T;
	for ( e in x$extensions )
		{
		if ( x$extensions[e]$oid == "2.5.29.15" && ! ( "Certificate Sign" in x$extensions[e]$value ) )
			return T;
		}
	return F;
	}

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

		# OpenSSL >= 1.1.0 is trusted-first: a store issuer ends the path, so a
		# presented cross-signed copy of that root is never used.
		if ( cert$issuer in trust_roots )
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
	local path = chain_path(chain);
	local top = |path| - 1;  # position in path, as are all indexes below

	local subjects: vector of string = vector();
	local issuers: vector of string = vector();
	local not_before: vector of int = vector();
	local not_after: vector of int = vector();
	local fps: vector of string = vector();
	local metas: vector of CertMeta = vector();
	for ( i in path )
		{
		local x = chain[path[i]]$x509;
		subjects[|subjects|] = x$certificate$subject;
		issuers[|issuers|] = x$certificate$issuer;
		metas[|metas|] = cert_meta(x$certificate, x509_get_certificate_string(x$handle));
		}

	# Servers rarely send the root, so append it from the trust store by the top cert's issuer.
	local top_cert = chain[path[top]]$x509$certificate;
	if ( top_cert$issuer != top_cert$subject && top_cert$issuer in trust_roots )
		{
		subjects[|subjects|] = top_cert$issuer;
		metas[|metas|] = trust_roots[top_cert$issuer];
		}

	for ( m in metas )
		{
		fps[|fps|] = metas[m]$fp;
		not_before[|not_before|] = metas[m]$not_before;
		not_after[|not_after|] = metas[m]$not_after;
		}

	c$ssl$cert_chain_subjects = subjects;
	c$ssl$cert_chain_issuers = issuers;
	c$ssl$cert_chain_not_valid_before = not_before;
	c$ssl$cert_chain_not_valid_after = not_after;
	c$ssl$cert_chain_fps = fps;

	local code = c$ssl$validation_code;
	local failed: vector of count = vector();
	local now = +double_to_count(floor(time_to_double(network_time())));  # x509_verify's default verify time

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
		# metas, not path: the appended store root is checked too
		for ( m in metas )
			{
			if ( ( code == ERR_CERT_HAS_EXPIRED && metas[m]$not_after < now ) ||
			     ( code == ERR_CERT_NOT_YET_VALID && metas[m]$not_before > now ) )
				failed[|failed|] = m;
			}
		}

	# OpenSSL reports the first cert from the leaf up that can't act as a CA;
	# a self-signed root is held to a looser rule and left unchecked
	else if ( c$ssl$validation_status == INVALID_CA_STATUS )
		{
		for ( p in path )
			{
			local ca = chain[path[p]]$x509;
			if ( p > 0 && ca$certificate$issuer != ca$certificate$subject && invalid_ca(ca) )
				{
				failed[0] = p;
				break;
				}
			}
		}

	if ( |failed| == 0 )
		return;

	local failed_issuers: vector of string = vector();
	# the appended store root has no issuer entry; it is self-signed, named by the top cert's issuer
	for ( f in failed )
		failed_issuers[|failed_issuers|] = failed[f] < |issuers| ? issuers[failed[f]] : top_cert$issuer;

	c$ssl$validation_failed_certs = failed;
	c$ssl$validation_failed_issuers = failed_issuers;
	}
