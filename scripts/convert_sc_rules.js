'use strict';

const fsp = require('fs').promises;

const path = process.argv[2];
const newPath = "./sc_converted.rules";

fsp.readFile(path, { encoding: "utf8" }).then(content => {
  const lines = content.trim().split("\n");
  const newLines = [];
  for (const line of lines) {
    if (!line.startsWith("alert "))
      continue;
    const i1 = line.indexOf("msg:\"");
    const i2 = line.indexOf("\";", i1);
    let msg = line.substring(i1 + 5, i2);
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
  fsp.writeFile(newPath, newLines.join("\n"));
});