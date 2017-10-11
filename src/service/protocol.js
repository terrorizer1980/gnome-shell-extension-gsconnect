"use strict";

// Imports
const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_parent().get_path();
}

imports.searchPath.push(getPath());

const Common = imports.common;


// Packet Types
var TYPE_IDENTITY = "kdeconnect.identity";
var TYPE_PAIR = "kdeconnect.pair";


/**
 * Packets
 */
var Packet = new Lang.Class({
    Name: "GSConnectPacket",
    Extends: GObject.Object,
    
    _init: function (data=false) {
        this.parent();
        
        this.id = Date.now();
        this.type = "";
        this.body = {};
        
        if (data === false) {
            return;
        } else if (typeof data === "string") {
            this.fromData(data);
        } else if (typeof data === "object") {
            this.fromPacket(data);
        } else {
            log("Error: unsupported packet source: " + typeof data);
        }
    },
    
    _check: function (obj) {
        if (!obj.hasOwnProperty("type")) {
            Common.debug("Packet: missing 'type' field");
            return false;
        } else if (!obj.hasOwnProperty("body")) {
            Common.debug("Packet: missing 'body' field");
            return false;
        } else if (!obj.hasOwnProperty("id")) {
            Common.debug("Packet: missing 'id' field");
            return false;
        }
        
        return true;
    },
    
    fromData: function (data) {
        let json;
        
        try {
            json = JSON.parse(data);
        } catch (e) {
            log(e);
            log("Data: '%s'".format(data));
            return;
        }
        
        if (this._check(json)) {
            Object.assign(this, json);
        } else {
            throw Error("Packet.fromData(): Malformed packet");
        }
    },
    
    fromPacket: function (packet) {
        if (this._check(packet)) {
            Object.assign(this, {
                id: Date.now(),
                type: packet.type,
                body: JSON.parse(JSON.stringify(packet.body))
            });
        } else {
            throw Error("Packet.fromPacket(): Malformed packet");
        }
    },
    
    toData: function () {
        this.id = Date.now();
        return JSON.stringify(this) + "\n";
    },
    
    toString: function () {
        return JSON.stringify(this);
    }
});


/**
 * Data Channels
 */
