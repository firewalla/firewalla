'use strict';

const fsp = require('fs').promises;

const path = process.argv[2];
const newPath = "./sc_converted.rules";

const observationCategories = ["INFO", "POLICY", "HUNTING", "RETIRED"];
const disabledSids = [
    2834935,  // nsis
    2831954, // nsis
    2019102, // SSDP (Multicast, dst address 239.255.255.250 is in HOME_NET)
];

function getCategory(msg) {
    const words = msg.split(" ");
    const vendorPrefixes = ["ET", "ETPRO", "GPL"];
    if (vendorPrefixes.includes(words[0]))
        return words[1];
    return words[0];
}

function isObservationRule(line, msg) {
    if (observationCategories.includes(getCategory(msg)))
        return true;
    return line.includes("signature_severity Informational");
}

const metadataKeys = ["msg", "reference", "classtype", "sid", "rev", "metadata", "threshold", "target", "priority", "gid", "flow"];
const domainBuffers = ["dns.query", "dns_query", "tls.sni", "tls_sni", "http.host", "http_host", "quic.sni"];
const contentModifiers = ["nocase", "endswith", "startswith", "fast_pattern", "depth", "offset", "isdataat", "bsize", "dotprefix"];

function getOptionKeys(line) {
    const body = line.substring(line.indexOf("(") + 1, line.lastIndexOf(")"));
    const unquoted = body.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    return unquoted.split(";")
        .map(option => option.split(":")[0].trim())
        .filter(key => key.length > 0);
}

