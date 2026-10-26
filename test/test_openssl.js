/*    Copyright 2016-2026 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict'

const chai = require('chai');
const expect = chai.expect;
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const openssl = require('../util/openssl.js');

const caContent = `-----BEGIN CERTIFICATE-----
MIIEiDCCA3CgAwIBAgIUZ7m1bBSMcmLVKrMyFODknewzl7kwDQYJKoZIhvcNAQEL
BQAwfDELMAkGA1UEBhMCVVMxCzAJBgNVBAgMAkNBMREwDwYDVQQHDAhTYW4gSm9z
ZTESMBAGA1UECgwJRmlyZXdhbGxhMSEwHwYJKoZIhvcNAQkBFhJoZWxwQGZpcmV3
YWxsYS5jb20xFjAUBgNVBAMMDWZpcmV3YWxsYS5jb20wHhcNMjYwNjE3MTAyMTIw
WhcNMzYwNjE0MTAyMTIwWjB8MQswCQYDVQQGEwJVUzELMAkGA1UECAwCQ0ExETAP
BgNVBAcMCFNhbiBKb3NlMRIwEAYDVQQKDAlGaXJld2FsbGExITAfBgkqhkiG9w0B
CQEWEmhlbHBAZmlyZXdhbGxhLmNvbTEWMBQGA1UEAwwNZmlyZXdhbGxhLmNvbTCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALY5vVHwq9X+OddsfoM4mLNn
Bv9xPTmN5AjlzSANeFYC61OEKrGqlOUZ2i41fsDAnnRE4xt41HJgLN5BbvHB9J6k
oCr93r4Tx1tQZkHfn6MDKOABE/IR86dy7mdY0I2mumApBnOCxA7Zj7LX6tb9jRX2
zrGanbHQDzZopZgwT3UlMyH2TMTPuQTMceQW5SIOmSq6e2L7UBYVB87QWXnoLNop
dMznC0wHrekXwkueHlKX08vV0Eqc03d1HPHJ6hAeFhpxc2JuTIM4GqKKe1eTnc7E
W84I25qh6QaTFEINoypFz7jRPTlNy2AK/mpqxA6dS4G6LNo277n+3k0Nx499Kd0C
AwEAAaOCAQAwgf0wHQYDVR0OBBYEFJLoXiCPfc4cvPXmxj9HTD/aIu7IMIG6BgNV
HSMEgbIwga+AFJLoXiCPfc4cvPXmxj9HTD/aIu7IoYGApH4wfDELMAkGA1UEBhMC
VVMxCzAJBgNVBAgMAkNBMREwDwYDVQQHDAhTYW4gSm9zZTESMBAGA1UECgwJRmly
ZXdhbGxhMSEwHwYJKoZIhvcNAQkBFhJoZWxwQGZpcmV3YWxsYS5jb20xFjAUBgNV
BAMMDWZpcmV3YWxsYS5jb22CFGe5tWwUjHJi1SqzMhTg5J3sM5e5MA8GA1UdEwEB
/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMA0GCSqGSIb3DQEBCwUAA4IBAQCvjkeX
js4tGW8y6vF/OeGbTeuIhIdDDAVIFC2nvpcfJXJGUf1hLPTE9WKn4ONS3ahMvdDr
f2oSKeEmqOFaysDnlXPQlpGCcpKueaTMMZh1yzdVK7Lef+F+V9S8o4QUaBhph9WG
w4Dxhp3JSPhoCIvLf9Lb4fUb3sK2sBIDeYW9EWzPx6m6NZzD4meyEFm+fPp8Fn6S
nG9W8HxNDB0rX/5uDWdWM6G5HD+XWeUAFpQcIO/nTDQrkcVcNtIVQwB5s9NuZ3/F
KQV7fs5azBK24tK9SZdYlLO06wPRfZhGHY8KzMJp14v/7JFd1+Zvp+41YxYnglmX
vEWhZ70+zdSavx3K
-----END CERTIFICATE-----
`;

const rsaKeyContent = `-----BEGIN ENCRYPTED PRIVATE KEY-----
MIIFNTBfBgkqhkiG9w0BBQ0wUjAxBgkqhkiG9w0BBQwwJAQQIBXLxsfRkfKVV/z5
NW1qgQICCAAwDAYIKoZIhvcNAgkFADAdBglghkgBZQMEASoEEApt5HBWSq+viQpk
xmVBtoIEggTQ+HfkHZE0g7SjhMgSA23Us7WLjrNRQO7wjpq3dP09EXPIopypvVmt
0tHAvnw9924samwyw3WKJiz5MfiQxKteAmKN8DCf9MV7rYPZOlcSHV7gEvzG7hT6
VHSCASPnMXLyRHll4NGCWE1KikAhSrYFcID9CKuyKEI2V43u7xBI1q8ep9mgoVZ1
l0ScmfWl//WjBlRuCtuaG1xo+eKrRzteo03MSaI7Q9qm8FmXsBmvsVoJV4orGu5M
Sfcz8mEAQNlGu1QDZKjWX5So45baqLM0iD9VrQdNsMoLDTD6qztFrCRnQ62/r2RW
emtwn6H08KYZsne+WbIjGLzki40ve7tEbOKtBoDrejyyjCWHtUDzBSJAFeI501EE
7UE8nY7UZTZ/SowoZyHwhKeAfTgRusE1+9Ru7to9Gz39w2uZzZdFGqKxC51RM4WY
b2hnFhtvCMB7Jl70iAN4XFgBUlU1lffmu27W38d4NcCJONaB2oVfFgGpPalB/YaB
KqVoqK+cxbeOhXuk27VaYX0ExwrAFm7cdbLu4qk/n/HbPZxwi/7QltoHu7ZByAPb
Aih8Q9Ag6QV7Bf96iMP791xXeFIPUBDjSzk5ygf47ut/p6sXKu7EgUpQT8KrWd2p
v+EX7VtEV0va/bFSZCLy3sAvlQyfx0dG0vWOYixyvflPlf/l71OQ++F5VnDuHGx7
+ExpCfyF+OQ7Hrj/mLB0Hh3iJYHFqI9lW6nEEEKAE6LGQPPo/9FuFvsGUOcndldS
9mCkB+yl45gHBBud2+53S2PPl9BhquGJ8QKbwGiGib9N6gXIYgkbB8JaXXHBxTuZ
WOvpdZ1IWm1ngiXTiFxk4eH58tvebTtcMs/xhNn/hZ1MljIsOOFhN+8YRst7Yhe5
uwzF4NYtaVpg7rcWiuZt2PhcyQIDJA3Gk/A/k0JNINgP53Wo5H+2jfgvOQ4nUM3M
qLOVunquEFGFKUHUikk2i2vnlGbk2Lw/hj7dPE6xtaJKJoScNzejM36lExxObQQK
G7qOSf9EAkIPZIpJ/1rTYMioWYYzlclNXGT1ftlWfjnvgcgHdB762EvpBqT5FcEc
scMbWxQbJpSgEzmVR3bN0nnSvj49NZyvkem/ICpEvHqlQqQXsPl5Ww7AoMxOTaQ0
fr2QzZlTIwuFyQh8lmFTygQfDzIr+FI1XM6iO1P5u1jTlg0J2PegeeNwvs/5m1/t
7+7QVV1zobH1M7qIHSzPn+j+nJJubOIXWJybe/IaJoq2bqiCIgWwiA+yEaD850ZK
xWKeOXg0V3sUJGTvdmsraHNx1uGmdh/uY5J2E3MntVUNG51qnhC/d79khN7763GK
jIOI1mEqNuvJNDWgRLInpQJkQQXSBPL/1K0x3/tSuj2o4ZiLK5lMWn3fOqB8iFp0
0EUbUZUda/OfF4AiibZ40A+qudBiHAnpwsnlG56w5VUnY+xueDxL2PKHSQY5A6iv
wadF+ArWJ/6SAStgJ7c9DvFGKTdE6dVdQbsFaEKleD3gO1Q1F5Xek5eASaBuk06o
cUG6tFJ894zwS7a0k9wLPeRA8o3AJjE+tY4UVFm6sg/QirPNiyQdXLYmxeh4f3RG
lrj2Od+zWgDHI+G7b/VNqXzW+BMyBnBpPcl1BVF6+HFXGTy/yPZRElQ=
-----END ENCRYPTED PRIVATE KEY-----
`;

const rsaCertContent = `Bag Attributes
    localKeyID: 1D 8A F0 E1 23 28 BD 4E FB 52 73 3D 85 BF 66 3C 5F 3E 1A 72
subject=C=US, ST=CA, O=Firewalla, CN=radius.firewalla.com, emailAddress=help@firewalla.com
issuer=C=US, ST=CA, L=San Jose, O=Firewalla, emailAddress=help@firewalla.com, CN=firewalla.com
-----BEGIN CERTIFICATE-----
MIIEEjCCAvqgAwIBAgIBATANBgkqhkiG9w0BAQsFADB8MQswCQYDVQQGEwJVUzEL
MAkGA1UECAwCQ0ExETAPBgNVBAcMCFNhbiBKb3NlMRIwEAYDVQQKDAlGaXJld2Fs
bGExITAfBgkqhkiG9w0BCQEWEmhlbHBAZmlyZXdhbGxhLmNvbTEWMBQGA1UEAwwN
ZmlyZXdhbGxhLmNvbTAeFw0yNjA2MTcxMDIxMjFaFw0zNjA2MTQxMDIxMjFaMHAx
CzAJBgNVBAYTAlVTMQswCQYDVQQIDAJDQTESMBAGA1UECgwJRmlyZXdhbGxhMR0w
GwYDVQQDDBRyYWRpdXMuZmlyZXdhbGxhLmNvbTEhMB8GCSqGSIb3DQEJARYSaGVs
cEBmaXJld2FsbGEuY29tMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA
nqSXfnhwhuZiuruHPkKaA3d+PBPj4AAVHpecIp/Kq9NkLy2pWewjNzzi8eISBV5V
a359EoS+1gFGyq+YDa8yJ+petBF5l5u4j+BLucsTMDSTym6z70ujx9e+FKlNQyK6
x9G2YRqFbn/j+UpGJxQX6EWsbUa5f8RrzikjSGlCQZY7Mi8TrY7hvEuF1PFBIAwV
DHNLCejfiyrk5WNdDoVm66Xsy0C4rmJ4JhcDP49x0nTTtyBvz3Gq14ewq2w9pzs6
ISoRfrId0ANn++33B4s/MPvgGh1rLvyjl74yq4qNicCf/MOAlqjOH5c5N8V21ZeT
sn2UZhKPicneavsvtfpR9QIDAQABo4GqMIGnMBMGA1UdJQQMMAoGCCsGAQUFBwMB
MDYGA1UdHwQvMC0wK6ApoCeGJWh0dHA6Ly93d3cuZXhhbXBsZS5jb20vZXhhbXBs
ZV9jYS5jcmwwGAYDVR0gBBEwDzANBgsrBgEEAYK+aAEDAjAdBgNVHQ4EFgQUWIuN
uh7mtbwiB7hLNc8vOsLy+BcwHwYDVR0jBBgwFoAUkuheII99zhy89ebGP0dMP9oi
7sgwDQYJKoZIhvcNAQELBQADggEBAJcDMiMwGMEzG8d1q/nAF4y7XlR0o/qrXhUM
I8LMZr23MTyaXe4GUBtbgxiCgWe1uHy1BIXOxn+EBsQ4vQ4lBq8P7V7knW5cj/XQ
GEPmqNvYlOcue2zsMlrapgJ9NwFgECLrjrDEs3khzSGS4EPWmMThSgmdzzetSLn1
WQ10ct/rAJVFFGGZ2fJkvTUPtZJRFWzYMswd91EQxOqfLkbs7GswLdd54mozK+DJ
zrtqd9NPQUisZoiot81xq664pSJjJB2K2P81ljJU79diQn4TyqpJ5nYZ493ZZ6Zr
2ST8BqqXlW6/NVWjvtHLXR3f1XwbrvqQjZs6m2tYSDunNNLjYWE=
-----END CERTIFICATE-----
Bag Attributes
    localKeyID: 1D 8A F0 E1 23 28 BD 4E FB 52 73 3D 85 BF 66 3C 5F 3E 1A 72
Key Attributes: <No Attributes>
-----BEGIN ENCRYPTED PRIVATE KEY-----
MIIFNTBfBgkqhkiG9w0BBQ0wUjAxBgkqhkiG9w0BBQwwJAQQ6tcj5RQBTbvRv91K
9dY25gICCAAwDAYIKoZIhvcNAgkFADAdBglghkgBZQMEASoEEM3ihH6Qy9l7B9NF
3BFHEx4EggTQ6D4uOeE3il6yKQ6ZT+capc0BIFQG3fwtg6AixqE+xnWOsUoEqUzr
ru+gE0KYPnD7DxiRZRyUPh7YjgChW/rBKqZU/5CArXFXGObje+x5/Pkb2SdsCPC/
b+2dato1Qgjchw2qDiE6c105xkG5EZxA32jx+08iX05h5iSRtQulxiUyEJs32jVD
qvyk2bBNAt/MxI7nqcJOGFCstPw1gYVF/REeavlCdw3iUoPPI19W2p9cgCSHRFyZ
m0hJECCb17v2XuBniCtr/lvltco2V+7ZBhvHa5EeekvG9jP5yadx+zTvlesDbDtF
ZWZTBM0rg3MVW7Xf1dSB53xH/UfuYid6D05Y0WONiGxFVG6Qx/eyLTjMmbxyWDM1
uOrlWBg0Ym+tUlfc7JNp4kdASJ5n2+619vX7CxwO85xDgY7bRNerORPhRZwdr8Zc
VdzJLWgkNG0Lqzm1yAsPdRQD7NbsrtzlN8en5WUptztLFuFMVQi0WF8bXqnK85bB
mA0EC1TgTDFj1bQeGLZTRaaLU3wHgcIr06BrRG3W2TuycjdiCBQ1zTCnxs0VL+Le
uk3pGi8XP1kQUWmbX3zdEyfGmIpBsMb+WYDRn+WZdxwIcncRqYnrLyMcU7/2hSoo
b65L/Jf3CLY28VdCOpNCYeyMh+Z2rPflMp+ixKNzo5689AjpvGhotVI2M4igyM4t
R9mKAHheWkO/pGBpc8ZV0WQKxawL2oSgsHiMF0ePECLK+inTU7CtYuobsyLSX/le
snhNsTFBFuJF7NsVCh/TzV5D9oBcFJcXOvEeJadw43T+WkmY9pVxehkPrDWzOYn2
g1EkG448usa+sauHPYHM2YA5P75XNFsQ2mXhfhODl3jEVrPomUTZDaeJYOMF1zcK
1Y6Nts03NIFBzpP3XYFWeHYLa0/ddTJjIcm9Ncc4wRmxwkfVOHmnxQ9JOHYY6xHp
TD6xic2Jj9p9RUPON+k0Osc6qr5vTM8N4CCfwfWanPub/BlscAgu89ozNziUHmqE
Mk7deHKn5UabRykfm22DucDc2czWrfgZfBNBjNI9sNxkDG1uU4hGz7fKGCAfl2lo
dIIrs2ug8GSzZuDIiq+I/jDhiJoaBxEqQ/u3ZzdE1gBrIe4NSRy25ZO6BH/OKycv
XggASDst7k5Z0cNxHvYicdmYKSLH2k+0cNB5JBtCpxPLFh2cHcbDItRlibcqwIIE
b3skteRJjd9H+/ufeJRfk85scwMzpO9eso1ZYotho+r+9OZssw8tnpaHcRyIWsTu
hpJeaK1PcBKUkwsF3sh61czFNCWHyxuOgOE1MS75XQiASDAPNlptALKiaaEjAh4Z
SkGNCHO8rM+3HsVvAXReE6GoY7v55lBx0MjcRe+IFTyN0PTI9UFj0dx6k7u1ycP7
eJXGeOlrWTGe8LAHCp+bC24OMPlCVRN8E6VEcNwbiIzpO8txSFkVPde+ZTNl7V5o
2l+0KA4tGtA5jVTIFUe3wyZMxdtMTQPBu0hT9QAexCeCp0jo6VQJiwgWIBO7vQsh
BU8f3fSzoCyjzha/s1bS90c0oLYo1zbFEnYE3YjodUxL0KLORlqrUbQlCgpGZdJg
DogDIBHO8mRWEuobLLJpldKGEbRaIkMiTbYCmH5NVWA7XmFkcHGPrPc=
-----END ENCRYPTED PRIVATE KEY-----
`;

const ecKeyContent = `-----BEGIN EC PARAMETERS-----
BgUrgQQAIg==
-----END EC PARAMETERS-----
-----BEGIN EC PRIVATE KEY-----
MIGkAgEBBDCBxdKvSeH3NXly5lPX2IvtK6/L750sOjnfs13WmU+RhLavqgTsDxCa
XxhXCAvl5xKgBwYFK4EEACKhZANiAAQEEqOEZMSScKE7hIF7MMpROapzBzAbf5PF
95L1Fvi7OvDple0Vj4G8E6aTQtxRmBOr6cI1z1kN/V2o+ld1bbGTNq58qZmaavog
zXAYexS5gYC6EvYCp/9iuKMENAln/qI=
-----END EC PRIVATE KEY-----
`;

const ecCertContent = `-----BEGIN CERTIFICATE-----
MIIB8jCCAXigAwIBAgIUQ4zlSijSWbhjNaX2UyzvObTsy2MwCgYIKoZIzj0EAwMw
OTELMAkGA1UEBhMCVVMxEjAQBgNVBAoMCUZpcmV3YWxsYTEWMBQGA1UEAwwNZmly
ZXdhbGxhLmNvbTAeFw0yNjAzMzAxMTE0MTdaFw0yNzAzMzAxMTE0MTdaMHwxCzAJ
BgNVBAYTAlVTMQswCQYDVQQIDAJDQTERMA8GA1UEBwwIU2FuIEpvc2UxEjAQBgNV
BAoMCUZpcmV3YWxsYTEhMB8GCSqGSIb3DQEJARYSaGVscEBmaXJld2FsbGEuY29t
MRYwFAYDVQQDDA1maXJld2FsbGEuY29tMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE
BBKjhGTEknChO4SBezDKUTmqcwcwG3+TxfeS9Rb4uzrw6ZXtFY+BvBOmk0LcUZgT
q+nCNc9ZDf1dqPpXdW2xkzaufKmZmmr6IM1wGHsUuYGAuhL2Aqf/YrijBDQJZ/6i
MAoGCCqGSM49BAMDA2gAMGUCMH2gNCEsj7BtOG1NU4m4JIYIdnn4uPvq0g55iJIR
YPlf5Ic3nsUheRIFyCciXv2pWwIxAPMTGdKBdN4ktB3Z1CjE/JEPglomiSmEjZfq
vb8caklM8vVkoVYLXmgox/ZyXZhndg==
-----END CERTIFICATE-----
`;


describe('Test openssl util', function () {
    this.timeout(60000);

    const serverKey = `/tmp/server.key`;
    const otherKey = `/tmp/other.key`;
    const caCert = `/tmp/ca.pem`;
    const serverCert = `/tmp/server.pem`;
    const otherCert = `/tmp/other.pem`;
    const missingCert = `/tmp/missing.pem`;
    const pass = "firewalla";

    before(async () => {
        await fs.writeFileAsync(caCert, caContent, 'utf8');
        await fs.writeFileAsync(serverCert, rsaCertContent, 'utf8');
        await fs.writeFileAsync(serverKey, rsaKeyContent, 'utf8');
        await fs.writeFileAsync(otherCert, ecCertContent, 'utf8');
        await fs.writeFileAsync(otherKey, ecKeyContent, 'utf8');
    });

    after(async () => {
        await fs.unlinkAsync(caCert);
        await fs.unlinkAsync(serverCert);
        await fs.unlinkAsync(serverKey);
        await fs.unlinkAsync(otherCert);
        await fs.unlinkAsync(otherKey);
    });

    describe('isPrivateKeyValid', () => {
        it('should return true for a valid key with the correct passphrase', async () => {
            expect(await openssl.isPrivateKeyValid(serverKey, pass)).to.be.true;
        });

        it('should return false for a wrong passphrase', async () => {
            expect(await openssl.isPrivateKeyValid(serverKey, 'wrongpass')).to.be.false;
        });
    });

    describe('getKeyType', () => {
        it('should return rsa for a valid rsa key', async () => {
            expect(await openssl.getKeyType(serverKey, pass)).to.equal('rsa');
        });

        it('should return ec for a valid ec key', async () => {
            expect(await openssl.getKeyType(otherKey, pass)).to.equal('ec');
        });
    });

    describe('isCertSignedByCA', () => {
        it('should return true when the cert is signed by the CA', async () => {
            expect(await openssl.isSignedByRootCA(caCert, serverCert)).to.be.true;
        });

        it('should return false when the cert is not signed by the CA', async () => {
            expect(await openssl.isSignedByRootCA(caCert, otherCert)).to.be.false;
        });

        it('should return false for a non-existent cert', async () => {
            expect(await openssl.isSignedByRootCA(caCert, missingCert)).to.be.false;
        });
    });

    describe('getCertModulusHash / getKeyModulusHash', () => {
        it('should return a non-empty hash string for a cert', async () => {
            const hash = await openssl.getCertModulusHash(serverCert);
            expect(hash).to.be.a('string').and.to.have.length.above(0);
        });

        it('should return matching hashes for a cert and its private key', async () => {
            const certHash = await openssl.getCertModulusHash(serverCert);
            const keyHash = await openssl.getKeyModulusHash(serverKey, pass);
            expect(certHash).to.equal(keyHash);
        });

        it('should return different hashes for a cert and an unrelated key', async () => {
            const certHash = await openssl.getCertModulusHash(serverCert);
            const keyHash = await openssl.getKeyModulusHash(otherKey, '');
            expect(certHash).to.not.equal(keyHash);
        });
    });

    describe('isKeyMatchCert', () => {
        it('should return true when the rsa key and cert are matched', async () => {
            expect(await openssl.isKeyMatchCert(serverCert, serverKey, 'rsa', pass)).to.be.true;
        });

        it('should return true when the ec key and cert are not matched', async () => {
            expect(await openssl.isKeyMatchCert(otherCert, otherKey, 'ec', pass)).to.be.true;
        });

        it('should return false when the key and cert are not matched', async () => {
            expect(await openssl.isKeyMatchCert(otherCert, serverKey, 'ec', pass)).to.be.false;
        });

        it('should return null for a non-existent cert', async () => {
            expect(await openssl.isKeyMatchCert(missingCert, serverKey, 'rsa', pass)).to.be.null;
        });

        it('should return null for a non-existent key', async () => {
            expect(await openssl.isKeyMatchCert(serverCert, missingCert, 'rsa', pass)).to.be.null;
        });
    });

    describe("getCertPubKey / getKeyPubKey", () => {
        it('should return a non-empty string for a cert', async () => {
            const pub = await openssl.getCertPubKey(otherCert);
            expect(pub).to.be.a('string').and.to.have.length.above(0);
        });

        it('should return a non-empty string for a key', async () => {
            const pub = await openssl.getKeyPubKey(otherKey, "");
            expect(pub).to.be.a('string').and.to.have.length.above(0);
        });
    });
});