var LanChannel = new Lang.Class({
    Name: "GSConnectLanChannel",
    Extends: GObject.Object,
    Signals: {
        "connected": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        },
        "disconnected": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        },
        "received": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_OBJECT ]
        }
    },
    
    _init: function (device, port=false) {
        this.parent();
        this.device = device;
        
        this.addr = new Gio.InetSocketAddress({
            address: Gio.InetAddress.new_from_string(
                device.identity.body.tcpHost
            ),
            port: (port) ? port : device.identity.body.tcpPort
        });
        
        this._listener = null;
        this._connection = null;
        this._in = null;
        this._out = null;
        this._monitor = 0;
        this._peer_cert = null;
    },
    
    // Send identity packet, indicating we're about ready for a handshake
    _sendIdent: function () {
        let _out = new Gio.DataOutputStream({
            base_stream: new Gio.UnixOutputStream({
                fd: this._connection.socket.fd,
                close_fd: false
            })
        });
        _out.put_string(this.device.daemon.identity.toData(), null);
        _out.close(null);
    },
    
    // Set socket options
    _initSocket: function () {
        this._connection.socket.set_keepalive(true);
        // TCP_KEEPIDLE: time to start sending keepalive packets (seconds)
        this._connection.socket.set_option(6, 4, 10);
        // TCP_KEEPINTVL: interval between keepalive packets (seconds)
        this._connection.socket.set_option(6, 5, 5);
        // TCP_KEEPCNT: number of missed keepalive packets before disconnecting
        this._connection.socket.set_option(6, 6, 3);
    },
    
    // Wrap connection in TlsServerConnection and handshake
    _initTls: function (client=false) {
        if (client) {
            this._connection = Gio.TlsClientConnection.new(
                this._connection,
                this._connection.socket.remote_address
            );
            this._connection.set_certificate(this.device.daemon.certificate);
        } else {
            this._connection = Gio.TlsServerConnection.new(
                this._connection,
                this.device.daemon.certificate
            );
        }
        
        this._connection.validation_flags = 0;
        this._connection.authentication_mode = 1;
        
        this._connection.connect(
            "accept-certificate",
            Lang.bind(this, this._accept_certificate)
        );
        
        this._connection.handshake_async(
            GLib.PRIORITY_DEFAULT,
            null,
            Lang.bind(this, this.opened)
        );
    },
    
    // Negotitate certificate/pairing
    _accept_certificate: function (conn, peer_cert, flags) {
        if (this.device.paired) {
            let paired_cert = Gio.TlsCertificate.new_from_file(
                this.device.config_cert
            );
            this._peer_cert = peer_cert;
            
            return (paired_cert.verify(null, peer_cert) === 0);
        } else {
            this._peer_cert = peer_cert;
            return true;
        }
    },
    
    // Open input/output streams
    _initStreams: function () {
        this._in = new Gio.DataInputStream({
            base_stream: this._connection.input_stream,
            newline_type: Gio.DataStreamNewlineType.LF
        });
        
        this._out = new Gio.DataOutputStream({
            base_stream: this._connection.output_stream
        });
    },
    
    // Monitor the input stream for packets
    _initMonitor: function () {
        this._monitor = this._in.base_stream.create_source(null);
        this._monitor.set_callback((condition) => {
            let result = this.receive();
            if (!result) { this.close(); }
            return result;
        });
        this._monitor.attach(null);
        
        return true;
    },
    
    /**
     * Public Methods
     */
    open: function () {
        log("Connecting to '" + this.device.name + "'");
        
        let client = new Gio.SocketClient();
        client.connect_async(this.addr, null, Lang.bind(this, this.auth));
    },
    
    auth: function (client, res) {
        log("Authenticating '" + this.device.name + "'");
        
        try {
            this._connection = client.connect_finish(res);
            this._initSocket();
            this._sendIdent();
            this._initTls();
        } catch (e) {
            log("Error connecting: " + e);
            this.close();
            return false;
        }
    },
    
    opened: function (connection, res) {
        try {
            this._connection.handshake_finish(res);
            this._initStreams();
            this._initMonitor();
        } catch (e) {
            log("Error connecting: " + e);
            this.close();
            return false;
        }
        
        this.emit("connected");
        return true;
    },
    
    close: function () {
        if (this._monitor > 0) {
            Gio.Source.remove(this._monitor);
            this._monitor = 0;
        }
        
        try {
            if (this._in !== null) {
                this._in.close(null);
            }
        } catch (e) {
            log("error closing data input: " + e);
        }
        
        try {
            if (this._out !== null) {
                this._out.close(null);
            }
        } catch (e) {
            log("error closing data output: " + e);
        }
        
        try {
            if (this._connection !== null) {
                this._connection.close(null);
            }
        } catch (e) {
            log("error closing connection: " + e);
        }
        
        try {
            if (this._listener !== null) {
                this._listener.close(null);
            }
        } catch (e) {
            log("error closing listener: " + e);
        }
        
        this._in = null;
        this._out = null;
        this._connection = null;
        this._listener = null;
        
        this.emit("disconnected");
    },
    
    send: function (packet) {
        Common.debug("LanChannel.send(" + packet.toString() + ")");
    
        try {
            this._out.put_string(packet.toData(), null);
        } catch (e) {
            log("error sending packet: " + e);
            // TODO: disconnect? check kdeconnect code
        }
    },
    
    receive: function () {
        Common.debug("LanChannel.receive(" + this.device.id + ")");
        
        let data, len, packet;
        
        try {
            [data, len] = this._in.read_line(null);
            Common.debug("Device received: " + data);
        } catch (e) {
            log("Failed to receive packet: " + e);
            return false;
        }
        
        if (data === null || data === undefined || !data.length) {
            return false;
        }
        
        packet = new Packet(data.toString());
        this.emit("received", packet);
        return true;
    },
    
    transfer: function () {
        this._transferRead();
    }
});


