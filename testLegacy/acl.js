#!/usr/bin/env node

/*
 * Features
 *  - get host list
 *  - get host information
 *  
 */

'use strict'
var fs = require('fs');
var program = require('commander');
var HostManager = require('../net2/HostManager.js');
var sysmanager = require('../net2/SysManager.js');
var FlowManager = require('../net2/FlowManager.js');
var flowManager = new FlowManager('info');

program.version('0.0.2')
       .option('--host [host]','configuration')
       .option('--dst [host]','configuration')
       .option('--src [host]','configuration')
       .option('--add [host]','configuration')


program.parse(process.argv);
sysmanager.update(null);

var hostManager = new HostManager("cli", 'client','debug');

let c = require('../net2/MessageBus.js');
this.subscriber= new c('debug');

this.subscriber.subscribe("DiscoveryEvent","DiscoveryStart", null, (channel,ip,msg) =>{
   console.log("Discovery Started");
});

function  _block(ip,blocktype,value,callback) {
        console.log("_block", ip, blocktype,value);
        if (ip === "0.0.0.0") {
         hostManager.loadPolicy((err,data)=>{  
           hostManager.setPolicy(blocktype,value,(err,data)=>{
               if (err==null) {
                  if (callback!=null)
                        callback(null, "Success");
                } else {
                   if (callback!=null)
                        callback(err,"Unable to block ip "+ip);
                }
           });
         });
        } else {
           hostManager.getHost(ip,(err,host)=>{
               if (host != null) {
                   host.loadPolicy((err,data)=>{
                      if (err == null) {
                          host.setPolicy(blocktype,value,(err,data)=>{
                              if (err==null) {
                                  if (callback!=null)
                                   //   this.tx(this.primarygid, "Success:"+ip,"hosts summary");  
                                     callback(null, "Success:"+ip);
                              } else {
                                  if (callback!=null)
                                    // this.tx(this.primarygid, "Unable to block ip "+ip,"hosts summary");  
                                     callback(err,"Unable to block ip "+ip)

                              }
                          });
                      } else {
                        if (callback!=null)
                          //this.tx(this.primarygid, "Unable to block ip "+ip,"hosts summary");  
                            callback("error", "Unable to block ip "+ip);
                      }
                  });
               } else {
                  if (callback!=null)
                   //this.tx(this.primarygid, "host not found","hosts summary");  
                      callback("error","Host not found");
               }
           });
        }
    }



setTimeout(()=>{
    let ip = program.host;

    console.log("Looking up host ",ip);
    let obj =  {
        dst:  program.dst,
        src: program.src,
        state: program.add == "true",
    };
    _block(ip,"acl", obj, (err)=> {
        if (err)
        console.log("Error Adding ACL obj", obj) 
    });
 
},2000);
