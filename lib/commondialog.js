/*    Copyright 2016 Firewalla LLC 
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

var builder = require('botbuilder');

var instance = null;

var dialog = new class {
    constructor() {
        if (instance == null) {
            instance = this;
            this.bot = new builder.TextBot();
            this.dialog = new builder.LuisDialog('https://api.projectoxford.ai/luis/v1/application?id=05487aa0-3fcf-4cf6-97e7-7ac1a12537e1&subscription-key=cb88156359b940fd81fd2cb491f4a405');
            this.bot.add('/', this.dialog);
            var self = this;

            this.dialog.on('intentHelp', function (session, args) {
                console.log("IntentHelp");
                var str = self.helpCallback();
                console.log("Return: ", str);
                if (str) {
                    session.send(str);
                }
            });

            this.dialog.on('intentVersionStatus', function (session, args) {
                console.log("IntentStatus");
                var str = self.statusCallback();
                if (str) {
                    session.send(str);
                }
            });
            this.dialog.on('intentServiceStateRestart', function (session, args) {
                console.log("IntentRestart");
                var str = self.restartCallback();
                if (str) {
                    session.send(str);
                }
            });

        }
        return instance;
    }

    registerInfo(helpCallback, restartCallback, statusCallback) {
        this.helpCallback = helpCallback;
        this.restartCallback = restartCallback;
        this.statusCallback = statusCallback;
        console.log(this.helpCallback);
    }

    processMessage(message, callback) {
        console.log("Common bot: <message>", message);
        this.bot.processMessage(message, callback);
    }

};

module.exports = dialog;
