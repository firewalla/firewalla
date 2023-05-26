// serverstatus.js. big data boom today.
var error = 0;
var d = 0;
var server_status = new Array();

function timeSince(date) {
	if(date == 0)
		return "Never.";

	var seconds = Math.floor((new Date() - date) / 1000);
	var interval = Math.floor(seconds / 60);
	if (interval > 1)
		return interval + " Minutes Ago.";
	else
		return "A few seconds ago";
}

function humanize_duration(seconds) {
	var days = Math.floor(seconds / 86400);
	seconds -= days * 86400;
	var hours = Math.floor(seconds / 3600);
	seconds -= hours * 3600;
	var minutes = Math.floor(seconds / 60);
	seconds -= minutes * 60;

	var result = "";
	if (days > 0)
		result += days + "d ";
	result += `${hours}:${minutes}:${seconds}`
	// if (hours > 0)
	// 	result += hours + " Hours ";
	// if (minutes > 0)
	// 	result += minutes + " Mins ";
	// if (seconds > 0)
	// 	result += seconds + " Secs";

	return result;
}

const allIds = {};

function uptime() {
	$.getJSON("/dashboard/json/stats.json", function(result) {
		$("#loading-notice").remove();
		if(result.reload)
			setTimeout(function() { location.reload() }, 1000);

		const allIdsCopy = Object.assign({}, allIds);

		for (var i = 0, rlen=result.stations.length; i < rlen; i++) {
			const mac = result.stations[i].mac_addr;
			const id = mac.replace(/:/g, "");

			allIds[id] = Math.floor(Date.now() / 1000);
			delete allIdsCopy[id];

			var TableRow = $("#stations tr#r-" + id);
			var hack; 
			if(i%2) hack="odd"; else hack="even";
			if (!TableRow.length) {
				$("#stations").append(
					"<tr id=\"r-" + id + "\" data-toggle=\"collapse\" data-target=\"#rt" + i + "\" class=\"accordion-toggle " + hack + "\">" +
						"<td id=\"name\">Loading</td>" +
						"<td id=\"mac\">Loading</td>" +
						"<td id=\"ip\">Loading</td>" +
						"<td id=\"ssid\">Loading</td>" +
						"<td id=\"channel\">Loading</td>" +
						"<td id=\"rssi\">Loading</td>" +
						"<td id=\"snr\"><div class=\"progress\"><div style=\"width: 100%;\" class=\"progress-bar progress-bar-warning\"><small>Loading</small></div></div></td>" +
						"<td id=\"latency\"><div class=\"progress\"><div style=\"width: 100%;\" class=\"progress-bar progress-bar-warning\"><small>Loading</small></div></div></td>" +
						"<td id=\"uptime\">Loading</td>" +
					"</tr>"
				);
				TableRow = $("#stations tr#r-" + id);
				server_status[i] = true;
			}
			TableRow = TableRow[0];
			if(error) {
				TableRow.setAttribute("data-target", "#rt" + i);
				server_status[i] = true;
			}

			const station = result.stations[i];
			const children = TableRow.children;

			children["name"].innerHTML = station.name;
			children["mac"].innerHTML = station.mac_addr;
			children["ip"].innerHTML = station.ip || "-";
			children["ssid"].innerHTML = station.ssid || "-";
			children["rssi"].innerHTML = station.rssi || "-";
			children["channel"].innerHTML = station.channel || "-";
			children["uptime"].innerHTML = humanize_duration(station.assoc_time);

// 5 dB to 10 dB: is below the minimum level to establish a connection, due to the noise level being nearly indistinguishable from the desired signal (useful information).
// 10 dB to 15 dB: is the accepted minimum to establish an unreliable connection.
// 15 dB to 25 dB: is typically considered the minimally acceptable level to establish poor connectivity.
// 25 dB to 40 dB: is deemed to be good.
// 41 dB or higher: is considered to be excellent.

			let snr = station.snr;
			let snr_status = "Normal";
			let snr_children = children["snr"].children[0].children[0];

			if (snr > 40) {
				snr_status = `Excellent (${snr})`;
				snr_children.className = "progress-bar progress-bar-success";
			} else if (snr > 25) {
				snr_children.className = "progress-bar progress-bar-warning";
				snr_status = `Medium (${snr})`;
			} else if (snr <= 25) {
				snr_children.className = "progress-bar progress-bar-danger";
				snr_status = `Poor (${snr})`;
			}
			
			snr_children.innerHTML =  snr_status;

			let latency = station.latency;
			let latency_str = "Error";
			let latency_children = children["latency"].children[0].children[0];

			if (latency == -1 || latency === undefined) {
				latency_children.className = "progress-bar progress-bar-danger";
				latency_str = `Timeout`;
			} else if (latency < 100) {
				latency_children.className = "progress-bar progress-bar-success";
				latency_str = `${latency} ms`;
			} else {
				latency_children.className = "progress-bar progress-bar-warning";
				latency_str = `${latency} ms`;
			}
			latency_children.innerHTML = latency_str;

		};

		for (const id in allIdsCopy) {
			let TableRow = $("#stations tr#r-" + id);
			TableRow = TableRow[0];
			const children = TableRow.children;
			const age = Math.floor(Date.now() / 1000) - allIdsCopy[id];
			const message = `Offline, last seen ${age}s ago`;
			children["uptime"].innerHTML = message;
		}

		d = new Date(result.updated*1000);
		error = 0;
	}).fail(function(update_error) {
		if (!error) {
			$("#stations > tr.accordion-toggle").each(function(i) {
				var TableRow = $("#stations tr#r" + i)[0];
				TableRow.children["snr"].children[0].children[0].className = "progress-bar progress-bar-error";
				TableRow.children["snr"].children[0].children[0].innerHTML = "<small>Error</small>";
				TableRow.children["latency"].children[0].children[0].className = "progress-bar progress-bar-error";
				TableRow.children["latency"].children[0].children[0].innerHTML = "<small>Error</small>";
				TableRow.setAttribute("data-target", "");
				server_status[i] = false;
			});
		}
		error = 1;
		$("#updated").html("Update Error.");
	});
}

