'use strict'
let NM = require('./NotifyManager.js');
let HostManager = require("../net2/HostManager.js");
var hostManager= new HostManager();
let nm = new NM();

hostManager.getHost("192.168.2.186",(err,host)=>{
     let pornobj = { msg: 'Watching porn Jerry-iPhone pornhub.com',
        id: 'bf5932e3-ebda-4a79-89db-11dc21b520eb',
        alarmtype: 'porn',
        alarmseverity: 'info',
        actionobj: {
            dhname: "pornhub.com"
        },
        severityscore: '0',
        ts: 1488037299.313 } 
     let msg = nm.obj2msg(host, pornobj.alarmtype, pornobj);
     console.log(msg);

     
});


