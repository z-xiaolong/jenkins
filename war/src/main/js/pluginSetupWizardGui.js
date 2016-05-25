/**
 * Jenkins first-run install wizard
 */
// Require modules here, make sure they get browserify'd/bundled
var jquery = require('jquery-detached');
var bootstrap = require('bootstrap-detached');
var jenkins = require('./util/jenkins');
var pluginManager = require('./api/pluginManager');
var securityConfig = require('./api/securityConfig');

window.zq = jquery.getJQuery();

// Setup the dialog, exported
var createPluginSetupWizard = function(appendTarget) {
	// call getJQuery / getBootstrap within the main function so it will work with tests -- if getJQuery etc is called in the main
	var $ = jquery.getJQuery();
	var $bs = bootstrap.getBootstrap();

	var Handlebars = jenkins.initHandlebars();

	// Necessary handlebars helpers:
	// returns the plugin count string per category selected vs. available e.g. (5/44)
	Handlebars.registerHelper('pluginCountForCategory', function(cat) {
		var plugs = categorizedPlugins[cat];
		var tot = 0;
		var cnt = 0;
		for(var i = 0; i < plugs.length; i++) {
			var plug = plugs[i];
			if(plug.category === cat) {
				tot++;
				if(selectedPluginNames.indexOf(plug.plugin.name) >= 0) {
					cnt++;
				}
			}
		}
		return '(' + cnt + '/' + tot + ')';
	});

	// returns the total plugin count string selected vs. total e.g. (5/44)
	Handlebars.registerHelper('totalPluginCount', function() {
		var tot = 0;
		var cnt = 0;
		for(var i = 0; i < pluginList.length; i++) {
			var a = pluginList[i];
			for(var c = 0; c < a.plugins.length; c++) {
				var plug = a.plugins[c];
				tot++;
				if(selectedPluginNames.indexOf(plug.name) >= 0) {
					cnt++;
				}
			}
		}
		return '(' + cnt + '/' + tot + ')';
	});

	// determines if the provided plugin is in the list currently selected
	Handlebars.registerHelper('inSelectedPlugins', function(val, options) {
		if(selectedPluginNames.indexOf(val) >= 0) {
			return options.fn();
		}
	});

	// executes a block if there are dependencies
	Handlebars.registerHelper('hasDependencies', function(plugName, options) {
		var plug = availablePlugins[plugName];
		if(plug && plug.allDependencies && plug.allDependencies.length > 1) { // includes self
			return options.fn();
		}
	});

	// get total number of dependencies
	Handlebars.registerHelper('dependencyCount', function(plugName) {
		var plug = availablePlugins[plugName];
		if(plug && plug.allDependencies && plug.allDependencies.length > 1) { // includes self
			return plug.allDependencies.length - 1;
		}
	});

	// gets user friendly dependency text
	Handlebars.registerHelper('eachDependency', function(plugName, options) {
		var plug = availablePlugins[plugName];
		if(!plug) {
			return '';
		}
		var deps = $.grep(plug.allDependencies, function(value) { // remove self
			return value !== plugName;
		});
		
		var out  = '';
		for(var i = 0; i < deps.length; i++) {
			var depName = deps[i];
			var dep = availablePlugins[depName];
			if(dep) {
				out += options.fn(dep);
			}
		}
		return out;
	});

	// executes a block if there are dependencies
	Handlebars.registerHelper('ifVisibleDependency', function(plugName, options) {
		if(visibleDependencies[plugName]) {
			return options.fn();
		}
	});
	
	// Include handlebars templates here - explicitly require them and they'll be available by hbsfy as part of the bundle process
	var errorPanel = require('./templates/errorPanel.hbs');
	var loadingPanel = require('./templates/loadingPanel.hbs');
	var welcomePanel = require('./templates/welcomePanel.hbs');
	var progressPanel = require('./templates/progressPanel.hbs');
	var pluginSuccessPanel = require('./templates/successPanel.hbs');
	var pluginSelectionPanel = require('./templates/pluginSelectionPanel.hbs');
	var setupCompletePanel = require('./templates/setupCompletePanel.hbs');
	var proxyConfigPanel = require('./templates/proxyConfigPanel.hbs');
	var firstUserPanel = require('./templates/firstUserPanel.hbs');
	var offlinePanel = require('./templates/offlinePanel.hbs');
	var pluginSetupWizard = require('./templates/pluginSetupWizard.hbs');
	var incompleteInstallationPanel = require('./templates/incompleteInstallationPanel.hbs');
	var pluginSelectList = require('./templates/pluginSelectList.hbs');
	
	Handlebars.registerPartial('pluginSelectList', pluginSelectList);

	// wrap calls with this method to handle generic errors returned by the plugin manager
	var handleGenericError = function(success) {
		return function() {
			if(this.isError) {
				var errorMessage = this.errorMessage;
				if(!errorMessage || this.errorMessage === 'timeout') {
					errorMessage = translations.installWizard_error_connection;
				}
				else {
					errorMessage = translations.installWizard_error_message + " " + errorMessage;
				}
				setPanel(errorPanel, { errorMessage: errorMessage });
				return;
			}
			success.apply(this, arguments);
		};
	};
	
	var pluginList;
	var allPluginNames;
	var selectedPluginNames;
	
	// state variables for plugin data, selected plugins, etc.:
	var visibleDependencies = {};
	var categories = [];
	var availablePlugins = {};
	var categorizedPlugins = {};

	// Instantiate the wizard panel
	var $wizard = $(pluginSetupWizard());
	$wizard.appendTo(appendTarget);
	var $container = $wizard.find('.modal-content');
	var currentPanel;
	
	var self = this;
	
	// show tooltips; this is done here to work around a bootstrap/prototype incompatibility
	$(document).on('mouseenter', '*[data-tooltip]', function() {
		var $tip = $bs(this);
		var text = $tip.attr('data-tooltip');
		if(!text) {
			return;
		}
		// prototype/bootstrap tooltip incompatibility - triggering main element to be hidden
		this.hide = undefined;
		$tip.tooltip({
			html: true,
			title: text
		}).tooltip('show');
	});
	
	// handle clicking links that might not get highlighted due to position on the page
	$wizard.on('click', '.nav>li>a', function(){
		var $li = $(this).parent();
		var activateClicked = function() {
			if(!$li.is('.active')) {
				$li.parent().find('>li').removeClass('active');
				$li.addClass('active');
			}
		};
		setTimeout(activateClicked, 150); // this is the scroll time
		setTimeout(activateClicked, 250); // this should combat timing issues
	});

	// localized messages
	var translations = {};

	var decorations = [
		function() {
		// any decorations after DOM replacement go here
		}
	];
	
	var getJenkinsVersionFull = function() {
		var version = $('body').attr('data-version');
		if(!version) {
			return '';
		}
		return version;
	};

	var getJenkinsVersion = function() {
		return getJenkinsVersionFull().replace(/(\d[.]\d).*/,'$1');
	};

	// call this to set the panel in the app, this performs some additional things & adds common transitions
	var setPanel = function(panel, data, onComplete) {
		var decorate = function($base) {
			for(var i = 0; i < decorations.length; i++) {
				decorations[i]($base);
			}
		};
		var oncomplete = function() {
			var $content = $('*[data-load-content]');
			if($content.length > 0) {
				$content.each(function() {
					var $el = $(this);
					jenkins.get($el.attr('data-load-content'), function(data) {
						$el.html(data);
						if(onComplete) {
							onComplete();
						}
					}, { dataType: 'html' });
				});
			} else {
				if(onComplete) {
					onComplete();
				}
			}
		};
		var html = panel($.extend({translations: translations, baseUrl: jenkins.baseUrl, jenkinsVersion: getJenkinsVersion() }, data));
		if(panel === currentPanel) { // just replace id-marked elements
			var $upd = $(html);
			$upd.find('*[id]').each(function() {
				var $el = $(this);
				var $existing = $('#'+$el.attr('id'));
				if($existing.length > 0) {
					if($el[0].outerHTML !== $existing[0].outerHTML) {
						$existing.replaceWith($el);
						decorate($el);
					}
				}
			});

			oncomplete();
		}
		else {
			var append = function() {
				currentPanel = panel;
				$container.append(html);
				decorate($container);
				
				var $modalHeader = $container.find('.modal-header');
				if($modalHeader.length > 0 && $modalHeader.is('.closeable')) {
					$modalHeader.prepend(
						'<button type="button" class="close" aria-label="Close"><span aria-hidden="true">&times;</span></button>');
				}

				// add Jenkins version
				if(translations.installWizard_jenkinsVersionTitle) { // wait until translations available
					var $modalFooter = $container.find('.modal-footer');
					if($modalFooter.length === 0) {
						$modalFooter = $('<div class="modal-footer"></div>').appendTo($container);
					}
					$modalFooter.prepend('<div class="jenkins-version">'+translations.installWizard_jenkinsVersionTitle+' '+getJenkinsVersionFull()+'</div>');
				}
				
				oncomplete();
			};
			var $modalBody = $container.find('.modal-body');
			if($modalBody.length > 0) {
				$modalBody.stop(true).fadeOut(250, function() {
					$container.children().remove();
					append();
				});
			}
			else {
				$container.children().remove();
				append();
			}
		}
	};

	// plugin data for the progress panel
	var installingPlugins = [];
	var failedPluginNames = [];
	var getInstallingPlugin = function(plugName) {
		for(var i = 0; i < installingPlugins.length; i++) {
			var p = installingPlugins[i];
			if(p.name === plugName) {
				return p;
			}
		}
		return null;
	};
	var setFailureStatus = function(plugData) {
		var plugFailIdx = failedPluginNames.indexOf(plugData.name);
		if(/.*Fail.*/.test(plugData.installStatus)) {
			if(plugFailIdx < 0) {
				failedPluginNames.push(plugData.name);
			}
		} else if(plugFailIdx > 0) {
			failedPluginNames = failedPluginNames.slice(plugFailIdx,1);
		}
	};

	// recursively get all the dependencies for a particular plugin, this is used to show 'installing' status
	// when only dependencies are being installed
	var getAllDependencies = function(pluginName, deps) {
		if(!deps) { // don't get stuck
			deps = [];
			getAllDependencies(pluginName, deps);
			return deps;
		}
		if(deps.indexOf(pluginName) >= 0) {
			return;
		}
		deps.push(pluginName);

		var plug = availablePlugins[pluginName];
		if(plug) {
			if(plug.dependencies) {
				// plug.dependencies is  { "some-plug": "1.2.99", ... }
				for(var k in plug.dependencies) {
					getAllDependencies(k, deps);
				}
			}
			if(plug.neededDependencies) {
				// plug.neededDependencies is [ { name: "some-plug", ... }, ... ]
				for(var i = 0; i < plug.neededDependencies.length; i++) {
					getAllDependencies(plug.neededDependencies[i].name, deps);
				}
			}
		}
	};

	// Initializes the set of installing plugins with pending statuses
	var initInstallingPluginList = function() {
		installingPlugins = [];
		for (var i = 0; i < selectedPluginNames.length; i++) {
			var pluginName = selectedPluginNames[i];
			var p = availablePlugins[pluginName];
			if (p) {
				var plug = $.extend({
					installStatus : 'pending'
				}, p);
				installingPlugins.push(plug);
			}
		}
	};

	// call this to go install the selected set of plugins
	var installPlugins = function(pluginNames) {
		// make sure to have the correct list of selected plugins
		selectedPluginNames = pluginNames;
		// Switch to the right view but function() to force update when progressPanel re-rendered
		setPanel(function() { return progressPanel(arguments); }, { installingPlugins : [] });

		pluginManager.installPlugins(pluginNames, handleGenericError(function() {
			showStatePanel();
		}));
	};
	
	// toggles visibility of dependency listing for a plugin
	var toggleDependencyList = function() {
		var $btn = $(this);
		var $toggle = $btn.parents('.plugin:first');
		var plugName = $btn.attr('data-plugin-name');
		if(!visibleDependencies[plugName]) {
			visibleDependencies[plugName] = true;
		}
		else {
			visibleDependencies[plugName] = false;
		}
		if(!visibleDependencies[plugName]) {
			$toggle.removeClass('show-dependencies');
		}
		else {
			$toggle.addClass('show-dependencies');
		}
	};

	// install the default plugins
	var installDefaultPlugins = function() {
		loadPluginData(function() {
			installPlugins(pluginManager.recommendedPluginNames());
		});
	};
	
	var enableButtonsAfterFrameLoad = function() {
		$('iframe[src]').load(function() {
			$('button').prop({disabled:false});
		});
	};
	
	var setupFirstUser = function() {
		setPanel(firstUserPanel, {}, enableButtonsAfterFrameLoad);
	};
	
	// used to handle displays based on current Jenkins install state
	var stateHandlers = {
		DEFAULT: function() {
			setPanel(welcomePanel);
			// focus on default
			$('.install-recommended').focus();
		},
		CREATE_ADMIN_USER: function() { setupFirstUser(); },
		RUNNING: function() { setPanel(setupCompletePanel); },
		INITIAL_SETUP_COMPLETED: function() { setPanel(setupCompletePanel); },
		INITIAL_PLUGINS_INSTALLING: function() { showInstallProgress(); }
	};
	var showStatePanel = function(state) {
		if (!state) {
			pluginManager.installStatus(handleGenericError(function(data) {
				showStatePanel(data.state);
			}));
			return;
		}
		if(state in stateHandlers) {
			stateHandlers[state]();
		} else {
			stateHandlers.DEFAULT();
		}
	};
	
	// Define actions
	var showInstallProgress = function() {
		// check for installing plugins that failed
		if(failedPluginNames.length > 0) {
			setPanel(pluginSuccessPanel, { installingPlugins : installingPlugins, failedPlugins: true });
			return;
		}

		initInstallingPluginList();
		setPanel(progressPanel, { installingPlugins : installingPlugins });

		// call to the installStatus, update progress bar & plugin details; transition on complete
		var updateStatus = function() {
			pluginManager.installStatus(handleGenericError(function(data) {
				var jobs = data.jobs;
				
				var i, j;
				var complete = 0;
				var total = 0;
				var restartRequired = false;

				for(i = 0; i < jobs.length; i++) {
					j = jobs[i];
					total++;
					if(/.*Success.*/.test(j.installStatus) || /.*Fail.*/.test(j.installStatus)) {
						complete++;
					}
				}

				if(total === 0) { // don't end while there are actual pending plugins
					total = installingPlugins.length;
				}

				// update progress bar
				$('.progress-bar').css({width: ((100.0 * complete)/total) + '%'});

				// update details
				var $c = $('.install-text');
				$c.children().remove();

				for(i = 0; i < jobs.length; i++) {
					j = jobs[i];
					var txt = false;
					var state = false;
					if('true' === j.requiresRestart) {
						restartRequired = true;
					}

					if(/.*Success.*/.test(j.installStatus)) {
						txt = j.title;
						state = 'success';
					}
					else if(/.*Install.*/.test(j.installStatus)) {
						txt = j.title;
						state = 'installing';
					}
					else if(/.*Fail.*/.test(j.installStatus)) {
						txt = j.title;
						state = 'fail';
					}

					setFailureStatus(j);

					if(txt && state) {
						for(var installingIdx = 0; installingIdx < installingPlugins.length; installingIdx++) {
							var installing = installingPlugins[installingIdx];
							if(installing.name === j.name) {
								installing.installStatus = state;
							}
							else if(installing.installStatus === 'pending' && // if no progress
									installing.allDependencies.indexOf(j.name) >= 0 && // and we have a dependency
									('installing' === state || 'success' === state)) { // installing or successful
								installing.installStatus = 'installing'; // show this is installing
							}
						}

						var isSelected = selectedPluginNames.indexOf(j.name) < 0 ? false : true;
						var $div = $('<div>'+txt+'</div>');
						if(isSelected) {
							$div.addClass('selected');
						}
						else {
							$div.addClass('dependent');
						}
						$c.append($div);

						var $itemProgress = $('.selected-plugin[id="installing-' + jenkins.idIfy(j.name) + '"]');
						if($itemProgress.length > 0 && !$itemProgress.is('.'+state)) {
							$itemProgress.addClass(state);
						}
					}
				}

				$c = $('.install-console-scroll');
				if($c.is(':visible')) {
					$c.scrollTop($c[0].scrollHeight);
				}

				// keep polling while install is running
				if(complete < total || data.state === 'INITIAL_PLUGINS_INSTALLING') {
					setPanel(progressPanel, { installingPlugins : installingPlugins });
					// wait a sec
					setTimeout(updateStatus, 250);
				}
				else {
					// mark complete
					$('.progress-bar').css({width: '100%'});
					showStatePanel(data.state);
				}
			}));
		};

		// kick it off
		setTimeout(updateStatus, 250);
	};

	// Called to complete the installation
	var finishInstallation = function() {
		closeInstaller();
	};

	// load the plugin data, callback
	var loadPluginData = function(oncomplete) {
		pluginManager.availablePlugins(handleGenericError(function(availables) {
			var i, plug;
			for(i = 0; i < availables.length; i++) {
				plug = availables[i];
				availablePlugins[plug.name] = plug;
			}
			for(i = 0; i < availables.length; i++) {
				plug = availables[i];
				plug.allDependencies = getAllDependencies(plug.name);
			}
			oncomplete();
		}));
	};
	
	var loadPluginCategories = function(oncomplete) {
		loadPluginData(function() {
			categories = [];
			for(var i = 0; i < pluginList.length; i++) {
				var a = pluginList[i];
				categories.push(a.category);
				var plugs = categorizedPlugins[a.category] = [];
				for(var c = 0; c < a.plugins.length; c++) {
					var plugInfo = a.plugins[c];
					var plug = availablePlugins[plugInfo.name];
					if(!plug) {
						plug = {
							name: plugInfo.name,
							title: plugInfo.name
						};
					}
					plugs.push({
						category: a.category,
						plugin: $.extend({}, plug, {
							usage: plugInfo.usage,
							title: plugInfo.title ? plugInfo.title : plug.title,
							excerpt: plugInfo.excerpt ? plugInfo.excerpt : plug.excerpt,
							updated: new Date(plug.buildDate)
						})
					});
				}
			}
			oncomplete();
		});
	};

	// load the custom plugin panel, will result in an AJAX call to get the plugin data
	var loadCustomPluginPanel = function() {
		loadPluginCategories(function(){
			setPanel(pluginSelectionPanel, pluginSelectionPanelData(), function() {
				$bs('.plugin-selector .plugin-list').scrollspy({ target: '.plugin-selector .categories' });
			});
		});
	};

	// get plugin selection panel data object
	var pluginSelectionPanelData = function() {
		return {
			categories: categories,
			categorizedPlugins: categorizedPlugins,
			selectedPlugins: selectedPluginNames
		};
	};

	// remove a plugin from the selected list
	var removePlugin = function(arr, item) {
		for (var i = arr.length; i--;) {
			if (arr[i] === item) {
				arr.splice(i, 1);
			}
		}
	};

	// add a plugin to the selected list
	var addPlugin = function(arr, item) {
		arr.push(item);
	};

	// refreshes the plugin selection panel; call this if anything changes to ensure everything is kept in sync
	var refreshPluginSelectionPanel = function() {
		setPanel(currentPanel, pluginSelectionPanelData());
		if(lastSearch !== '') {
			searchForPlugins(lastSearch, false);
		}
	};

	// handle clicking an item in the plugin list
	$wizard.on('change', '.plugin-list input[type=checkbox]', function() {
		var $input = $(this);
		if($input.is(':checked')) {
			addPlugin(selectedPluginNames, $input.attr('name'));
		}
		else {
			removePlugin(selectedPluginNames, $input.attr('name'));
		}

		refreshPluginSelectionPanel();
	});

	// walk the elements and search for the text
	var walk = function(elements, element, text, xform) {
		var i, child, n= element.childNodes.length;
		for (i = 0; i<n; i++) {
			child = element.childNodes[i];
			if (child.nodeType===3 && xform(child.data).indexOf(text)!==-1) {
				elements.push(element);
				break;
			}
		}
		for (i = 0; i<n; i++) {
			child = element.childNodes[i];
			if (child.nodeType === 1) {
				walk(elements, child, text, xform);
			}
		}
	};

	// find elements matching the given text, optionally transforming the text before match (e.g. you can .toLowerCase() it)
	var findElementsWithText = function(ancestor, text, xform) {
		var elements= [];
		walk(elements, ancestor, text, xform ? xform : function(d){ return d; });
		return elements;
	};

	// search UI vars
	var findIndex = 0;
	var lastSearch = '';

	// scroll to the next match
	var scrollPlugin = function($pl, matches, term) {
		if(matches.length > 0) {
			if(lastSearch !== term) {
				findIndex = 0;
			}
			else {
				findIndex = (findIndex+1) % matches.length;
			}
			var $el = $(matches[findIndex]);
			$el = $el.parents('.plugin:first'); // scroll to the block
			if($el && $el.length > 0) {
				var pos = $pl.scrollTop() + $el.position().top;
				$pl.stop(true).animate({
					scrollTop: pos
				}, 100);
				setTimeout(function() { // wait for css transitions to finish
					var pos = $pl.scrollTop() + $el.position().top;
					$pl.stop(true).animate({
						scrollTop: pos
					}, 50);
				}, 50);
			}
		}
	};

	// search for given text, optionally scroll to the next match, set classes on appropriate elements from the search match
	var searchForPlugins = function(text, scroll) {
		var $pl = $('.plugin-list');
		var $containers = $pl.find('.plugin');

		// must always do this, as it's called after refreshing the panel (e.g. check/uncheck plugs)
		$containers.removeClass('match');
		$pl.find('h2').removeClass('match');

		if(text.length > 1) {
			if(text === 'show:selected') {
				$('.plugin-list .selected').addClass('match');
			}
			else {
				var matches = [];
				$containers.find('.title,.description').each(function() {
					var localMatches = findElementsWithText(this, text.toLowerCase(), function(d) { return d.toLowerCase(); });
					if(localMatches.length > 0) {
						matches = matches.concat(localMatches);
					}
				});
				$(matches).parents('.plugin').addClass('match');
				if(lastSearch !== text && scroll) {
					scrollPlugin($pl, matches, text);
				}
			}
			$('.match').parent().prev('h2').addClass('match');
			$pl.addClass('searching');
		}
		else {
			findIndex = 0;
			$pl.removeClass('searching');
		}
		lastSearch = text;
	};

	// handle input for the search here
	$wizard.on('keyup change', '.plugin-select-controls input[name=searchbox]', function() {
		var val = $(this).val();
		searchForPlugins(val, true);
	});

	// handle clearing the search
	$wizard.on('click', '.clear-search', function() {
		$('input[name=searchbox]').val('');
		searchForPlugins('', false);
	});

	// toggles showing the selected items as a simple search
	var toggleSelectedSearch = function() {
		var $srch = $('input[name=searchbox]');
		var val = 'show:selected';
		if($srch.val() === val) {
			val = '';
		}
		$srch.val(val);
		searchForPlugins(val, false);
	};

	// handle clicking on the category
	var selectCategory = function() {
		$('input[name=searchbox]').val('');
		searchForPlugins('', false);
		var $el = $($(this).attr('href'));
		var $pl = $('.plugin-list');
		var top = $pl.scrollTop() + $el.position().top;
		$pl.stop(true).animate({
			scrollTop: top
		}, 250, function() {
			var top = $pl.scrollTop() + $el.position().top;
			$pl.stop(true).scrollTop(top);
		});
	};

	// handle show/hide details during the installation progress panel
	var toggleInstallDetails = function() {
		var $c = $('.install-console');
		if($c.is(':visible')) {
			$c.slideUp();
		}
		else {
			$c.slideDown();
		}
	};
	
	var handleStaplerSubmit = function(data) {
		if(data.status && data.status > 200) {
			// Nothing we can really do here
			setPanel(errorPanel, { errorMessage: data.statusText });
			return;
		}
		
		try {
			if(JSON.parse(data).status === 'ok') {
				showStatePanel();
				return;
			}
		} catch(e) {
			// ignore JSON parsing issues, this may be HTML
		}
		// we get 200 OK
		var $page = $(data);
		var $errors = $page.find('.error');
		if($errors.length > 0) {
			var $main = $page.find('#main-panel').detach();
			if($main.length > 0) {
				data = data.replace(/body([^>]*)[>](.|[\r\n])+[<][/]body/,'body$1>'+$main.html()+'</body');
			}
			var doc = $('iframe[src]').contents()[0];
			doc.open();
			doc.write(data);
			doc.close();
		}
		else {
			showStatePanel();
		}
	};
	
	// call to submit the firstuser
	var saveFirstUser = function() {
		$('button').prop({disabled:true});
		securityConfig.saveFirstUser($('iframe[src]').contents().find('form:not(.no-json)'), handleStaplerSubmit, handleStaplerSubmit);
	};

	var skipFirstUser = function() {
		$('button').prop({disabled:true});
		setPanel(setupCompletePanel, {message: translations.installWizard_firstUserSkippedMessage});
	};
	
	// call to setup the proxy
	var setupProxy = function() {
		setPanel(proxyConfigPanel, {}, enableButtonsAfterFrameLoad);
	};
	
	// Save the proxy config
	var saveProxyConfig = function() {
		securityConfig.saveProxy($('iframe[src]').contents().find('form:not(.no-json)'), function() {
			jenkins.goTo('/'); // this will re-run connectivity test
		});
	};
	
	
	// push failed plugins to retry
	var retryFailedPlugins = function() {
		var failedPlugins = failedPluginNames;
		failedPluginNames = [];
		installPlugins(failedPlugins);
	};
	
	// continue with failed plugins
	var continueWithFailedPlugins = function() {
		pluginManager.installPluginsDone(function(){
			pluginManager.installStatus(handleGenericError(function(data) {
				failedPluginNames = [];
				showStatePanel(data.state);
			}));
		});
	};
	
	// Call this to resume an installation after restart
	var resumeInstallation = function() {
		// don't re-initialize installing plugins
		initInstallingPluginList = function() { };
		selectedPluginNames = [];
		for(var i = 0; i < installingPlugins.length; i++) {
			var plug = installingPlugins[i];
			if(plug.installStatus === 'pending') {
				selectedPluginNames.push(plug.name);
			}
		}
		installPlugins(selectedPluginNames);
	};

	// restart jenkins
	var restartJenkins = function() {
		pluginManager.restartJenkins(function() {
			setPanel(loadingPanel);

			console.log('-------------------');
			console.log('Waiting for Jenkins to come back online...');
			console.log('-------------------');
			var pingUntilRestarted = function() {
				pluginManager.isRestartRequired(function(isRequired) {
					if(this.isError || isRequired) {
						console.log('Waiting...');
						setTimeout(pingUntilRestarted, 1000);
					}
					else {
						jenkins.goTo('/');
					}
				});
			};

			pingUntilRestarted();
		});
	};

	// close the installer, mark not to show again
	var closeInstaller = function() {
		pluginManager.completeInstall(handleGenericError(function() {
			jenkins.goTo('/');
		}));
	};
	
	var startOver = function() {
		jenkins.goTo('/');
	};

	// scoped click handler, prevents default actions automatically
	var bindClickHandler = function(cls, action) {
		$wizard.on('click', cls, function(e) {
			action.apply(this, arguments);
			e.preventDefault();
		});
	};

	// click action mappings
	var actions = {
		'.toggle-dependency-list': toggleDependencyList,
		'.install-recommended': installDefaultPlugins,
		'.install-custom': loadCustomPluginPanel,
		'.install-home': function() { showStatePanel(); },
		'.install-selected': function() { installPlugins(selectedPluginNames); },
		'.toggle-install-details': toggleInstallDetails,
		'.install-done': finishInstallation,
		'.plugin-select-all': function() { selectedPluginNames = allPluginNames; refreshPluginSelectionPanel(); },
		'.plugin-select-none': function() { selectedPluginNames = []; refreshPluginSelectionPanel(); },
		'.plugin-select-recommended': function() { selectedPluginNames = pluginManager.recommendedPluginNames(); refreshPluginSelectionPanel(); },
		'.plugin-show-selected': toggleSelectedSearch,
		'.select-category': selectCategory,
		'.close': skipFirstUser,
		'.resume-installation': resumeInstallation,
		'.install-done-restart': restartJenkins,
		'.save-first-user:not([disabled])': saveFirstUser,
		'.skip-first-user': skipFirstUser,
		'.show-proxy-config': setupProxy,
		'.save-proxy-config': saveProxyConfig,
		'.skip-plugin-installs': function() { installPlugins([]); },
		'.retry-failed-plugins': retryFailedPlugins,
		'.continue-with-failed-plugins': continueWithFailedPlugins,
		'.start-over': startOver
	};

	// do this so the page isn't blank while doing connectivity checks and other downloads
	setPanel(loadingPanel);
	
	// Process extensions
	var extensionTranslationOverrides = [];
	/* globals setupWizardExtensions: true */
	if ('undefined' !== typeof(setupWizardExtensions)) {
		$.each(setupWizardExtensions, function() {
			this.call(self, {
				'$': $,
				'$wizard': $wizard,
				jenkins: jenkins,
				pluginManager: pluginManager,
				setPanel: setPanel,
				addActions: function(pluginActions) { $.extend(actions, pluginActions); },
				addStateHandlers: function(pluginStateHandlers) { $.extend(stateHandlers, pluginStateHandlers); },
				translationOverride: function(it) { extensionTranslationOverrides.push(it); },
				setSelectedPluginNames: function(pluginNames) { selectedPluginNames = pluginNames.slice(0); },
				showStatePanel: showStatePanel,
				installPlugins: installPlugins,
				pluginSelectionPanelData: pluginSelectionPanelData,
				loadPluginCategories: loadPluginCategories
			});
		});
	}
	
	for(var cls in actions) {
		bindClickHandler(cls, actions[cls]);
	}
	
	var showInitialSetupWizard = function() {
		// check for connectivity
		//TODO: make the Update Center ID configurable
		var siteId = 'default';
		jenkins.testConnectivity(siteId, handleGenericError(function(isConnected, isFatal, errorMessage) {
			if(!isConnected) {
				if (isFatal) { // We cannot continue, show error
					setPanel(errorPanel, { errorMessage: 'Default update site connectivity check failed with fatal error: ' + errorMessage + '. If you see this issue for the custom Jenkins WAR bundle, consider setting the correct value of the hudson.model.UpdateCenter.defaultUpdateSiteId system property (requires Jenkins restart). Otherwise please create a bug in Jenkins JIRA.' });
				} else { // The update center is offline, no problem
					setPanel(offlinePanel);
				}
				return;
			}
			
			// Initialize the plugin manager after connectivity checks
			pluginManager.init(handleGenericError(function() {
				pluginList = pluginManager.plugins();
				allPluginNames = pluginManager.pluginNames();
				selectedPluginNames = pluginManager.recommendedPluginNames();

			// check for updates when first loaded...
			pluginManager.installStatus(handleGenericError(function(data) {
				var jobs = data.jobs;
				
				if(jobs.length > 0) {
					if (installingPlugins.length === 0) {
						// This can happen on a page reload if we are in the middle of
						// an install. So, lets get a list of plugins being installed at the
						// moment and use that as the "selectedPlugins" list.
						selectedPluginNames = [];
						loadPluginData(handleGenericError(function() {
							for (var i = 0; i < jobs.length; i++) {
								var j = jobs[i];
								// If the job does not have a 'correlationId', then it was not selected
								// by the user for install i.e. it's probably a dependency plugin.
								if (j.correlationId) {
									selectedPluginNames.push(j.name);
								}
								setFailureStatus(j);
							}
							showStatePanel(data.state);
						}));
					} else {
						showStatePanel(data.state);
					}
					return;
				}

				// check for crash/restart with uninstalled initial plugins
				pluginManager.incompleteInstallStatus(handleGenericError(function(incompleteStatus) {
					var incompletePluginNames = [];
					for(var plugName in incompleteStatus) {
						incompletePluginNames.push(plugName);
					}

					if(incompletePluginNames.length > 0) {
						selectedPluginNames = incompletePluginNames;
						loadPluginData(handleGenericError(function() {
							initInstallingPluginList();

							for(var plugName in incompleteStatus) {
								var j = getInstallingPlugin(plugName);
								
								if (!j) {
									console.warn('Plugin "' + plugName + '" not found in the list of installing plugins.');
									continue;
								}

								var txt = false;
								var state = false;
								var status = incompleteStatus[plugName];

								if(/.*Success.*/.test(status)) {
									txt = j.title;
									state = 'success';
								}
								else if(/.*Install.*/.test(status)) {
									txt = j.title;
									state = 'pending';
								}
								else if(/.*Fail.*/.test(status)) {
									txt = j.title;
									state = 'fail';
								}

								if(state) {
									j.installStatus = state;
								}
							}
							setPanel(incompleteInstallationPanel, { installingPlugins : installingPlugins });
						}));
						return;
					}

					// finally,  show the installer
					// If no active install, by default, we'll show the welcome screen
					showStatePanel();

				}));
				}));
			}));
		}));
	};
	
	// kick off to get resource bundle
	jenkins.loadTranslations('jenkins.install.pluginSetupWizard', handleGenericError(function(localizations) {
		translations = localizations;
		
		// process any translation overrides
		$.each(extensionTranslationOverrides, function() {
			this(translations);
		});
		
		showInitialSetupWizard();
	}));
};

// export wizard creation method
exports.init = createPluginSetupWizard;
