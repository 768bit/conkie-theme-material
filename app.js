// Imports {{{
var _ = require('lodash');
var $ = jQuery = require('jquery');
var angular = require('angular');
var electron = require('electron');
var angularjsGauge = require('angularjs-gauge');
var moment = require('moment');
var currentDate; // For optimize calandar generation
const osLocale = require('os-locale'); // For local/langue detection

moment.locale(osLocale.sync().substr(0,2)); // Fix local with system

// }}}
// Replace console.log -> ipcRenderer.sendMessage('console') + original console.log {{{
console.logReal = console.log;
console.log = function() {
	var args = Array.prototype.slice.call(arguments, 0);

	electron.ipcRenderer.send.apply(this, ['console'].concat(args));
	console.logReal.apply(this, args);
};
// }}}

// User configurable options
var options = {
	conkieStatsModules: [ // Modules we want Conkie stats to load
		'cpu',
		'dropbox',
		'io', // Also provides 'topIO'
		'memory',
		'net',
		'power',
		'system',
		'temperature',
		'topCPU',
		'topMemory',
		'disks'
	],
	conkieStats: { // Options passed to conkie-stats
		topProcessCount: 5,
		net: {
			ignoreNoIP: true,
			ignoreDevice: ['lo']
		},
		pollFrequency: {
			dropbox: 2000,
			io: 5000,
			memory: 1000,
			net: 5000,
			temperature: 5000,
			disks: 1000 * 60
		}
    },
	mainBattery: ['BAT0', 'BAT1'], // Which battery to examine for power info (the first one found gets bound to $scope.stats.battery)
	window: {
		left: 0,
		top: 0,
		width: 1920,
		height: 1080
    }
};



// Code only below this line - here be dragons
// -------------------------------------------


var app = angular.module('app', ['angularjs-gauge']);


// Angular / Filters {{{
/**
* Format a given number of seconds as a human readable duration
* e.g. 65 => '1m 5s'
* @param {number} value The number of seconds to process
* @return {string} The formatted value
*/
app.filter('duration', function() {
	return function(value) {
		if (!value || !isFinite(value)) return;

		var duration = moment.duration(value, 'seconds');
		if (!duration) return;

		var out = '';

		var years = duration.years();
		if (years) out += years + 'Y ';

		var months = duration.months();
		if (months) out += months + 'M ';

		var days = duration.days();
		if (days) out += days + 'd ';

		var hours = duration.hours();
		if (hours) out += hours + 'h ';

		var minutes = duration.minutes();
		if (minutes) out += minutes + 'm ';

		var seconds = duration.seconds();
		if (seconds) out += seconds + 's';

		return out;
	};
});


/**
* Return a formatted number as a file size
* e.g. 0 => 0B, 1024 => 1 kB
* @param {mixed} value The value to format
* @param {boolean} forceZero Whether the filter should return '0 B' if it doesnt know what to do
* @return {string} The formatted value
*/
app.filter('byteSize', function() {
	return function(value, forceZero) {
		value = parseInt(value);
		if (!value || !isFinite(value)) return (forceZero ? '0 B' : null);

		var exponent;
		var unit;
		var neg = value < 0;
		var units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

		if (neg) {
			value = -value;
		}

		if (value < 1) {
			return (neg ? '-' : '') + value + ' B';
		}

		exponent = Math.min(Math.floor(Math.log(value) / Math.log(1000)), units.length - 1);
		value = (value / Math.pow(1000, exponent)).toFixed(2) * 1;
		unit = units[exponent];

		return (neg ? '-' : '') + value + ' ' + unit;
	};
});


/**
* Return a number as a formatted percentage
* @param {mixed} value The value to format
* @return {string} The formatted value
*/
app.filter('percent', function() {
	return function(value) {
		if (!value || !isFinite(value)) return '';

		return Math.round(value, 2) + '%';
	};
});

// }}}

app.directive('graph', function() {
	return {
		scope: {
			data: '=',
			config: '='
		},
		restrict: 'E',
		template: '',
		controller: function($scope) {
			// Implied: $scope.elem;
			$scope.$watchCollection('data', function() {
				if (!$scope.elem || !$scope.data) return; // Element or data not bound yet
				$scope.elem.sparkline($scope.data, $scope.config);
			});
		},
		link: function($scope, elem, attr, ctrl) {
			$scope.elem = $(elem);
		}
	};
});

