/*
 * BioDigital Human RPC Messaging Client
 *
 * V2.0.0
 *
 * Built on 2016-07-14
 *
 * Copyright 2016, BioDigital, Inc.
 */

(function () {
    "use strict";

    var CLIENT_TYPES = {
        window: "WindowRPCClient",
        socket: "SocketRPCClient"
    };


    window.HumanAPI = function HumanAPI(params) {
        var self = this;

        if (typeof params === "string") {
            params = {
                iframeId: params
            };
        }

        var type = params.type || "window";

        params.onReady = function() {
            self._ready = true;

            for (var i = 0, len = self._readyCallbacks.length; i < len; i++) {
                self._readyCallbacks[i]();
                self._readyCallbacks.length = 0;
            }
        };

        self._rpc = new HumanAPI[CLIENT_TYPES[type]](params);
        self._ready = false;
        self._readyCallbacks = [];
    };

    /**
     * Makes an RPC call to the Human.
     * @private
     * @param {String} proc Procedure name
     * @param {{}} params Procedure parameters
     * @param {function} [ok] Callback to fetch result returned by procedure
     */
    HumanAPI.prototype.call = function (proc, params, ok) {
        if (typeof params === "function") {
            ok = params;
            params = {};
        }

        this._rpc.call(proc, params || {}, ok);
    };

        /**
         * Subscribes to an event on the Human.
         * @param {String} event Event type
         * @param {function} ok Callback fired on the event
         * @private
         */
    HumanAPI.prototype.on = function (event, ok) {
        if (event === "human.ready") {
            if (this._ready) {
                ok();
            } else {
                this._readyCallbacks.push(ok);
            }
            return;
        }

        this._rpc.call("apiEvents.on", event, ok, false); // Stay subscribed
    };

    /**
     * Subscribes to the next occurrence of an event on the Human.
     * @param {String} event Event type
     * @param {function} ok Callback fired on the event
     * @private
     */
    HumanAPI.prototype.once = function (event, ok) {
        if (event === "human.ready") {
            if (this._ready) {
                ok();
            } else {
                this._readyCallbacks.push(ok);
            }
            return;
        }

        this._rpc.call("apiEvents.once", event, ok, true); // Unsubscribe
    };

})();
;(function () {

    "use strict";

    /*
     * @class Generic map of IDs to items - can generate own IDs or accept given IDs. IDs should be strings in order to not
     * clash with internally generated IDs, which are numbers.
     * @private
     */
    HumanAPI.Map = function (items, _baseId) {

        /*
         * @property Items in this map
         */
        this.items = items || [];


        var baseId = _baseId || 0;
        var lastUniqueId = baseId + 1;

        /*
         * Adds an item to the map and returns the ID of the item in the map. If an ID is given, the item is
         * mapped to that ID. Otherwise, the map automatically generates the ID and maps to that.
         *
         * id = myMap.addItem("foo") // ID internally generated
         *
         * id = myMap.addItem("foo", "bar") // ID is "foo"
         *
         */
        this.addItem = function () {

            var item;

            if (arguments.length === 2) {

                var id = arguments[0];

                item = arguments[1];

                if (this.items[id]) { // Won't happen if given ID is string
                    throw "ID clash: '" + id + "'";
                }

                this.items[id] = item;

                return id;

            } else {

                while (true) {

                    item = arguments[0];
                    var findId = lastUniqueId++;

                    if (!this.items[findId]) {
                        this.items[findId] = item;
                        return findId;
                    }
                }
            }
        };

        /*
         * Removes the item of the given ID from the map
         */
        this.removeItem = function (id) {
            delete this.items[id];
        };
    };

})();
;(function () {

    "use strict";

    /*
     * Client strategy for Web Socket connection with remote Human
     *
     * @param cfg
     * @param cfg.url URL of WebSocket server
     * @param cfg.port Port on WebSocket server
     * @param cfg.channel Socket channel to cubscribe to
     * @param cfg.onConnected Callback fired when connected to Human
     * @param cfg.onUnsupported Callback fired if Human is not supported in browser
     * @param cfg.onError Callback fired on Human internal error
     * @param cfg.onReady Callback fired when Human is ready
     * @constructor
     * @private
     */
    HumanAPI.SocketRPCClient = function (cfg) {

        if (!cfg.url) {
            throw "config expected: url";
        }

        this.url = cfg.url;

        if (!cfg.port) {
            throw "config expected: port";
        }

        this.port = cfg.port;

        if (!cfg.channel) {
            throw "config expected: channel";
        }

        this.channel = cfg.channel;

        if (!cfg.onConnected) {
            throw "callback expected: onConnected";
        }

        // Fired when Human reports that browser lacks support
        if (!cfg.onUnsupported) {
            throw "callback expected: onUnsupported";
        }

        if (!cfg.onError) {
            throw "callback expected: onError";
        }

        // Fired when Human started
        if (!cfg.onReady) {
            throw "callback expected: onReady";
        }

        /* True as soon as API is destroyed
         * @type {boolean}
         */
        this.destroyed = false;

        // RPC results pub/sub
        this._resultHandleMap = new HumanAPI.Map({}, (new Date()).getTime()); // Response subscription handle pool
        this._resultSubs = {}; // Map of handles to callbacks

        // Set true as soon as this client is connected to the socket
        this._connected = false;

        // Set true as soon as Human sends over notification of readiness
        this._ready = false;

        // Buffers Human-bound messages while connected != true
        this._messageBufferUntilConnected = [];

        // Buffers Human-bound messages while ready != true
        this._messageBufferUntilReady = [];

        // The WebSocket
        this._socket = null;

        var self = this;


        // Load Socket IO library

        this._loadSocketIO(cfg.url, cfg.port,

            function () {

                var requestConnectFrequency = 500; // Request Human connection every 500ms until granted. Too fast? Too slow?
                var requestConnectHandle = null; // Handle to connection request interval

                // Socket IO library loaded.
                // 'io' is the global namespace created by Socket.IO

                // Attempt to connect to socket

                self._socket = io.connect(cfg.url + ":" + cfg.port);  // 'io' is defined by script loaded from https://api.biodigitalhuman.com:443/socket.io/socket.io.js

                // Bind response handler to socket

                self._socket.on('response',
                    function (data) {

                        if (!data) {

                            // Sometimes we get spurious null "messages" through WebSocket, not sure why
                            return;
                        }

                        if (data.message) {

                            // Message from Human

                            var message = data.message;

                            switch (message) {

                                case "connected":

                                    // Human accepts connection

                                    if (self._connected) {

                                        // API fired continuous connection requests, Human may reply to each of them.
                                        // Accept only the first one.
                                        return;
                                    }

                                    self._connected = true;

                                    // Stop firing connect requests

                                    if (requestConnectHandle) {
                                        clearInterval(requestConnectHandle);
                                        requestConnectHandle = null;
                                    }

                                    // Fire messages that were buffered until connected

                                    self._sendQueuedMessages(true);

                                    cfg.onConnected();

                                    break;

                                case "error":

                                    // Human reports internal error

                                    cfg.onError(data.message);

                                    break;

                                case "unsupported":

                                    // Human reports missing browser support

                                    cfg.onUnsupported(data.message);

                                    break;

                                case "ready":

                                    // Human reports readiness

                                    if (self._ready) {

                                        // Human has already reported readiness
                                        return;
                                    }

                                    self._ready = true;

                                    // Fire messages buffered until Human ready

                                    self._sendQueuedMessages();

                                    cfg.onReady();

                                    break;
                            }
                        }

                        if (data.results) {

                            // Human returns results of prior RPC call

                            var results = data.results;
                            var packet;
                            for (var key in results) { // For each packet in results
                                if (results.hasOwnProperty(key)) {
                                    packet = results[key];
                                    if (self._resultSubs[key]) { // Subscription exists to this packet
                                        self._setResult(key, packet); // Publish the packet
                                    }
                                }
                            }
                        }
                    });

                self._socket.on('connect',
                    function () {
                        // Connected to socket.
                        // Subscribe to messages from the socket
                        self._socket.emit('subscribe', self.channel);
                    });

								self._socket.on('status', function () {});


                // Begin periodically firing connection requests through the socket at Human

                requestConnectHandle = setInterval(function () {
                    if (self.destroyed) {
                        clearInterval(requestConnectHandle);
                        requestConnectHandle = null;
                        return;
                    }
                    self._socket.emit("sendmsg", self.channel, { action: "connect" });
                }, requestConnectFrequency);

            });
    };

    HumanAPI.SocketRPCClient.prototype._loadSocketIO = function (url, port, ok) {
        var socketIOURL = url + ":" + port + "/socket.io/socket.io.js";
        var el = document.createElement('script');
        el.type = 'text/javascript';
        el.src = socketIOURL;
        el.onload = function () {
            ok();
        };

        document.body.appendChild(el);
    };

    /*
     * Makes an RPC call to Human
     * @param proc
     * @param params
     * @param ok
     * @param once
     */
    HumanAPI.SocketRPCClient.prototype.call = function (proc, params, ok, once) {

        // Package the call as a message
        var message = { call: proc, params: params, ok: ok, once: once };

        if (this._ready || (this._connected && params.connected)) {

            // Human ready and connection established, fire message straight over to Human

            this._send(message, ok, once);

        } else {

            // Human not ready - buffer to send when ready

            // Select which outgoing buffer to use
            var buffer = params.connected ? this._messageBufferUntilConnected : this._messageBufferUntilReady;

            buffer.unshift(message);
        }
    };

    HumanAPI.SocketRPCClient.prototype._send = function (message, ok, once) {

        if (ok) {

            // Subscribing to response

            var self = this;

            var handle = this._onResult(
                function (data) {
                    if (ok) {
                        ok.call(self, data);
                    }
                    if (once) {
                        self._offResult(handle);
                    }
                });

            message.id = handle;

            this._sendMessage(message);

        } else {

            // Not subscribing to response

            this._sendMessage(message);
        }
    };

    HumanAPI.SocketRPCClient.prototype._sendMessage = function (message) {
        this._socket.emit('sendmsg', this.channel, message);
    };

    HumanAPI.SocketRPCClient.prototype._sendQueuedMessages = function (connected) {
        var buffer = connected ? this._messageBufferUntilConnected : this._messageBufferUntilReady;
        while (buffer.length > 0) {
            var message = buffer.pop();
            this._send(message, message.ok, message.once);
        }
    };

    HumanAPI.SocketRPCClient.prototype._setResult = function (handle, pub) {
        var sub = this._resultSubs[handle];
        if (sub) {
            sub.call(this, pub);
        }
    };

    HumanAPI.SocketRPCClient.prototype._onResult = function (callback) {
        var handle = this._resultHandleMap.addItem(); // Create unique handle
        this._resultSubs[handle] = callback;
        return handle;
    };

    HumanAPI.SocketRPCClient.prototype._offResult = function (handle) {
        delete this._resultSubs[handle];
        this._resultHandleMap.removeItem(handle);
    };

    HumanAPI.SocketRPCClient.prototype.destroy = function () {
        this.destroyed = true;
    };

}());
;(function () {

    "use strict";

    /*
     * Client for connection with remote Human using cross-window messaging
     * @param cfg
     * @constructor
     * @private
     */
    HumanAPI.WindowRPCClient = function (cfg) {

        if (!cfg.iframeId) {
            throw "config expected: iframeId";
        }

        this._iframe = document.getElementById(cfg.iframeId);

        if (!this._iframe) {
            throw "iframe not found: '" + cfg.iframeId + "'";
        }

        if (!this._iframe.contentWindow) {
            throw "element is not an iframe: '" + cfg.iframeId + "'";
        }

        /* True as soon as API is destroyed
         * @type {boolean}
         */
        this.destroyed = false;

        // Pub/sub
        this._handleMap = new HumanAPI.Map({}, Date.now()); // Subscription handle pool
        this._subs = {}; // Map of handles to callbacks

        // Set true as soon as Human sends over notification of readiness
        this._ready = false;

        // Buffers Human-bound messages while ready != true
        this._messageBuffer = [];

        // Buffers Human-bound messages while connected != true
        this._messageBufferConnected = [];

        this._connect(cfg.onUnsupported, cfg.onConnected, cfg.onReady);
    };


    /*
     * Connect with Human
     * @private
     */
    HumanAPI.WindowRPCClient.prototype._connect = function (onUnsupported, onConnected, onReady) {

        var interval = null;

        var self = this;

        // Poll human to connect
        var pollInterval = 100; // ms
        var startPoll = function () {
            stopPoll();
            interval = setInterval(function () {
                if (self.destroyed || !self._iframe || !self._iframe.contentWindow) {
                    stopPoll();
                    return;
                }
                self._iframe.contentWindow.postMessage(JSON.stringify({ action: "connect" }), "*");
            }, pollInterval);
        };

        // Stop polling to connect
        var stopPoll = function () {
            if (!!interval) {
                clearInterval(interval);
                interval = null;
            }
        };

        // Listen for message from Human
        window.addEventListener('message',
            function (event) {
                var dataStr = event.data;

                switch (dataStr) {

                    case "unsupported":
                        if (typeof onUnsupported === "function") {
                            onUnsupported(event.data);
                        }
                        break;

                    default: // JSON response
                        var data;
                        try {
                            data = JSON.parse(dataStr);
                        } catch (e) {
                            // Not JSON
                            return;
                        }

                        // Message
                        if (data.message) {
                            var message = data.message;
                            switch (message) {
                                case "connected": //Window notifies it's connected, before Human is ready
                                    self._connected = true;
                                    self._sendQueuedMessages(true);
                                    if (typeof onConnected === "function") {
                                        onConnected();
                                    }
                                    break;
                                case "status":
                                    switch (data.status) {
                                        case "ready": // Human notifies of readiness
                                            self._ready = true;
                                            stopPoll(); // Stop polling for connection
                                            self._sendQueuedMessages();
                                            if (typeof onReady === "function") {
                                                onReady();
                                            }
                                        break;
                                    }
                            }
                        }

                        // RPC call results
                        if (data.results || data.response) {
                            var results = data.results || data.response;
                            var packet;
                            for (var key in results) { // For each packet in results
                                if (results.hasOwnProperty(key)) {
                                    packet = results[key];
                                    if (self._subs[key]) { // Subscription exists to this packet
                                        self.set(key, packet); // Publish the packet
                                    }
                                }
                            }
                        }

                        // Error
                        if (data.error) {}
                        break;
                }
            }, false);

        // init/suspend polling based on iframe state
        self._iframe.addEventListener("load", startPoll);
        self._iframe.addEventListener("unload", stopPoll);

        // Start periodically pinging Human with a connect message
        startPoll();
    };

    HumanAPI.WindowRPCClient.prototype._sendQueuedMessages = function (connected) {
        var buffer = connected ? this._messageBufferConnected : this._messageBuffer;

        while (buffer.length > 0) {
            var message = buffer.pop();
            this._send(message, message.ok, message.once);
        }
    };

    /*
     * Makes an RPC call to Human
     * @param proc
     * @param params
     * @param ok
     * @param once
     */
    HumanAPI.WindowRPCClient.prototype.call = function (proc, params, ok, once) {
        var message = { call: proc, params: params, ok: ok, once: once };

        var buffer = params.connected ?
            this._messageBufferConnected : this._messageBuffer;

        if (this._ready || (this._connected && params.connected)) {
            this._send(message, ok, once);
        } else { // Human not ready - buffer to send when ready
            buffer.unshift(message);
        }
    };

    HumanAPI.WindowRPCClient.prototype._send = function (message, ok, once) {
        if (ok) {
            // Subscribing to results
            var self = this;
            var handle = this._on(
                function (data) {
                    if (once === undefined || once === true) {
                        self._off(handle);
                    }
                    ok.call(self, data);
                });
            message.id = handle;
            this._sendMessage(message);
        } else {
            // Don't care about results
            this._sendMessage(message);
        }
    };

    HumanAPI.WindowRPCClient.prototype._sendMessage = function (message) {
        if (this._onSend) {
            this._onSend(message);
        }
        if (this.destroyed) {
            return;
        }
        this._iframe.contentWindow.postMessage(JSON.stringify(message), "*");
    };

    HumanAPI.WindowRPCClient.prototype.set = function (handle, pub) {
        var sub = this._subs[handle];
        if (sub) {
            sub.call(this, pub);
        }
    };

    HumanAPI.WindowRPCClient.prototype._on = function (callback) {
        var handle = this._handleMap.addItem(); // Create unique handle
        this._subs[handle] = callback;
        return handle;
    };

    HumanAPI.WindowRPCClient.prototype._off = function (handle) {
        delete this._subs[handle];
        this._handleMap.removeItem(handle);
    };

    HumanAPI.WindowRPCClient.prototype.destroy = function () {
        this.destroyed = true;
    };

})();
