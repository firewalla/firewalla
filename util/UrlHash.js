'use strict'
var getCanonicalizedURI = require('./getCanonicalizedURL').getCanonicalizedURL;
var getLookupExpressions = require('./getLookupExpressions');
var Hashes = require('./Hashes.js');

/* take url and Canonicalize it, then has the parts ... */

function canonicalizeAndHash(url) {
    if (url == null) {
        return null;
    }
    let cURL = getCanonicalizedURI(url);
    if (cURL == null) {
        return null;
    }
    let eCURL = getLookupExpressions(cURL);
    if (eCURL == null) {
        return null;
    }
    if (eCURL.length==0) {
        return null;
    }

    eCURL = eCURL.filter(function(elem, pos) {
        return eCURL.indexOf(elem) == pos;
    })
    
    let _hashes= [];
    for (let i in eCURL) {
        let h = Hashes.getHashObject(eCURL[i]);
        let hstr = [eCURL[i], h.prefix.toString('base64'),h.hash.toString('base64')];
        _hashes.push(hstr);
    }
    _hashes.sort((a,b)=>{
        return a[0].length-b[0].length;
    });
    return _hashes;
}

function hashBase64(url) {
    let h = Hashes.getHashObject(url);
    return h.hash.toString('base64');
    
}

function shortUrl(url,noslash) {
    if (url == null) {
        return null;
    }
    let cURL = getCanonicalizedURI(url);
    if (cURL == null) {
        return null;
    }
    let eCURL = getLookupExpressions(cURL);
    if (eCURL == null) {
        return null;
    }
    if (eCURL.length==0) {
        return null;
    }

    eCURL = eCURL.filter(function(elem, pos) {
        return eCURL.indexOf(elem) == pos;
    })

    eCURL.sort((a,b)=>{
        return a.length-b.length;
    });

    if (noslash == true) {
        return eCURL[0].replace("/","");
    } else {
        return eCURL[0];
    }
}

module.exports = {
    canonicalizeAndHashExpressions: canonicalizeAndHash,
    hashBase64: hashBase64,
    shortUrl: shortUrl
};