/**
* The main Conkie controller
* Each of the data feeds are exposed via the 'stats' structure and correspond to the output of [Conkie-Stats](https://github.com/hash-bang/Conkie-Stats)
*/
app.controller('conkieController', function($scope, $interval, $timeout) {
	// .stats - backend-IPC provided stats object {{{
	$scope.stats = {}; // Stats object (gets updated via IPC)

	/**
	* Object to hold when we last had data updates - each key is the module, each value is the unix timestamp
	* Since conkie-stats can provide different modules at different intervals we need to track when the mod last updated its info so we know whether to accept it as a new entry within a gauge
	* @type {Object}
	*/
	$scope.lastUpdate = {};

	electron.ipcRenderer
		// Event: updateStats {{{
		.on('updateStats', function(e, data) {
			$scope.$apply(function() {
				var now = new Date();
				$scope.stats = data;

				// .stats.power {{{
				if ($scope.stats.power && (!$scope.lastUpdate.power || $scope.lastUpdate.power !== data.lastUpdate.power)) {
					$scope.lastUpdate.power = data.lastUpdate.power;
					$scope.stats.battery = $scope.stats.power.find(function(dev) {
						return (_.includes(options.mainBattery, dev.device));
					});
				}
				// }}}

				// .stats.io {{{
				if (_.has($scope.stats, 'io.totalRead') && isFinite($scope.stats.io.totalRead) && (!$scope.lastUpdate.io || $scope.lastUpdate.io !== data.lastUpdate.io)) {
					$scope.lastUpdate.io = data.lastUpdate.io;
				}
				// }}}

				// .stats.memory {{{
				if (_.has($scope.stats, 'memory.used') && isFinite($scope.stats.memory.used) && (!$scope.lastUpdate.memory || $scope.lastUpdate.memory !== data.lastUpdate.memory)) {
					$scope.lastUpdate.memory = data.lastUpdate.memory;
					$scope.stats.memory.percentUsed =  Math.round( ($scope.stats.memory.used * 100) / $scope.stats.memory.total );
				}
				// }}}

                // .stats.disk {{{
                if (_.has($scope.stats, 'disks')) {
                    $scope.stats.disks = data.disks;

					for (var i = 0; i < $scope.stats.disks.length; i++) {
                    	var total = parseInt($scope.stats.disks[i].used) + parseInt($scope.stats.disks[i].free);
						$scope.stats.disks[i].percentUsed = Math.round( (parseInt($scope.stats.disks[i].used) * 100) / total );
					}
                }
                // }}}

				// .net {{{
				if ($scope.stats.net && (!$scope.lastUpdate.net || $scope.lastUpdate.net !== data.lastUpdate.net)) {
					$scope.lastUpdate.net = data.lastUpdate.net;
				}
				// }}}

				// .stats.system {{{
				if (_.has($scope.stats, 'cpu.usage') && isFinite($scope.stats.cpu.usage) && (!$scope.lastUpdate.cpu || $scope.lastUpdate.cpu !== data.lastUpdate.cpu)) {
					$scope.lastUpdate.cpu = data.lastUpdate.cpu;
				}
				// }}}

				// META: .stats.netTotal {{{
				$scope.stats.netTotal = $scope.stats.net.reduce(function(total, adapter) {
					if (adapter.downSpeed) total.downSpeed += adapter.downSpeed;
					if (adapter.upSpeed) total.upSpeed += adapter.upSpeed;
					return total;
				}, {
					downSpeed: 0,
					upSpeed: 0
				});
				// }}}
			});
		});
	// }}}

	// Configure conkie-stats to provide us with information {{{
	$timeout(function() {
		electron.ipcRenderer
			.send('statsRegister', options.conkieStatsModules)
	});
	$timeout(function() {
		electron.ipcRenderer
			.send('statsSettings', options.conkieStats);
	});
	// }}}
	// Position the widget {{{
	$timeout(function() {
		electron.ipcRenderer
			.send('setPosition', options.window);
	});
	// }}}
	// }}}

	// .time {{{
	$interval(function() {
        $scope.weekday = moment.weekdays(false)[moment().format('E')];
        $scope.month = moment().format('MMMM');
        $scope.day = moment().format('DD');
        $scope.year = moment().format('YYYY');
		$scope.time = moment().format('HH:mm');

		if (currentDate !== moment().format('DD')) {
            currentDate = moment().format('DD');
            makeCalendar();
        }
	}, 1000);
	// }}}

	console.log('Theme controller loaded');
});

/**
 * Generate a new calandar
 */
function makeCalendar()  {
    var currentMonth = moment().format('M');
    var lastDayCurrentMonth = moment( [moment().get('year'), moment().get('month') + 1, 1]).subtract(1, 'day').format('D');

    var weekPointer = moment().subtract(moment().date() - 1, 'day').format('w');

    var table = $('<table />', {
    	class: 'table-calandar'
	});

    var tr = $('<tr />');
    var td, dayMoment, i; // Declared here because is multiple used

    for (i = 1; i <= 7; i++) {
        td = $('<td />', {
            class: 'bold blue-grey-text center-align'
        });

        dayMoment = moment(weekPointer, 'w').day(i);

        $(td).append( dayMoment.format('dd') );
        $(tr).append(td);
    }
    $(table).append(tr);

    var exit = false;

    while (!exit) {
        tr = $('<tr />');
        for (i = 1; i <= 7; i++) {
            dayMoment = moment(weekPointer, 'w').day(i);

            var day = dayMoment.format('D');
            var month = dayMoment.format('M');

            var span = $('<span />', {
            	class: 'dayCalandar'
			});

            td = $('<td />', {
            	class: 'blue-grey-text center-align' +
				((month === currentMonth) ? ((day === moment().format('D')) ? ' text-lighten-5 radius-full' : ' ' ) : ' text-lighten-4') +
				((day === moment().format('D')) ? ' teal' : '')
			});
            $(span).text(day);
            $(td).append(span);
            $(tr).append(td);

            exit = (month === currentMonth) && (day === lastDayCurrentMonth);
        }
        $(table).append(tr);
        weekPointer++;
    }
    $('.calandar').html(table);
}
