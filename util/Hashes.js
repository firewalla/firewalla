var crypto = require('crypto');

var PREFIX_BYTE_LENGTH = 4;

function getHashObject(expr) {
  var sha = crypto.createHash('sha256');
  sha.update(expr);
  var digest = sha.digest();

  return {
    hash: digest,
    prefix: getNormalizedPrefix(digest)
  };
}

function getNormalizedPrefix(hash) {
  return hash.slice(0, PREFIX_BYTE_LENGTH);
}

var Hashes = {
  getHashObject: getHashObject,
  getNormalizedPrefix: getNormalizedPrefix
};

module.exports = Hashes;