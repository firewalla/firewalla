const URLSafeBase64 = {
  encode: (buffer) => {
    /**
     * .encode
     *
     * return an encoded Buffer as URL Safe Base64
     *
     * Note: This function encodes to the RFC 4648 Spec where '+' is encoded
     *       as '-' and '/' is encoded as '_'. The padding character '=' is
     *       removed.
     *
     * @param {Buffer} buffer
     * @return {String}
     * @api public
     */
    return buffer.toString('base64')
      .replace(/\+/g, '-') // Convert '+' to '-'
      .replace(/\//g, '_') // Convert '/' to '_'
      .replace(/=+$/, ''); // Remove ending '='
  },
  decode: (base64) => {
    /**
     * .decode
     *
     * return an decoded URL Safe Base64 as Buffer
     *
     * @param {String}
     * @return {Buffer}
     * @api public
     */
    // Add removed at end '='
    base64 += Array(5 - base64.length % 4).join('=');

    base64 = base64
      .replace(/\-/g, '+') // Convert '-' to '+'
      .replace(/\_/g, '/'); // Convert '_' to '/'

    return Buffer.from(base64, 'base64');
  }
}

var Protocol;
(function (Protocol) {
  Protocol[Protocol["DNSCrypt"] = 1] = "DNSCrypt";
  Protocol[Protocol["DOH"] = 2] = "DOH";
  Protocol[Protocol["DOT"] = 3] = "DOT";
  Protocol[Protocol["Plain"] = 4] = "Plain";
})(Protocol || (Protocol = {}));

var DNSStamp;
(function (DNSStamp) {
  class Properties {
    constructor(init) {
      this.dnssec = true;
      this.nolog = true;
      this.nofilter = true;
      Object.assign(this, init);
    }
    toNumber() {
      return ((this.dnssec ? 1 : 0) << 0) | ((this.nolog ? 1 : 0) << 1) | ((this.nofilter ? 1 : 0) << 2);
    }
  }
  DNSStamp.Properties = Properties;
  class DNSCrypt {
    constructor(addr, init) {
      this.addr = addr;
      this.props = new Properties();
      this.pk = "";
      this.providerName = "";
      Object.assign(this, init);
    }
    toString() {
      let props = this.props.toNumber();
      let addr = this.addr.split("").map(c => c.charCodeAt(0));
      let v = [Protocol.DNSCrypt, props, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
      v.push(addr.length, ...addr);
      let pk = Buffer.from(this.pk.replace(/[: \t]/g, ""), "hex");
      v.push(pk.length, ...pk);
      let providerName = this.providerName.split("").map(c => c.charCodeAt(0));
      v.push(providerName.length, ...providerName);
      return `sdns://${URLSafeBase64.encode(Buffer.from(v))}`;
    }
  }
  DNSStamp.DNSCrypt = DNSCrypt;
  class DOH {
    constructor(addr, init) {
      this.addr = addr;
      this.props = new Properties();
      this.hostName = "";
      this.hash = "";
      this.path = "";
      Object.assign(this, init);
    }
    toString() {
      let props = this.props.toNumber();
      let addr = this.addr.split("").map(c => c.charCodeAt(0));
      let v = [Protocol.DOH, props, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
      v.push(addr.length, ...addr);
      let hash = Buffer.from(this.hash.replace(/[: \t]/g, ""), "hex");
      v.push(hash.length, ...hash);
      let hostName = this.hostName.split("").map(c => c.charCodeAt(0));
      v.push(hostName.length, ...hostName);
      let path = this.path.split("").map(c => c.charCodeAt(0));
      v.push(path.length, ...path);
      return `sdns://${URLSafeBase64.encode(Buffer.from(v))}`;
    }
  }
  DNSStamp.DOH = DOH;
  class DOT {
    constructor(addr, init) {
      this.addr = addr;
      this.props = new Properties();
      this.hostName = "";
      this.hash = "";
      Object.assign(this, init);
    }
    toString() {
      let props = this.props.toNumber();
      let addr = this.addr.split("").map(c => c.charCodeAt(0));
      let v = [Protocol.DOT, props, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
      v.push(addr.length, ...addr);
      let hash = Buffer.from(this.hash.replace(/[: \t]/g, ""), "hex");
      v.push(hash.length, ...hash);
      let hostName = this.hostName.split("").map(c => c.charCodeAt(0));
      v.push(hostName.length, ...hostName);
      return `sdns://${URLSafeBase64.encode(Buffer.from(v))}`;
    }
  }
  DNSStamp.DOT = DOT;
  class Plain {
    constructor(addr, init) {
      this.addr = addr;
      this.props = new Properties();
      Object.assign(this, init);
    }
    toString() {
      let props = this.props.toNumber();
      let addr = this.addr.split("").map(c => c.charCodeAt(0));
      let v = [Protocol.Plain, props, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
      v.push(addr.length, ...addr);
      return `sdns://${URLSafeBase64.encode(Buffer.from(v))}`;
    }
  }
  DNSStamp.Plain = Plain;
  function parse(stamp) {
    if (stamp.substr(0, 7) !== "sdns://") {
      throw new Error("invalid scheme");
    }
    let bin = URLSafeBase64.decode(stamp.substr(7));
    const props = new Properties({
      dnssec: !!((bin[1] >> 0) & 1),
      nolog: !!((bin[1] >> 1) & 1),
      nofilter: !!((bin[1] >> 2) & 1),
    });
    let i = 9;
    let addrLen = bin[i++];
    const addr = bin.slice(i, i + addrLen).toString("utf-8");
    i += addrLen;
    switch (bin[0]) {
      case Protocol.DNSCrypt: {
        let pkLen = bin[i++];
        const pk = bin.slice(i, i + pkLen).toString("hex");
        i += pkLen;
        let providerNameLen = bin[i++];
        const providerName = bin.slice(i, i + providerNameLen).toString("utf-8");
        return new DNSCrypt(addr, { props, pk, providerName });
      }
      case Protocol.DOH: {
        const hashLen = bin[i++];
        const hash = bin.slice(i, i + hashLen).toString("hex");
        i += hashLen;
        const hostNameLen = bin[i++];
        const hostName = bin.slice(i, i + hostNameLen).toString("utf-8");
        i += hostNameLen;
        const pathLen = bin[i++];
        const path = bin.slice(i, i + pathLen).toString("utf-8");
        return new DOH(addr, { props, hash, hostName, path });
      }
      case Protocol.DOT: {
        const hashLen = bin[i++];
        const hash = bin.slice(i, i + hashLen).toString("hex");
        i += hashLen;
        const hostNameLen = bin[i++];
        const hostName = bin.slice(i, i + hostNameLen).toString("utf-8");
        i += hostNameLen;
        return new DOT(addr, { props, hash, hostName });
      }
      case Protocol.Plain: {
        return new Plain(addr, { props });
      }
    }
    throw new Error("unsupported protocol: " + bin[0]);
  }
  DNSStamp.parse = parse;
})(DNSStamp = exports.DNSStamp || (exports.DNSStamp = {}));