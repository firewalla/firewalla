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
const charts = {};

function fetch_vip_stats() {
	$.getJSON("/dashboard/json/vip_stats.json", function(result) {
		$("#loading-notice").remove();
		if(result.reload)
			setTimeout(function() { location.reload() }, 1000);

		const allIdsCopy = Object.assign({}, allIds);

		let i = 0;
		for (const vip of Object.keys(result)) {
			i ++;
			const id = vip.replaceAll(".", "-");
			const data = result[vip];	
			const stats = data.stats;
			var TableRow = $("#vip_devices tr#v-" + id);
			var hack; 
			if(i%2) hack="odd"; else hack="even";
			if (!TableRow.length) {
				$("#vip_devices").append(
					"<tr id=\"v-" + id + "\" data-toggle=\"collapse\" data-target=\"#rt" + i + "\" class=\"accordion-toggle " + hack + "\">" +
						"<td id=\"name\">Loading</td>" +
						"<td id=\"ip\">Loading</td>" +
						"<td id=\"latency\"><div class=\"progress\"><div style=\"width: 100%;\" class=\"progress-bar progress-bar-warning\"><small>Loading</small></div></div></td>" +
						`<td id="history"><div style="width:480px;height:64px"> <canvas id="vc-${id}" width="100%" ></canvas> </div></td>` +
					"</tr>"
				);
				TableRow = $("#vip_devices tr#v-" + id);
			}
			TableRow = TableRow[0];
			if(error) {
				TableRow.setAttribute("data-target", "#rt" + i);
			}

			const children = TableRow.children;
			children["name"].innerHTML = data.name;
			children["ip"].innerHTML = vip;

			if (charts[id] === undefined) {
				let canvas = $("#vc-" + id);

				const chartData = {
					labels: vipLabels,
					datasets: [{
						data: [],
						fill: false,
						backgroundColor: [],
						barPercentage: 1,
						categoryPercentage: 1,
						tension: 0.1,
					}]
				};
				charts[id] = new Chart(canvas, {
					type: 'bar',
					data: chartData,
					options: vipChartOptions,
				});
			}

			if (stats && stats.length > 0) {
				const last_item = stats[stats.length - 1];

				let latency = last_item[1];
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

				for (const item of stats) {
					let latency = item[1];
					if (latency == -1 || latency === undefined) {
						addDataToVIPChart(charts[id], 1, '#dc3545', id);
					} else if (latency < 100) {
						addDataToVIPChart(charts[id], latency / 300, '#28a745', id);
					} else {
						addDataToVIPChart(charts[id], latency / 300, '#28a745', id);
					}
				}
			}

			charts[id].update();
		}
		d = new Date(result.updated*1000);
		error = 0;
	}).fail(function(update_error) {
		if (!error) {
			$("#devices > tr.accordion-toggle").each(function(i) {
				var TableRow = $("#vip_devices tr#r" + i)[0];
				TableRow.setAttribute("data-target", "");
				server_status[i] = false;
			});
		}
		error = 1;
		$("#updated").html("Update Error.");
	});
}

