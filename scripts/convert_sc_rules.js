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
          switch (value) {
            case "attempted-recon":
            case "successful-recon-limited":
            case "successful-recon-largescale": {
              classtypeDesc = "Information leak attempt was detected";
              break;
            }
            case "attempted-dos":
            case "successful-dos": {
              classtypeDesc = "DoS attack was detected";
              break;
            }
            case "attempted-user":
            case "unsuccessful-user":
            case "successful-user": {
              classtypeDesc = "User privilege gain attempt was detected";
              break;
            }
            case "attempted-admin":
            case "successful-admin": {
              classtypeDesc = "Administrator privilege gain attempt was detected";
              break;
            }
            case "rpc-portmap-decode": {
              classtypeDesc = "Decode of an RPC query was detected";
              break;
            }
            case "shellcode-detect": {
              classtypeDesc = "Executable shell code was detected";
              break;
            }
            case "string-detect": {
              classtypeDesc = "A suspicious string was detected";
              break;
            }
            case "suspicious-filename-detect": {
              classtypeDesc = "A suspicious filename was detected";
              break;
            }
            case "suspicious-login": {
              classtypeDesc = "Login attempt using a suspicious username was detected";
              break;
            }
            case "system-call-detect": {
              classtypeDesc = "A system call was detected";
              break;
            }
            case "trojan-activity": {
              classtypeDesc = "A network trojan was detected";
              break;
            }
            case "unusual-client-port-connection": {
              classtypeDesc = "An unusual port was used";
              break;
            }
            case "network-scan": {
              classtypeDesc = "A network scan was detected";
              break;
            }
            case "denial-of-service": {
              classtypeDesc = "DoS attack was detected";
              break;
            }
            case "non-standard-protocol": {
              classtypeDesc = "A non-standard protocol or event was detected";
              break;
            }
            case "protocol-command-decode": {
              classtypeDesc = "Generic protocol command decode was detected";
              break;
            }
            case "web-application-activity": {
              classtypeDesc = "A potentially vulnerable web application was detected";
              break;
            }
            case "web-application-attack": {
              classtypeDesc = "Web application attack was detected";
              break;
            }
            case "inappropriate-content": {
              classtypeDesc = "Inappropriate content was detected";
              break;
            }
            case "policy-violation": {
              classtypeDesc = "Potential corporate privacy violation was detected";
              break;
            }
            case "default-login-attempt": {
              classtypeDesc = "Attempt to login by a default username and password was detected";
              break;
            }
            case "targeted-activity": {
              classtypeDesc = "Targeted malicious activity was detected";
              break;
            }
            case "exploit-kit": {
              classtypeDesc = "Exploit kit activity was detected";
              break;
            }
            case "external-ip-check": {
              classtypeDesc = "Device retrieving external IP address was detected";
              break;
            }
            case "domain-c2": {
              classtypeDesc = "Access to a domain used by command and control was detected";
              break;
            }
            case "pup-activity": {
              classtypeDesc = "Unwanted program was detected";
              break;
            }
            case "credential-theft": {
              classtypeDesc = "Credential theft was detected";
              break;
            }
            case "social-engineering": {
              classtypeDesc = "Social engineering attempt was detected";
              break;
            }
            case "coin-mining": {
              classtypeDesc = "Crypto currency mining activity was detected";
              break;
            }
            case "command-and-control": {
              classtypeDesc = "Malware command and control activity was detected";
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
    const newMsg = `{\\"description\\":\\"${classtypeDesc} when {{${srcOrig ? "SRC" : "DST"}}} visited {{${srcOrig ? "DST" : "SRC"}}}, possibly triggered by ${msg}.\\", \\"srcOrig\\": ${srcOrig}}`;
    const newRule = `${line.substring(0, i1)}msg:"${newMsg}";${line.substring(i2 + 2)}`;
    newLines.push(newRule);
  }
  fsp.writeFile(newPath, newLines.join("\n"));
});