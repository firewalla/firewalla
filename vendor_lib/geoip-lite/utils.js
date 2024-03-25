var utils = module.exports = {};

utils.aton4 = function(a) {
	a = a.split(/\./);
	return ((parseInt(a[0], 10)<<24)>>>0) + ((parseInt(a[1], 10)<<16)>>>0) + ((parseInt(a[2], 10)<<8)>>>0) + (parseInt(a[3], 10)>>>0);
};

utils.aton6 = function(a) {
	a = a.replace(/"/g, '').split(/:/);

	var l = a.length - 1;
	var i;

	if (a[l] === '') {
		a[l] = 0;
	}

	if (l < 7) {
    const omitted = 8 - a.length
    const omitStart = a.indexOf('')
    const omitEnd = omitStart + 8 - a.length

    for (let i = 7; i >= omitStart; i--) {
      if (i > omitEnd)
        a[i] = a[i - omitted]
      else
        a[i] = 0
    }
	}

	for (i = 0; i < 8; i++) {
		if (!a[i]) {
			a[i]=0;
		} else {
			a[i] = parseInt(a[i], 16);
		}
	}

	var r = [];
	for (i = 0; i<4; i++) {
		r.push(((a[2*i]<<16) + a[2*i+1])>>>0);
	}

	return r;
};


utils.cmp = function(a, b) {
	if (typeof a === 'number' && typeof b === 'number') {
		return (a < b ? -1 : (a > b ? 1 : 0));
	}

	if (a instanceof Array && b instanceof Array) {
		return this.cmp6(a, b);
	}

	return null;
};

utils.cmp6 = function(a, b) {
	for (var ii = 0; ii < 4; ii++) {
		if (a[ii] < b[ii]) {
			return -1;
		}

		if (a[ii] > b[ii]) {
			return 1;
		}
	}

	return 0;
};

utils.isPrivateIP = function(addr) {
	addr = addr.toString();

	return addr.match(/^10\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/) != null ||
    addr.match(/^192\.168\.([0-9]{1,3})\.([0-9]{1,3})/) != null ||
    addr.match(/^172\.16\.([0-9]{1,3})\.([0-9]{1,3})/) != null ||
    addr.match(/^127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/) != null ||
    addr.match(/^169\.254\.([0-9]{1,3})\.([0-9]{1,3})/) != null ||
    addr.match(/^fc00:/) != null || addr.match(/^fe80:/) != null;
};

utils.ntoa4 = function(n) {
	n = n.toString();
	n = '' + (n>>>24&0xff) + '.' + (n>>>16&0xff) + '.' + (n>>>8&0xff) + '.' + (n&0xff);

	return n;
};

utils.ntoa6 = function(n) {
	var a = "[";

	for (var i = 0; i<n.length; i++) {
		a += (n[i]>>>16).toString(16) + ':';
		a += (n[i]&0xffff).toString(16) + ':';
	}

	a = a.replace(/:$/, ']').replace(/:0+/g, ':').replace(/::+/, '::');

	return a;
};

utils.toBigInt = function(n) {
  if (Array.isArray(n)) {
    return n.reduce((p, c) => (p << 32n) + BigInt(c), 0n)
  }
  else {
    return BigInt(n)
  }
}

utils.ntoaBigInt = function(n, fam) {
  const sections = fam == 4 ? 4 : 8
  const sectionMask = fam == 4 ? 0xFFn : 0xFFFFn
  const sectionBits = fam == 4 ? 8n : 16n
  const parts = Array(sections)

  for (let i = 0; i < sections; i++) {
    if (n > 0n) {
      parts[i] = n & sectionMask
      n >>= sectionBits
    } else
      parts[i] = 0n
  }

  if (fam == 4) {
    return parts.reverse().join('.')
  } else {
    // no need to simplify zeros here
    return parts.reverse().map(n=>n.toString(16)).join(':')
  }
}

utils.numberToCIDRs = function(start, end, fam) {
  const resultArray = []
  const maxMaskLen = fam == 4 ? 32 : 128

  // use BigInt for readability, performance penalty is very little
  start = utils.toBigInt(start)
  end = utils.toBigInt(end)

  if (start > end) return []

  while (start <= end) {
    const ipStr = utils.ntoaBigInt(start, fam)

    // number with the least significent none 0 bit of start
    // also the biggest CIDR size starting from start
    let size
    if (start == 0n) {
      // a subnet of maxMaskLen makes no sense, start with 1 less bit
      size = 1n << (maxMaskLen - 1)
    } else {
      size = start & -start
    }

    // if start+size exceeds end, cut size in half
    while (start + size - 1n > end && size > 0n) {
      size >>= 1n
    }
    start += size

    let maskLen = maxMaskLen
    while (size > 1n) {
      size >>= 1n
      maskLen --
    }

    resultArray.push(ipStr + '/' + maskLen)
  }

  return resultArray
}
