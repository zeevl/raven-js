'use strict';

// First, check for JSON support
// If there is no JSON, we no-op the core features of Raven
// since JSON is required to encode the payload
var _Raven = window.Raven,
    hasJSON = !!(window.JSON && window.JSON.stringify),
    lastCapturedException,
    lastEventId,
    globalServer,
    globalUser,
    globalKey,
    globalOptions = {
        logger: 'javascript',
        ignoreErrors: [],
        ignoreUrls: [],
        whitelistUrls: [],
        includePaths: [],
        collectWindowErrors: true,
        tags: {},
        extra: {}
    },
    timeline = [],
    authQueryString;

// Local reference to window.document
var doc = window.document;

/*
 * The core Raven singleton
 *
 * @this {Raven}
 */
var Raven = {
    VERSION: '<%= pkg.version %>',

    /*
     * Allow multiple versions of Raven to be installed.
     * Strip Raven from the global context and returns the instance.
     *
     * @return {Raven}
     */
    noConflict: function() {
        window.Raven = _Raven;
        return Raven;
    },

    /*
     * Configure Raven with a DSN and extra options
     *
     * @param {string} dsn The public Sentry DSN
     * @param {object} options Optional set of of global options [optional]
     * @return {Raven}
     */
    config: function(dsn, options) {
        if (!dsn) return Raven;

        var uri = parseDSN(dsn),
            lastSlash = uri.path.lastIndexOf('/'),
            path = uri.path.substr(1, lastSlash);

        // merge in options
        globalOptions = objectMerge(globalOptions, options);

        if (isUndefined(globalOptions.transaction)) {
            globalOptions.transaction = uuid4();
        }

        // "Script error." is hard coded into browsers for errors that it can't read.
        // this is the result of a script being pulled in from an external domain and CORS.
        globalOptions.ignoreErrors.push('Script error.');
        globalOptions.ignoreErrors.push('Script error');

        // join regexp rules into one big rule
        globalOptions.ignoreErrors = joinRegExp(globalOptions.ignoreErrors);
        globalOptions.ignoreUrls = globalOptions.ignoreUrls.length ? joinRegExp(globalOptions.ignoreUrls) : false;
        globalOptions.whitelistUrls = globalOptions.whitelistUrls.length ? joinRegExp(globalOptions.whitelistUrls) : false;
        globalOptions.includePaths = joinRegExp(globalOptions.includePaths);

        globalKey = uri.user;

        // assemble the endpoint from the uri pieces
        globalServer = '//' + uri.host +
                      (uri.port ? ':' + uri.port : '') +
                      '/' + path + 'api/' + uri.path.substr(lastSlash + 1) + '/store/';

        if (uri.protocol) {
            globalServer = uri.protocol + ':' + globalServer;
        }

        if (globalOptions.fetchContext) {
            TraceKit.remoteFetching = true;
        }

        if (globalOptions.linesOfContext) {
            TraceKit.linesOfContext = globalOptions.linesOfContext;
        }

        TraceKit.collectWindowErrors = !!globalOptions.collectWindowErrors;

        setAuthQueryString();

        // return for chaining
        return Raven;
    },

    /*
     * Installs a global window.onerror error handler
     * to capture and report uncaught exceptions.
     * At this point, install() is required to be called due
     * to the way TraceKit is set up.
     *
     * @return {Raven}
     */
    install: function() {
        if (isSetup()) {
            TraceKit.report.subscribe(handleStackInfo);
        }

        return Raven;
    },

    /*
     * Wrap code within a context so Raven can capture errors
     * reliably across domains that is executed immediately.
     *
     * @param {object} options A specific set of options for this context [optional]
     * @param {function} func The callback to be immediately executed within the context
     * @param {array} args An array of arguments to be called with the callback [optional]
     */
    context: function(options, func, args) {
        if (isFunction(options)) {
            args = func || [];
            func = options;
            options = undefined;
        }

        return Raven.wrap(options, func).apply(this, args);
    },

    /*
     * Wrap code within a context and returns back a new function to be executed
     *
     * @param {object} options A specific set of options for this context [optional]
     * @param {function} func The function to be wrapped in a new context
     * @return {function} The newly wrapped functions with a context
     */
    wrap: function(options, func) {
        // 1 argument has been passed, and it's not a function
        // so just return it
        if (isUndefined(func) && !isFunction(options)) {
            return options;
        }

        // options is optional
        if (isFunction(options)) {
            func = options;
            options = undefined;
        }

        // At this point, we've passed along 2 arguments, and the second one
        // is not a function either, so we'll just return the second argument.
        if (!isFunction(func)) {
            return func;
        }

        // We don't wanna wrap it twice!
        if (func.__raven__) {
            return func;
        }

        function wrapped() {
            var args = [], i = arguments.length,
                deep = !options || options && options.deep !== false;
            // Recursively wrap all of a function's arguments that are
            // functions themselves.

            while(i--) args[i] = deep ? Raven.wrap(options, arguments[i]) : arguments[i];

            try {
                /*jshint -W040*/
                return func.apply(this, args);
            } catch(e) {
                Raven.captureException(e, options);
                throw e;
            }
        }

        // copy over properties of the old function
        for (var property in func) {
            if (hasKey(func, property)) {
                wrapped[property] = func[property];
            }
        }

        // Signal that this function has been wrapped already
        // for both debugging and to prevent it to being wrapped twice
        wrapped.__raven__ = true;
        wrapped.__inner__ = func;

        return wrapped;
    },

    /*
     * Uninstalls the global error handler.
     *
     * @return {Raven}
     */
    uninstall: function() {
        TraceKit.report.uninstall();

        return Raven;
    },

    /*
     * Add a generic action to the timeline.
     *
     * @param {object} action The action to be appended
     * @return {Raven}
     */
    addAction: function(action) {
        action.type = action.type || 'message';
        action.timestamp = action.timestamp || nowISO();
        timeline.push(action);
        return Raven;
    },

    /*
     * Add an http_request event to the global timeline
     *
     * @return {Raven}
     */
    addHttp: function() {
        return Raven.addAction(getHttpData());
    },

    /*
     * Add a message to the global timeline.
     *
     * @param {string|object} msg The message to append to the timeline.
     * @param {object} options A specific set of options for this message [optional]
     * @return {Raven}
     */
    addMessage: function(msg) {
        return Raven.addAction(isString(msg) ? {message: msg} : msg);
    },

    /*
     * Add an exception to the global timeline.
     *
     * @param {Error} exc An exception to be logged
     * @param {function} cb A callback for after the exception has been added to the timeline
     * @return {Raven}
     */
    addException: function(exc, cb) {
        // Store the raw exception object for potential debugging and introspection
        lastCapturedException = exc;

        // TraceKit.report will re-raise any exception passed to it,
        // which means you have to wrap it in try/catch. Instead, we
        // can wrap it here and only re-raise if TraceKit.report
        // raises an exception different from the one we asked to
        // report on.
        try {
            TraceKit.report(exc, {cb: cb});
        } catch(exc1) {
            if(exc !== exc1) {
                throw exc1;
            }
        }

        return Raven;
    },

    /*
     * Manually capture an exception and send it over to Sentry
     *
     * @param {error} ex An exception to be logged
     * @param {object} options A specific set of options for this error [optional]
     * @return {Raven}
     */
    captureException: function(ex, options) {
        // If a string is passed through, recall as a message
        if (isString(ex)) return Raven.captureMessage(ex, options);

        Raven.addException(ex, function(err) {
            if (!err) {
                // Fire away!
                capture(options);
            }
        });

        return Raven;
    },

    /*
     * Manually send a message to Sentry
     *
     * @param {string|object} msg A plain message to be captured in Sentry
     * @param {object} options A specific set of options for this message [optional]
     * @return {Raven}
     */
    captureMessage: function(msg, options) {
        // Fire away!
        Raven.addMessage(msg, options);
        capture(options);

        return Raven;
    },

    /*
     * Set/clear a user to be sent along with the payload.
     *
     * @param {object} user An object representing user data [optional]
     * @return {Raven}
     */
    setUser: function(user) {
       globalUser = user;

       return Raven;
    },

    /*
     * Empty the global timeline of events.
     *
     * @return {Raven}
     */
    reset: function() {
        timeline = [];

        return Raven;
    },

    /*
     * Get the latest raw exception that was captured by Raven.
     *
     * @return {error}
     */
    lastException: function() {
        return lastCapturedException;
    },

    /*
     * Get the last event id
     *
     * @return {string}
     */
    lastEventId: function() {
        return lastEventId;
    }
};