/**
 * File Transfers
 * TODO: errors
 */
var Transfer = new Lang.Class({
    Name: "GSConnectTransfer",
    Extends: GObject.Object,
    Signals: {
        "started": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        },
        "progress": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_INT ]
        },
        "cancelled": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        },
        "failed": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_STRING ]
        },
        "succeeded": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        }
    },
    
    _init: function (srcStream, destStream, size) {
        this.parent();
        
        this._in = srcStream;
        this._out = destStream;
        this._cancellable = new Gio.Cancellable();
        
        this.id = GLib.uuid_string_random();
        this.size = size;
        this.bytesWritten = 0;
    },
    
    _read: function () {
        Common.debug("Transfer: _read()");
        
        if (this._cancellable.is_cancelled()) { return; }
        
        this._in.read_bytes_async(
            4096,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (source, res) => {
                let bytes = source.read_bytes_finish(res);
                
                if (bytes.get_size()) {
                    this._write(bytes);
                } else {
                    
                    // FIXME: better
                    if (this.bytesWritten < this.size) {
                        this.emit("failed", "Failed to complete transfer");
                    } else {
                        this.emit("succeeded");
                        log("Completed transfer of " + this.size + " bytes");
                    }
                }
            }
        );
    },
    
    _write: function (bytes) {
        Common.debug("LanChannel: _write()");
        
        if (this._cancellable.is_cancelled()) { return; }
        
        this._out.write_bytes_async(
            bytes,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (source, res) => {
                this.bytesWritten += source.write_bytes_finish(res);
                this.emit("progress", (this.bytesWritten / this.size) * 100);
                this._read();
            }
        );
    },
    
    start: function () {
        this.emit("started");
        this._read();
    },
    
    cancel: function () {
        this._cancellable.cancel();
        this.emit("cancelled");
    }
});


var LanDownloadChannel = new Lang.Class({
    Name: "GSConnectLanDownloadChannel",
    Extends: LanChannel,
    
    _init: function (device, port, fileStream) {
        this.parent(device, port);
        
        this._out = fileStream;
    },
    
    auth: function (client, res) {
        try {
            this._connection = client.connect_finish(res);
            this._initSocket();
            this._initTls(true);
        } catch (e) {
            log("Error connecting: " + e);
            this.close();
            return false;
        }
    },
    
    opened: function (connection, res) {
        Common.debug("TransferChannel.opened(" + this.device.id + ")");
        
        try {
            this._in = this._connection.get_input_stream();
        } catch (e) {
            log("Error connecting: " + e);
            this.close();
            return false;
        }
        
        this.emit("connected");
    }
});


var LanUploadChannel = new Lang.Class({
    Name: "GSConnectLanUploadChannel",
    Extends: LanChannel,
    Signals: {
        "listening": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED
        }
    },
    
    _init: function (device, port, srcStream) {
        this.parent(device, port);
        
        this._in = srcStream;
        this._port = port;
    },
    
    open: function () {
        this._listener = new Gio.SocketListener();
        
        while (true) {
            try {
                this._listener.add_inet_port(this._port, null);
            } catch (e) {
                if (this._port < 1764) {
                    this._port += 1;
                } else {
                    throw Error("Failed to open port");
                }
            }
            
            break;
        }
        
        this._listener.accept_async(null, Lang.bind(this, this.auth));
        
        this.emit("listening");
    },
    
    auth: function (listener, res) {
        Common.debug("TransferChannel.opened(" + this.device.id + ")");
        
        try {
            let src;
            [this._connection, src] = this._listener.accept_finish(res);
            this._initSocket();
            this._initTls();
        } catch (e) {
            log("Error connecting: " + e);
            this.close();
            return false;
        }
    },
    
    opened: function (connection, res) {
        try {
            this._connection.handshake_finish(res);
            this._out = this._connection.get_output_stream();
        } catch (e) {
            log("Error connecting: " + e);
            this.close();
            return false;
        }
        
        this.emit("connected");
    }
});