function updateTime() {
	if (!error)
		$("#updated").html("Last Updated: " + timeSince(d));
}

uptime();
updateTime();
setInterval(uptime, 2000);
setInterval(updateTime, 2000);


// styleswitcher.js
function setActiveStyleSheet(title, cookie=false) {
        var i, a, main;
        for(i=0; (a = document.getElementsByTagName("link")[i]); i++) {
                if(a.getAttribute("rel").indexOf("style") != -1 && a.getAttribute("title")) {
                        a.disabled = true;
                        if(a.getAttribute("title") == title) a.disabled = false;
                }
        }
        if (true==cookie) {
                createCookie("style", title, 365);
        }
}

function getActiveStyleSheet() {
	var i, a;
	for(i=0; (a = document.getElementsByTagName("link")[i]); i++) {
		if(a.getAttribute("rel").indexOf("style") != -1 && a.getAttribute("title") && !a.disabled)
			return a.getAttribute("title");
	}
	return null;
}

function createCookie(name,value,days) {
	if (days) {
		var date = new Date();
		date.setTime(date.getTime()+(days*24*60*60*1000));
		var expires = "; expires="+date.toGMTString();
	}
	else expires = "";
	document.cookie = name+"="+value+expires+"; path=/";
}

function readCookie(name) {
	var nameEQ = name + "=";
	var ca = document.cookie.split(';');
	for(var i=0;i < ca.length;i++) {
		var c = ca[i];
		while (c.charAt(0)==' ')
			c = c.substring(1,c.length);
		if (c.indexOf(nameEQ) == 0)
			return c.substring(nameEQ.length,c.length);
	}
	return null;
}

window.onload = function(e) {
        var cookie = readCookie("style");
        if (cookie && cookie != 'null' ) {
                setActiveStyleSheet(cookie);
        } else {
                function handleChange (mediaQueryListEvent) {
                        if (mediaQueryListEvent.matches) {
                                setActiveStyleSheet('dark');
                        } else {
                                setActiveStyleSheet('light');
                        }
                }
                const mediaQueryListDark = window.matchMedia('(prefers-color-scheme: dark)');
                setActiveStyleSheet(mediaQueryListDark.matches ? 'dark' : 'light');
                mediaQueryListDark.addEventListener("change",handleChange);
        }
}