function triggerEvent(eventType, options) {
    var event, key;

    options = options || {};

    eventType = 'raven' + eventType.substr(0,1).toUpperCase() + eventType.substr(1);

    if (doc.createEvent) {
        event = doc.createEvent('HTMLEvents');
        event.initEvent(eventType, true, true);
    } else {
        event = doc.createEventObject();
        event.eventType = eventType;
    }

    for (key in options) if (hasKey(options, key)) {
        event[key] = options[key];
    }

    if (doc.createEvent) {
        // IE9 if standards
        doc.dispatchEvent(event);
    } else {
        // IE8 regardless of Quirks or Standards
        // IE9 if quirks
        try {
            doc.fireEvent('on' + event.eventType.toLowerCase(), event);
        } catch(e) {}
    }
}

var dsnKeys = 'source protocol user pass host port path'.split(' '),
    dsnPattern = /^(?:(\w+):)?\/\/(\w+)(:\w+)?@([\w\.-]+)(?::(\d+))?(\/.*)/;

function RavenConfigError(message) {
    this.name = 'RavenConfigError';
    this.message = message;
}
RavenConfigError.prototype = new Error();
RavenConfigError.prototype.constructor = RavenConfigError;

/**** Private functions ****/
function parseDSN(str) {
    var m = dsnPattern.exec(str),
        dsn = {},
        i = 7;

    try {
        while (i--) dsn[dsnKeys[i]] = m[i] || '';
    } catch(e) {
        throw new RavenConfigError('Invalid DSN: ' + str);
    }

    if (dsn.pass)
        throw new RavenConfigError('Do not specify your private key in the DSN!');

    return dsn;
}

