'use strict'

var redis = require("redis");
var rclient = redis.createClient();
var sclient = redis.createClient();
sclient.setMaxListeners(0);
let instance = null;


class NotifyManager {
 
    constructor() {
        if (instance == null) {
            this.config = null;
            rclient.hgetall("sys:notify",(err,result)=>{
                this.config = result;
            });

            this.obj2msg={};
            this.obj2msg['en'] = require('./obj2msg_en.js');
        }
        instance = self;
    }

    saveConfig(callback) {
        if (this.config == null) {
            return;
        }
        rclient.hset("sys:notify", this.config, callback);
    }
     

    // NotifyState:
    //  Intel: <severity>
    //  Porn: <severity>
    //  Gaming: <severity>
    //  Video: <severity> 

    notifyState(notifyId,severity,callback) {
    }

    obj2msg(host, msgtype, obj) {
        this.obj2msg['en'].obj2msg(host,msgtype,obj); 
    }

}    
    
