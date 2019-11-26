/*    Copyright 2018 - 2019 Firewalla INC
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

'use strict';

var _os = require('os');

exports.platform = function(){
    return process.platform;
}

exports.cpuCount = function(){
    return _os.cpus().length;
}

exports.sysUptime = function(){
    //seconds
    return _os.uptime();
}

exports.processUptime = function(){
    //seconds
    return process.uptime();
}



// Memory
exports.freemem = function(){
    return _os.freemem() / ( 1024 * 1024 );
}

exports.totalmem = function(){

    return _os.totalmem() / ( 1024 * 1024 );
}

exports.freememPercentage = function(){
    return _os.freemem() / _os.totalmem();
}

// Hard Disk Drive
exports.harddrive = function(callback){

    require('child_process').exec('df -k', function(error, stdout, stderr) {

        var total = 0;
        var used = 0;
        var free = 0;

        var lines = stdout.split("\n");

        var str_disk_info = lines[1].replace( /[\s\n\r]+/g,' ');

        var disk_info = str_disk_info.split(' ');

        total = Math.ceil((disk_info[1] * 1024)/ Math.pow(1024,2));
        used = Math.ceil(disk_info[2] * 1024 / Math.pow(1024,2)) ;
        free = Math.ceil(disk_info[3] * 1024 / Math.pow(1024,2)) ;

        callback(total, free, used);
    });
}



// Return process running current
exports.getProcesses = function(nProcess, callback){

    // if nprocess is undefined then is function
    if(typeof nProcess === 'function'){

        callback =nProcess;
        nProcess = 0
    }

    let command = 'ps -eo pcpu,pmem,time,args | sort -k 1 -r | head -n'+10
    //command = 'ps aux | head -n '+ 11
    //command = 'ps aux | head -n '+ (nProcess + 1)
    if (nProcess > 0)
        command = 'ps -eo pcpu,pmem,time,args | sort -k 1 -r | head -n'+(nProcess + 1)

    require('child_process').exec(command, function(error, stdout, stderr) {

        var lines = stdout.split("\n");
        lines.shift()
        lines.pop()

        var result = ''


        lines.forEach(function(_item){

            var _str = _item.replace( /[\s\n\r]+/g,' ');

            _str = _str.split(' ')

            // result += _str[10]+" "+_str[9]+" "+_str[2]+" "+_str[3]+"\n";  // process
            result += _str[1]+" "+_str[2]+" "+_str[3]+" "+_str[4].substring((_str[4].length - 25))+"\n";  // process

        });

        callback(result);
    });
}



/*
* Returns All the load average usage for 1, 5 or 15 minutes.
*/
exports.allLoadavg = function(){

    var loads = _os.loadavg();

    return loads[0].toFixed(4)+','+loads[1].toFixed(4)+','+loads[2].toFixed(4);
}

/*
* Returns the load average usage for 1, 5 or 15 minutes.
*/
exports.loadavg = function(_time){

    if(_time === undefined || (_time !== 5 && _time !== 15) ) _time = 1;

    var loads = _os.loadavg();
    var v = 0;
    if(_time == 1) v = loads[0];
    if(_time == 5) v = loads[1];
    if(_time == 15) v = loads[2];

    return v;
}


exports.cpuFree = async function() {
  return new Promise(resolve => {
    getCPUUsage(resolve, true);
  })
}

exports.cpuUsage = async function() {
  return new Promise(resolve => {
    getCPUUsage(resolve, false);
  })
}

function getCPUUsage(callback, free){

    var stats1 = getCPUInfo();
    var startIdle = stats1.idle;
    var startTotal = stats1.total;

    setTimeout(function() {
        var stats2 = getCPUInfo();
        var endIdle = stats2.idle;
        var endTotal = stats2.total;

        var idle  = endIdle - startIdle;
        var total = endTotal - startTotal;
        var perc  = idle / total;

        if(free === true)
            callback( perc );
        else
            callback( (1 - perc) );

    }, 1000 * 10 ); // capture CPU after 10 seconds, and measure the ticking between two sampling points.
}

function getCPUInfo() {
    var cpus = _os.cpus();

    var user = 0;
    var nice = 0;
    var sys = 0;
    var idle = 0;
    var irq = 0;

    for(var cpu in cpus){

        user += cpus[cpu].times.user;
        nice += cpus[cpu].times.nice;
        sys += cpus[cpu].times.sys;
        irq += cpus[cpu].times.irq;
        idle += cpus[cpu].times.idle;
    }

    var total = user + nice + sys + idle + irq;

    return {
        'idle': idle,
        'total': total
    };
}