function hasIpAddressInHeader(line) {
    const header = line.substring(0, line.indexOf("("));
    return /[\s\[,!]\d+\.\d+\.\d+\.\d+/.test(header);
}

function isPureIpRule(line, keys) {
    if (!hasIpAddressInHeader(line))
        return false;
    return keys.every(key => metadataKeys.includes(key) || key === "flowbits");
}

function isPureDomainRule(keys) {
    if (keys.includes("flowbits"))
        return false;
    const detectionKeys = keys.filter(key => !metadataKeys.includes(key) && !contentModifiers.includes(key));
    return detectionKeys.length === 2 && domainBuffers.includes(detectionKeys[0]) && detectionKeys[1] === "content";
}

function getSid(line) {
    const match = line.match(/[;(]\s*sid:\s*(\d+)\s*;/);
    return match ? Number(match[1]) : 0;
}

fsp.readFile(path, {encoding: "utf8"}).then(content => {
    const lines = content.trim().split("\n");
    const newLines = [];
    let observationCount = 0;
    let disabledCount = 0;
    let indicatorCount = 0;
    for (const line of lines) {
        if (!line.startsWith("alert "))
            continue;
        const i1 = line.indexOf("msg:\"");
        const i2 = line.indexOf("\";", i1);
        let msg = line.substring(i1 + 5, i2);
        if (isObservationRule(line, msg)) {
            observationCount++;
            continue;
        }
        if (disabledSids.includes(getSid(line))) {
            disabledCount++;
            continue;
        }
        const keys = getOptionKeys(line);
        if (isPureIpRule(line, keys) || isPureDomainRule(keys)) {
            indicatorCount++;
            continue;
        }
        if (msg.startsWith("ET "))
            msg = msg.substring(3);
        const options = line.substring(i2 + 2).split(";");
        let srcOrig = true;
        let classtypeDesc = "Potential bad traffic";
        let classtype = "bad-unknown";
        let sid = 0;
        for (const option of options) {
            const [key, value] = option.trim().split(":", 2);
            switch (key) {
                case "flow": {
                    if (value.includes("from_server") || value.includes("to_client"))
                        srcOrig = false;
                    break;
                }
                case "classtype": {
                    classtype = value;
                    switch (value) {
                        case "attempted-recon":
                        case "successful-recon-limited":
                        case "successful-recon-largescale": {
                            classtypeDesc = "information leak attempt";
                            break;
                        }
                        case "attempted-dos":
                        case "successful-dos": {
                            classtypeDesc = "DoS attack";
                            break;
                        }
                        case "attempted-user":
                        case "unsuccessful-user":
                        case "successful-user": {
                            classtypeDesc = "user privilege gain attempt";
                            break;
                        }
                        case "attempted-admin":
                        case "successful-admin": {
                            classtypeDesc = "administrator privilege gain attempt";
                            break;
                        }
                        case "rpc-portmap-decode": {
                            classtypeDesc = "decode of an RPC query";
                            break;
                        }
                        case "shellcode-detect": {
                            classtypeDesc = "executable shell code";
                            break;
                        }
                        case "string-detect": {
                            classtypeDesc = "a suspicious string";
                            break;
                        }
                        case "suspicious-filename-detect": {
                            classtypeDesc = "a suspicious filename";
                            break;
                        }
                        case "suspicious-login": {
                            classtypeDesc = "a login attempt using a suspicious username";
                            break;
                        }
                        case "system-call-detect": {
                            classtypeDesc = "a system call";
                            break;
                        }
                        case "trojan-activity": {
                            classtypeDesc = "a network trojan";
                            break;
                        }
                        case "unusual-client-port-connection": {
                            classtypeDesc = "an unusual port";
                            break;
                        }
                        case "network-scan": {
                            classtypeDesc = "a network scan";
                            break;
                        }
                        case "denial-of-service": {
                            classtypeDesc = "DoS attack";
                            break;
                        }
                        case "non-standard-protocol": {
                            classtypeDesc = "a non-standard protocol or event";
                            break;
                        }
                        case "protocol-command-decode": {
                            classtypeDesc = "generic protocol command decode";
                            break;
                        }
                        case "web-application-activity": {
                            classtypeDesc = "a potentially vulnerable web application";
                            break;
                        }
                        case "web-application-attack": {
                            classtypeDesc = "web application attack";
                            break;
                        }
                        case "inappropriate-content": {
                            classtypeDesc = "inappropriate content";
                            break;
                        }
                        case "policy-violation": {
                            classtypeDesc = "potential corporate privacy violation";
                            break;
                        }
                        case "default-login-attempt": {
                            classtypeDesc = "an attempt to login by a default username and password";
                            break;
                        }
                        case "targeted-activity": {
                            classtypeDesc = "targeted malicious activity";
                            break;
                        }
                        case "exploit-kit": {
                            classtypeDesc = "exploit kit activity";
                            break;
                        }
                        case "external-ip-check": {
                            classtypeDesc = "an attempt to retrieve external IP address";
                            break;
                        }
                        case "domain-c2": {
                            classtypeDesc = "access to a domain used by command and control";
                            break;
                        }
                        case "pup-activity": {
                            classtypeDesc = "an unwanted program";
                            break;
                        }
                        case "credential-theft": {
                            classtypeDesc = "credential theft";
                            break;
                        }
                        case "social-engineering": {
                            classtypeDesc = "social engineering attempt";
                            break;
                        }
                        case "coin-mining": {
                            classtypeDesc = "crypto currency mining activity";
                            break;
                        }
                        case "command-and-control": {
                            classtypeDesc = "a malware command and control activity";
                            break;
                        }
                        case "misc-activity": {
                            classtypeDesc = "miscellaneous activity";
                            break;
                        }
                        case "misc-attack": {
                            classtypeDesc = "a miscellaneous attack";
                            break;
                        }
                        case "unknown": {
                            classtypeDesc = "unknown traffic";
                            break;
                        }
                        case "not-suspicious": {
                            classtypeDesc = "non-suspicious traffic";
                            break;
                        }
                    }
                    break;
                }
                case "sid": {
                    sid = Number(value);
                    break;
                }
            }
        }
        if (sid >= 1 && sid <= 3464 || sid >= 100000000 && sid <= 100000908) {
            console.log(`Ignore GPLv2 license signature ${sid}`);
            continue;
        }
        const newMsg = `{\\"description\\":\\"{{${srcOrig ? "SRC" : "DST"}}} accessed site {{${srcOrig ? "DST" : "SRC"}}}, which is identified as ${classtypeDesc}.\\",\\"srcOrig\\": ${srcOrig},\\"alarmData\\": {\\"classtype\\":\\"${classtype}\\",\\"classtypeDesc\\":\\"${classtypeDesc}\\",\\"cause\\":\\"${msg}\\"}}`;
        const newRule = `${line.substring(0, i1)}msg:"${newMsg}";${line.substring(i2 + 2)}`;
        newLines.push(newRule);
    }
    console.log(`Skipped ${observationCount} observation rules, ${disabledCount} disabled rules and ${indicatorCount} pure IP/domain rules, kept ${newLines.length}`);
    fsp.writeFile(newPath, newLines.join("\n"));
});