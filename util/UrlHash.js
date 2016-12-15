'use strict'
var getCanonicalizedURI = require('./getCanonicalizedURL');
var getLookupExpressions = require('./getLookupExpressions');
var Hashes = require('./Hashes.js');

/* take url and Canonicalize it, then has the parts ... */

function canonicalizeAndHash(url) {
    console.log("curl ",url);
  
    if (url == null) {
        return null;
    }
    let cURL = getCanonicalizedURI(url);
    if (cURL == null) {
        return null;
    }
    console.log("curl ",cURL);
    let eCURL = getLookupExpressions(cURL);
    if (eCURL == null) {
        return null;
    }
    if (eCURL.length==0) {
        return null;
    }
//    console.log("eurl0:",eCURL);

    eCURL = eCURL.filter(function(elem, pos) {
        return eCURL.indexOf(elem) == pos;
    })
    // console.log("eurl:",eCURL);
    
    let _hashes= [];
    for (let i in eCURL) {
        let h = Hashes.getHashObject(eCURL[i]);
        let hstr = [eCURL[i], h.prefix.toString('base64'),h.hash.toString('base64')];
        _hashes.push(hstr);
    }
    return _hashes;
}

function hashBase64(url) {
    let h = Hashes.getHashObject(url);
    return h.hash.toString('base64');
    
}

module.exports = {
    canonicalizeAndHashExpressions: canonicalizeAndHash,
    hashBase64: hashBase64
};