function isUndefined(what) {
    return typeof what === 'undefined';
}

function isFunction(what) {
    return typeof what === 'function';
}

function isString(what) {
    return typeof what === 'string';
}

function isEmptyObject(what) {
    for (var k in what) return false;
    return true;
}

/**
 * hasKey, a better form of hasOwnProperty
 * Example: hasKey(MainHostObject, property) === true/false
 *
 * @param {Object} host object to check property
 * @param {string} key to check
 */
function hasKey(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function each(obj, callback) {
    var i, j = obj.length;

    if (isUndefined(j)) {
        for (i in obj) {
            if (hasKey(obj, i)) {
                callback.call(null, i, obj[i]);
            }
        }
    } else if (j) {
        for (i = 0; i < j; i++) {
            callback.call(null, i, obj[i]);
        }
    }
}


function setAuthQueryString() {
    authQueryString =
        '?version=6' +
        '&client=raven-js/' + Raven.VERSION +
        '&key=' + globalKey;
}


function handleStackInfo(stackInfo, isWindowError, options) {
    var frames = [];

    if (stackInfo.stack && stackInfo.stack.length) {
        each(stackInfo.stack, function(_, stack) {
            var frame = normalizeFrame(stack);
            if (frame) {
                frames.push(frame);
            }
        });
    }

    triggerEvent('handle', {
        stackInfo: stackInfo
    });

    processException(
        stackInfo.name,
        stackInfo.message,
        stackInfo.url,
        stackInfo.lineno,
        frames,
        isWindowError,
        options
    );
}

function normalizeFrame(frame) {
    if (!frame.url) return;

    // normalize the frames data
    var normalized = {
        filename:   frame.url,
        lineno:     frame.line,
        colno:      frame.column,
        'function': frame.func || '?'
    }, context = extractContextFromFrame(frame), i;

    if (context) {
        var keys = ['pre_context', 'context_line', 'post_context'];
        i = 3;
        while (i--) normalized[keys[i]] = context[i];
    }

    normalized.in_app = !( // determine if an exception came from outside of our app
        // first we check the global includePaths list.
        !globalOptions.includePaths.test(normalized.filename) ||
        // Now we check for fun, if the function name is Raven or TraceKit
        /(Raven|TraceKit)\./.test(normalized['function']) ||
        // finally, we do a last ditch effort and check for raven.min.js
        /raven\.(min\.)js$/.test(normalized.filename)
    );

    return normalized;
}

function extractContextFromFrame(frame) {
    // immediately check if we should even attempt to parse a context
    if (!frame.context || !globalOptions.fetchContext) return;

    var context = frame.context,
        pivot = ~~(context.length / 2),
        i = context.length, isMinified = false;

    while (i--) {
        // We're making a guess to see if the source is minified or not.
        // To do that, we make the assumption if *any* of the lines passed
        // in are greater than 300 characters long, we bail.
        // Sentry will see that there isn't a context
        if (context[i].length > 300) {
            isMinified = true;
            break;
        }
    }

    if (isMinified) {
        // The source is minified and we don't know which column. Fuck it.
        if (isUndefined(frame.column)) return;

        // If the source is minified and has a frame column
        // we take a chunk of the offending line to hopefully shed some light
        return [
            [],  // no pre_context
            context[pivot].substr(frame.column, 50), // grab 50 characters, starting at the offending column
            []   // no post_context
        ];
    }

    return [
        context.slice(0, pivot),    // pre_context
        context[pivot],             // context_line
        context.slice(pivot + 1)    // post_context
    ];
}

function noop() {}

function processException(type, message, fileurl, lineno, frames, isWindowError, options) {
    var stacktrace, label, i,
        callback = options && options.cb || noop;

    // Sometimes an exception is getting logged in Sentry as
    // <no message value>
    // This can only mean that the message was falsey since this value
    // is hardcoded into Sentry itself.
    // At this point, if the message is falsey, we bail since it's useless
    if (!message) return callback(true);

    if (globalOptions.ignoreErrors.test(message)) return callback(true);

    if (frames && frames.length) {
        fileurl = first(frames).filename || fileurl;
        // Sentry expects frames oldest to newest
        // and JS sends them as newest to oldest
        frames.reverse();
        stacktrace = {frames: frames};
    } else if (fileurl) {
        stacktrace = {
            frames: [{
                filename: fileurl,
                lineno: lineno
            }]
        };
    }

    if (globalOptions.ignoreUrls && globalOptions.ignoreUrls.test(fileurl)) return callback(true);
    if (globalOptions.whitelistUrls && !globalOptions.whitelistUrls.test(fileurl)) return callback(true);

    label = lineno ? message + ' at ' + lineno : message;

    Raven.addAction({
        type: 'exception',
        exc_type: type,
        value: message,
        culprit: fileurl,
        message: label,
        stacktrace: stacktrace
    });

    // Fire off the callback
    callback(false);

    // if the error is from window.onerror, we need to treat it as significant
    // and actually send it to Sentry. Normally, this is handled within
    // Raven.captureException, but window.onerror won't trigger that.
    if (isWindowError) {
        capture(options);
    }
}

function objectMerge(obj1, obj2) {
    if (!obj2) {
        return obj1;
    }
    each(obj2, function(key, value){
        obj1[key] = value;
    });
    return obj1;
}

function resolve(obj, val) {
    try {
        each(val.split('.'), function(_, val) {
            obj = obj[val];
        });
    } catch(e) {
        // Something didn't resolve correctly,
        // so explicitly return undefined
        return;
    }
    return obj;
}

function getHttpData() {
    var http = {
        type: 'http_request',
        url: doc.location.href,
        headers: {
            'User-Agent': navigator.userAgent
        }
    };

    if (doc.referrer) {
        http.headers.Referer = doc.referrer;
    }

    return http;
}

function getExtraBrowserData() {
    var props = [
            // obj,   name,      props
            [window, 'window', ['innerHeight', 'innerWidth']],
            [document, 'document', []]
        ],
        data = {};

    each(props, function(_, vals) {
        var prop = first(vals), name = vals[1];
        each(vals[2], function(_, val) {
            var resolved = resolve(prop, val);
            if (!isUndefined(resolved)) {
                data[name + '.' + val] = resolved;
            }
        });
    });

    return data;
}

function first(array) {
    return array[0];
}

function last(array) {
    return array[array.length - 1];
}

function capture(options) {
    if (!isSetup() || !timeline.length) return;

    var data = objectMerge({
        logger: globalOptions.logger,
        site: globalOptions.site,
        transaction: globalOptions.transaction,
        platform: 'javascript',
        events: timeline,
    }, options);

    var significantEvent = last(timeline);

    each(['culprit', 'message'], function(_, arg) {
        if (isUndefined(data[arg]) && !isUndefined(significantEvent[arg])) {
            data[arg] = significantEvent[arg];
        }
    });

    // Merge in the tags and extra separately since objectMerge doesn't handle a deep merge
    data.tags = objectMerge(globalOptions.tags, data.tags);
    data.extra = objectMerge(getExtraBrowserData(), objectMerge(globalOptions.extra, data.extra));

    // If there are no tags, strip the key from the payload alltogther.
    if (isEmptyObject(data.tags)) delete data.tags;

    if (globalUser) {
        // sentry.interfaces.User
        data.user = globalUser;
    }

    if (isFunction(globalOptions.dataCallback)) {
        data = globalOptions.dataCallback(data);
    }

    // Check if the request should be filtered or not
    if (isFunction(globalOptions.shouldSendCallback) && !globalOptions.shouldSendCallback(data)) {
        return;
    }

    // Send along an event_id if not explicitly passed.
    // This event_id can be used to reference the error within Sentry itself.
    // Set lastEventId after we know the error should actually be sent
    lastEventId = data.id || (data.id = uuid4());

    send(data);

    timeline = [];
}


function send(data) {
    var img = new Image(),
        src = globalServer + authQueryString + '&data=' + encodeURIComponent(JSON.stringify(data));

    img.onload = function success() {
        triggerEvent('success', {
            data: data,
            src: src
        });
    };
    img.onerror = img.onabort = function failure() {
        triggerEvent('failure', {
            data: data,
            src: src
        });
    };
    img.src = src;
}

function isSetup() {
    if (!hasJSON) return false;  // needs JSON support
    if (!globalServer) {
        if (window.console && console.error) {
            console.error("Error: Raven has not been configured.");
        }
        return false;
    }
    return true;
}

function joinRegExp(patterns) {
    // Combine an array of regular expressions and strings into one large regexp
    // Be mad.
    var sources = [],
        i = 0, len = patterns.length,
        pattern;

    for (; i < len; i++) {
        pattern = patterns[i];
        if (isString(pattern)) {
            // If it's a string, we need to escape it
            // Taken from: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions
            sources.push(pattern.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1"));
        } else if (pattern && pattern.source) {
            // If it's a regexp already, we want to extract the source
            sources.push(pattern.source);
        }
        // Intentionally skip other cases
    }
    return new RegExp(sources.join('|'), 'i');
}

// http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript/2117523#2117523
function uuid4() {
    return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random()*16|0,
            v = c == 'x' ? r : (r&0x3|0x8);
        return v.toString(16);
    });
}

function pad(number) {
    if (number < 10) return '0' + number;
    return number;
}

function nowISO() {
    var now = new Date();
    return now.getUTCFullYear() +
        '-' + pad(now.getUTCMonth() + 1) +
        '-' + pad(now.getUTCDate() ) +
        'T' + pad(now.getUTCHours() ) +
        ':' + pad(now.getUTCMinutes() ) +
        ':' + pad(now.getUTCSeconds() ) +
        '.' + (now.getUTCMilliseconds() / 1000).toFixed(3).slice(2, 5) +
        'Z';
}

function afterLoad() {
    // Attempt to initialize Raven on load
    var RavenConfig = window.RavenConfig;
    if (RavenConfig) {
        Raven.config(RavenConfig.dsn, RavenConfig.config).install();
    }

    Raven.addHttp();
}
afterLoad();