function uptime() {
	$.getJSON("/dashboard/json/stats.json", function(result) {
		$("#loading-notice").remove();
		if(result.reload)
			setTimeout(function() { location.reload() }, 1000);

		const allIdsCopy = Object.assign({}, allIds);

		for (var i = 0, rlen=result.devices.length; i < rlen; i++) {
			const mac = result.devices[i].mac_addr;
			const id = mac.replace(/:/g, "");

			allIds[id] = Math.floor(Date.now() / 1000);
			delete allIdsCopy[id];

			var TableRow = $("#devices tr#r-" + id);
			var hack; 
			if(i%2) hack="odd"; else hack="even";
			if (!TableRow.length) {
				$("#devices").append(
					"<tr id=\"r-" + id + "\" data-toggle=\"collapse\" data-target=\"#rt" + i + "\" class=\"accordion-toggle " + hack + "\">" +
						"<td id=\"name\">Loading</td>" +
						"<td id=\"mac\">Loading</td>" +
						"<td id=\"ip\">Loading</td>" +
						"<td id=\"ap\">Loading</td>" +
						"<td id=\"ssid\">Loading</td>" +
						"<td id=\"channel\">Loading</td>" +
						"<td id=\"rssi\">Loading</td>" +
						"<td id=\"snr\"><div class=\"progress\"><div style=\"width: 100%;\" class=\"progress-bar progress-bar-warning\"><small>Loading</small></div></div></td>" +
						"<td id=\"latency\"><div class=\"progress\"><div style=\"width: 100%;\" class=\"progress-bar progress-bar-warning\"><small>Loading</small></div></div></td>" +
						`<td id="history"><div style="width:240px;height:32px"> <canvas id="c-${id}" width="100%" ></canvas> </div></td>` +
						"<td id=\"uptime\">Loading</td>" +
					"</tr>"
				);
				TableRow = $("#devices tr#r-" + id);
				server_status[i] = true;
			}
			TableRow = TableRow[0];
			if(error) {
				TableRow.setAttribute("data-target", "#rt" + i);
				server_status[i] = true;
			}

			const device = result.devices[i];
			const children = TableRow.children;

			children["name"].innerHTML = device.name;
			children["mac"].innerHTML = device.mac_addr;
			children["ip"].innerHTML = device.ip || "-";
			children["ap"].innerHTML = device.apName || "-";
			children["ssid"].innerHTML = device.ssid || "-";
			children["rssi"].innerHTML = device.rssi || "-";
			children["channel"].innerHTML = device.channel || "-";
			children["uptime"].innerHTML = humanize_duration(device.assoc_time);

// 5 dB to 10 dB: is below the minimum level to establish a connection, due to the noise level being nearly indistinguishable from the desired signal (useful information).
// 10 dB to 15 dB: is the accepted minimum to establish an unreliable connection.
// 15 dB to 25 dB: is typically considered the minimally acceptable level to establish poor connectivity.
// 25 dB to 40 dB: is deemed to be good.
// 41 dB or higher: is considered to be excellent.

			let snr = device.snr;
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

			if (charts[id] === undefined) {
				let canvas = $("#c-" + id);

				const chartData = {
					labels: labels,
					datasets: [{
						data: [],
						fill: false,
						backgroundColor: [],
						barPercentage: 1,
						categoryPercentage: 1,
						tension: 0.1,
					}]
				};
				charts[id] = new Chart(canvas, {
					type: 'bar',
					data: chartData,
					options: chartOptions,
				});
			}

			let latency = device.latency;
			let latency_str = "Error";
			let latency_children = children["latency"].children[0].children[0];

			if (latency == -1 || latency === undefined) {
				latency_children.className = "progress-bar progress-bar-danger";
				latency_str = `Timeout`;
				append_data(charts[id], 1, '#dc3545', id);
			} else if (latency < 100) {
				latency_children.className = "progress-bar progress-bar-success";
				latency_str = `${latency} ms`;
				append_data(charts[id], latency / 300, '#28a745', id);
			} else {
				latency_children.className = "progress-bar progress-bar-warning";
				latency_str = `${latency} ms`;
				append_data(charts[id], latency / 300, '#28a745', id);
				//append_data(charts[id], latency / 300, '#ffc107', id);
			}
			latency_children.innerHTML = latency_str;


		};

		for (const id in allIdsCopy) {
			let TableRow = $("#devices tr#r-" + id);
			TableRow = TableRow[0];
			const children = TableRow.children;
			const age = Math.floor(Date.now() / 1000) - allIdsCopy[id];
			const message = `Last seen ${age}s ago`;
			children["uptime"].innerHTML = message;
			const snr_children = children["snr"].children[0].children[0];
			snr_children.className = "progress-bar progress-bar-danger";
			snr_children.innerHTML = "Offline";
		}

		d = new Date(result.updated*1000);
		error = 0;
	}).fail(function(update_error) {
		if (!error) {
			$("#devices > tr.accordion-toggle").each(function(i) {
				var TableRow = $("#devices tr#r" + i)[0];
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
fetch_vip_stats();
updateTime();
setInterval(uptime, 2000);
setInterval(fetch_vip_stats, 5000);
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
