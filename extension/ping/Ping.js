/*    Copyright 2019 Firewalla INC
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

var util = require('util');
var spawn = require('child_process').spawn;
var EventEmitter = require('events').EventEmitter;

var config;

var Ping = module.exports = exports = function Ping(extra_args) {
  if(!config) {
    throw new Error("Ping is not configured. Call Ping.configure() once for process");
  }

  if(extra_args)
    this.args = config.args.concat(extra_args);
  else
    this.args = config.args.slice();

  this.start(config.restart || false);
};
util.inherits(Ping, EventEmitter);



Ping.configure = function(conf) {
  config = conf;
  if(!config) {
    try {
      config = require('./config-default-' + process.platform);
    } catch(e) {
      throw new Error('node-ping-wrapper: Autoconfig for platform '+process.platform+' is not supported\nPlease check issues at https://github.com/langpavel/node-ping-wrapper/issues');
    }
  }
  Ping.event_handlers = [];

  var names = Object.keys(config.events);
  var i,l = names.length;
  for(i=0; i<l; i++) {
    (function() {
      var name = names[i];
      var re = config.events[name].regexp;
      var match_name, match_names = [];

      for(match_name in re) {
        if(typeof re[match_name] === 'number')
          match_names[re[match_name]] = match_name;
      }

      Ping.event_handlers.push({
        name: name,
        regexp: new RegExp(re.string,'im'),
        match_names: match_names,
        emits: config.events[name].emits
      });
    })();
  }

};



Ping.prototype._stop = function() {
  if(!this._process)
    return;
  
  this._process.kill();
  this._process = null;
};



Ping.prototype.stop = function() {
  this.autostart = false;
  this._stop();
};



Ping.prototype.start = function(restart) {
  if(restart && this._process)
  this.autostart = true;
  this._start();
};



Ping.prototype._start = function() {
  this._stop();

  var ping = this._process = spawn(config.command, this.args);

  ping.stdout.setEncoding('utf8');
  ping.stderr.setEncoding('utf8');

  ping.stdout.on('data', this._process_stdout_data.bind(this));
  ping.stderr.on('data', this._process_stderr_data.bind(this));
  ping.on('exit', this._process_exit.bind(this));
};



Ping.prototype._runEvents = function(data) {
  var i,l = Ping.event_handlers.length;
  var eh, match;
  var j, jl;
  var match_name;
  for(i=0; i<l; i++) {
    eh = Ping.event_handlers[i];
    if(match = eh.regexp.exec(data)) {
      var arg = { match: match };
      jl = match.length;
      for(j=0; j<jl; j++) {
        match_name = eh.match_names[j];
        if(match_name)
          arg[match_name] = match[j];
      }
      this.emit(eh.name, arg, this);
      if(eh.emits) {
        jl = eh.emits.length;
        for(j=0; j<jl; j++) {
          this.emit(eh.emits[j], arg, this);
        }
      }
    }
  }
};



Ping.prototype._process_stdout_data = function(data) {
  this.emit('data', data, false, this);
  this._runEvents(data);
};



Ping.prototype._process_stderr_data = function(data) {
  this.emit('data', data, true, this);
  this._runEvents(data);
};



Ping.prototype._process_exit = function(code) {
  this.emit('exit', code, this);

  if(this.autostart) {
    setTimeout(this._start.bind(this), 500);
  }
};



if(require.main === module) {
  Ping.configure();

  // shift out node and script name
   var args = process.argv.slice(2);
  var ping = new Ping(args);
  ping.on('ping', function(data){
    console.log('Ping %s: time: %d ms', data.host, data.time);
  });
  ping.on('fail', function(data){
    console.log('Fail', data);
  });
}
