import { EventTarget } from "event-target-shim";

import vCardParser from "vcard-parser";

import { Response, LoginToDeviceResponse,
         LoginToDeviceCommand, Credentials,
         DialSessionCommand,  DialResponse,
         DIAL_TYPE_SDP, DIAL_TYPE_ICE, DIAL_TYPE_DONE } from "./FlockProtocol.js";
import { FlockConnection } from "./FlockConnection.js";
import { BufferParser } from "./Buffer.js";
import { SocketType,
         RequestAppControlMessage, RequestAppControlResponse,
         ConnectAppControlRequest, ConnectAppControlResponse } from "./SocketProxy.js";

const BUFFERED_AMOUNT_LOW_THRESHOLD = 4096 * 4;

export class FlockConnectionNotOpenError extends Error {
    constructor () {
        super();
        this.message = "Connection not open";
    }
}

export class AppNotOpenedError extends Error {
    constructor (app_name) {
        super();
        this.message = "The application " + app_name + " is not open";
    }
}

class FlockOpenEvent {
    constructor() {
        this.type = "open";
    }
};

class FlockErrorEvent {
    constructor(line) {
        this.type = "error";
        this.line = line;
    }
};

class FlockNeedsApplianceEvent {
    constructor(flk) {
        this.type = 'needs-appliance';
        this.flock = flk;
    }
}

class FlockNeedsPersonasEvent {
    constructor(flk) {
        this.type = 'needs-personas';
        this.flock = flk;
    }
}

class ChannelOpens {
    constructor (flk) {
        this.type = '-channel-opens';
        this.flock = flk;
    }
}

export class ApplicationDeniedError {
    constructor ( app_name, reason ) {
        this.app_name = app_name;
        this.reason = reason;
    }
}

export class FlockSocketOpensEvent {
    constructor ( sk ) {
        this.type = 'open';
        this.socket = sk;
    }
}

export class FlockSocketErrorEvent {
    constructor ( sk, err, explanation ) {
        this.type = 'error';
        this.socket = sk;
        this.error = err;

        if ( explanation !== undefined )
            this.explanation = explanation;
    }
}

export class FlockSocketClosesEvent {
    constructor ( sk ) {
        this.type = 'close';
        this.socket = sk;
    }
}

export class FlockSocketDataEvent {
    constructor ( sk, data ) {
        this.type = 'data';
        this.socket = sk;
        this.data = data;
    }
}

const SOCKET_MAX_MTU = 32768;
export class FlockSocket extends EventTarget {
    constructor ( flock_conn, endpoint ) {
        super();
        this.conn = flock_conn;
        this.state = 'connecting';
        this.endpoint = endpoint;

        if ( this.conn.sctp )
            this.maxMessageSize = this.conn.sctp.maxMessageSize;
        else
            this.maxMessageSize = 1024 * 1024;

        switch ( endpoint.type ) {
        case 'tcp':
            this.data_chan = this.conn.newDataChannel({});
            this.stream = true;
            this.start_connection = () => { this.start_tcp(endpoint.port); };
            break;
        case 'udp':
            var end_udp = () => { this.removeEventListener('open', end_udp); this.end_udp(); }
            this.data_chan = this.conn.newDataChannel({ ordered: false,
                                                        maxRetransmits: 0 });
            this.retransmits_left = 7;
            this.retransmit_interval = 100;
            this.stream = false;
            this.start_connection = () => { this.start_udp(endpoint.port); };
            this.addEventListener('open', end_udp);
            break;
        default:
            throw new InvalidProtocolName(endpoint.type);
        }

        this.data_chan.onopen = () => {
            this.start_connection();
        }

        this.data_chan.onclose = () => {
            this.dispatchEvent(new FlockSocketClosesEvent(this));
        }

        this.data_chan.onmessage = (e) => {
            //console.log("Got message in socket", e.data);
            switch ( this.state ) {
            case 'connecting':
                // Check to see if the connection is valid; if it is, set state to connected
                var parser = new BufferParser(e.data);
                var rsp = new ConnectAppControlResponse(parser);
                if ( rsp.error ) {
                    console.error("Got error while connecting", rsp.errno);
                    this.state = 'error';
                    this.dispatchEvent(new FlockSocketErrorEvent(this, 'system-error:' + rsp.errno));
                } else {
                    // console.log("Connected socket");
                    this.state = 'connected';
                    this.dispatchEvent(new FlockSocketOpensEvent(this));
                }
                break;
            case 'connected':
                this.dispatchEvent(new FlockSocketDataEvent(this, e.data));
                break;
            case 'disconnected':
                console.error("FlockSocket got message while disconnected");
                break;
            case 'error':
                console.warning("Ignaring data on errored FlockSocket");
                break;
            default:
                console.error("FlockSocket has invalid state ", this.state);
            }
        }
    }

    _normalizeData(data) {
        if ( data instanceof String || typeof data == 'string' ) {
            var enc = new TextEncoder();
            data = enc.encode(data).buffer;
        }
        return data;
    }

    send(data, onChunkSent) {
        const DATA_HDR_SZ = 5;

        if ( this.state == 'connected' ) {
            var buffer;
            data = this._normalizeData(data)
            if ( !(data instanceof ArrayBuffer) &&
                 !(data instanceof DataView) ) {
                throw new TypeError("data should be an ArrayBuffer or a string");
            }

            var buffer = new ArrayBuffer(Math.min(data.byteLength + DATA_HDR_SZ, SOCKET_MAX_MTU))
            var old_array
            if ( data instanceof DataView )
                old_array = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            else
                old_array = new Uint8Array(data)
            var new_array = new Uint8Array(buffer)

            var dv = new DataView(buffer);
            dv.setUint8(0, 0x0F);
            dv.setUint32(1, 0x0);

            var ofs = 0;
            while ( ofs < data.byteLength ) {
                var chunkLength = buffer.byteLength - DATA_HDR_SZ
                new_array.set(old_array.subarray(ofs, ofs + chunkLength), DATA_HDR_SZ);
                ofs += chunkLength

                if ( onChunkSent )
                    onChunkSent(ofs)

                this.data_chan.send(buffer);
            }

            if ( onChunkSent )
                onChunkSent(ofs)
        } else
            this.dispatchEvent(new FlockSocketErrorEvent(this, 0, "The socket was not connected"));
    }

    close() {
        this.data_chan.close()
        delete this.data_chan
    }

    waitForWrite(lowThreshold) {
        if ( lowThreshold === undefined )
            lowThreshold = 0

        return new Promise((resolve, reject) => {
            this.data_chan.bufferedAmountLowThreshold = lowThreshold
            this.data_chan.onbufferedamountlow = () => {
                this.data_chan.bufferedAmountLowThreshold = null
                this.data_chan.onbufferedamountlow = null
                resolve()
            }
        })
    }

    // Returns a promise of when the stream is sent
    sendStream( stream, onProgress ) {
        const MAX_CHUNK_SIZE = 1024 * 1024;
        return new Promise((resolve, reject) => {
            var reader = stream.getReader()
            var curChunk = null
            var sent = 0

            var sendNextChunk = (sentInThisLoop) => {
                console.log("Sending next chunk", this.data_chan.bufferedAmount, sentInThisLoop)
                this.data_chan.onbufferedamountlow = null;
                if ( this.data_chan.bufferedAmount > MAX_CHUNK_SIZE ) {
//                    console.log("Waiting for buffer", this.data_chan.bufferedAmount)
                    waitForMore()
                } else if ( sentInThisLoop > MAX_CHUNK_SIZE ) {
                    // If we've sent too much in this loop, use setTimeout to allow a chance to redraw
                    setTimeout(() => { sendNextChunk(0) }, 0)
                } else {
                    reader.read().then(({value, done}) => {
                        if ( done ) {
                            this.data_chan.bufferedAmountLowThreshold = 0;
                            this.data_chan.onbufferedamountlow = null;
                        } else {
                            var curChunk = this._normalizeData(value)
                            var startOfs = sent

                            this.send(curChunk)

                            if ( onProgress ) {
//                                console.log("Progress", sent + curChunk.byteLength)
                                onProgress(sent + curChunk.byteLength)
                            }
                            sent += curChunk.byteLength

                            sendNextChunk(sentInThisLoop + curChunk.byteLength)
                        }
                    })
                }
            }
            var waitForMore = () => {
                this.data_chan.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;
                this.data_chan.onbufferedamountlow = () => { sendNextChunk(0) };
            }

            sendNextChunk(0)
        })
//
//            var nextChunk = () => {
//               reader.read().then(({value, done}) => {
//                    if ( done ) {
//                        this.data_chan.onbufferedamountlow = null;
//                        resolve()
//                    } else {
//                        var curChunk = value
//                        var startOfs = sent
//                        var sendMore = () => {
//                        }
//                        console.log("Requesting space")
//                        this.data_chan.bufferedAmountLowThreshold = 4096;
//                        this.data_chan.onbufferedamountlow = () => {
//                            console.log('Sent chunk', curChunk)
//                            this.send(curChunk, (next) => {
//                                console.log("Got chunk", next)
//                                sent = startOfs + next
//                                if ( onProgress )
//                                    onProgress(sent)
//                            })
//                        }
//                        nextChunk()
//                    }
//                })
//            }
//            nextChunk()
//        })
    }

    send_connection_request(sk_type, port) {
        var req = new ConnectAppControlRequest(sk_type, port, this.endpoint.app);
        this.data_chan.send(req.write().toArrayBuffer());
    }

    start_tcp(port) {
        console.log("Starting TCP")
        this.send_connection_request(SocketType.SOCK_STREAM, port);
    }

    start_udp(port) {
        this.send_connection_request(SocketType.SOCK_DGRAM, port);

        this.retransmits_left -= 1;
        if ( this.retransmit_left > 0 ) {
            this.udp_retransmit_timer = setTimeout(this.retransmit_interval, () => { start_udp(port); });
            this.retransmit_interval *= 2;
        } else {
            this.state = 'disconnected';
            this.dispatchEvent(new FlockSocketErrorEvent(this, 'timeout'));
        }
    }

    end_udp() {
        clearTimeout(this.udp_retransmit_timer);
        delete this.udp_retransmit_timer;
    }
}

const FlockClientState = {
    Error: 'error',
    Connecting: 'connecting', // currently in the process of choosing an appliance
    Connected: 'connected', // connected to an appliance via a flock
    CollectingPersonas: 'collecting-personas',
    ReadyToLogin: 'ready-to-login', // personas collected, ready to log in
    StartIce: 'start-ice', // ICE is starting
    OfferReceived: 'offer-received', // Offer is received, but there may be more candidates
    Complete: 'ice-complete'
}

const iceServers = [ { urls: [ "stun:stun.stunprotocol.org" ] } ]

const needsNullCandidate =  navigator.userAgent.match(/Firefox|Safari/) !== null;
const candidateRe = /a=(candidate:.*)/;

export class FlockClient extends EventTarget {
    constructor (options) {
        super();

        if ( !options.hasOwnProperty('url') )
            throw TypeError('\'url\' property required on options');

        var url = new URL(options.url);

        if ( options.hasOwnProperty('appliance') ) {
            url.pathname = url.pathname + encodeURIComponent(options.appliance);
            this.state = FlockClientState.Connected;
            this.appliance = options.appliance;
        } else {
            this.state = FlockClientState.Connecting;
        }

        if ( options.hasOwnProperty('site') )
            this.certificate = options.site

        this.vcardData = "";
        this.personas = [];
        this.applications = {};
        this.rtc_stream_number = 0;
        this.answer_sent = false;

        this.flockUrl = options.url

        this.websocket = new WebSocket(url.href);
        this.websocket.binaryType = 'arraybuffer';

        this.remoteComplete = false;
        this.localComplete = false;

        var thisFlockClient = this;
        var onWsError =  function() {
            thisFlockClient.dispatchEvent(new FlockSocketErrorEvent(this, 'connection-refused'))
        };
        var onWsOpen = function (evt) {
            thisFlockClient.dispatchEvent(new FlockOpenEvent());
        }
        var onWsMessage =  (evt) => {
            var line = this.parseLine(evt.data)
            if ( line ) {
                switch ( this.state ) {
                case FlockClientState.Connecting:
                    break;
                case FlockClientState.Connected:
                    // TODO get personas
                    switch ( line.code ) {
                    case 105:
                        this.personas = [];
                        this.state = FlockClientState.CollectingPersonas;
                        break;
                    default:
                        this.handleError(line);
                    }
                    break;
                case FlockClientState.CollectingPersonas:
                    switch ( line.code ) {
                    case 503:
                        this.personas = [];
                        break;
                    case 403:
                        // Authenticate now
                        this.parseVCardData(this.vcardData)
                        this.state = FlockClientState.ReadyToLogin;
                        this.dispatchEvent(new FlockNeedsPersonasEvent(this));
                        break;
                    default:
                        this.handleError(line);
                    }
                    break;
                case FlockClientState.ReadyToLogin:
                    switch ( line.code ) {
                    case 200:
                        this.state = FlockClientState.StartIce;
                        break;
                    default:
                        this.handleError(line);
                    }
                    break;
                case FlockClientState.StartIce:
                    switch ( line.code ) {
                    case 151:
                    case 150:

                        if ( line.code == 150 )
                            this.state = FlockClientState.OfferReceived;
                        else {
                            this.signalRemoteComplete()
                        }

                        this.rtc_connection = new RTCPeerConnection(
                            Object.assign({ iceServers: iceServers },
                                          this.certificate !== undefined ? { certificates: [ this.certificate ] } : {})
                        );
                        this.rtc_connection.addEventListener('icecandidate', (c) => {
                            this.addIceCandidate(c)
                        })
                        this.rtc_control_channel = this.rtc_connection.createDataChannel('control', {protocol: 'control'})
                        this.rtc_control_channel.binaryType = 'arraybuffer'
                        this.rtc_control_channel.onopen = () => {
			    this.signalRemoteComplete()
                            this.dispatchEvent(new ChannelOpens(this));
                            this.rtc_control_channel.close()
                            delete this.rtc_control_channel
                        }
                        this.rtc_control_channel.onclose = function () { console.log('channel closes') }
                        this.rtc_control_channel.onerror = this.rtc_connection.onerror = (function (e) { console.log("Error", e) })

                        this.answer_sent = false;
                        this.candidates = [];

                        console.log('Offer is:')
                        console.log(this.offer)
                        this.rtc_connection.setRemoteDescription({ type: 'offer',
                                                                   sdp: this.offer})
                            .then(() => { this.onSetDescription() },
                                  (err) => { console.error("Could not set remote description", err) })
                        break;

                    default:
                        this.handleError(line);
                    }
                    break;
                case FlockClientState.OfferReceived:
                    switch ( line.code ) {
                    case 151:
                        console.log("All remote candidates received")
                        this.onRemoteComplete()
                        break;
                    }
                    break;
                default:
                    break;
                }
            } else {
                if ( this.state == FlockClientState.CollectingPersonas ) {
                    this.vcardData += evt.data;
                    console.log("Got vcard data", this.vcardData)
                } else if ( this.state == FlockClientState.StartIce ) {
                    this.offer = evt.data;
                } else {
                    this.sendError(new FlockErrorEvent(evt.data));
                }
            }
        };
        this.websocket.addEventListener('error', onWsError);
        this.websocket.addEventListener('open', onWsOpen);
        this.websocket.addEventListener('message', onWsMessage);
        this.disconnectWebsocket = () => {
            this.websocket.removeEventListener('error', onWsError)
            this.websocket.removeEventListener('open', onWsOpen)
            this.websocket.removeEventListener('message', onWsMessage)
        }
    };

    onRemoteComplete() {
        var emptyCand = { sdpMid: "data", candidate: null } // Safari doesn't like the empty string, so use null
        if ( needsNullCandidate )
            emptyCand = null;
        this.rtc_connection.addIceCandidate(emptyCand)
            .then(() => { console.log("ice candidates finished successfully") },
                  (err) => { console.error("failed finishing ice candidates", err) });
        this.signalRemoteComplete()
        window.conn = this.rtc_connection
        window.chan = this.rtc_control_channel
    }

    signalRemoteComplete () {
        if ( this.state != FlockClientState.Complete ) {
            console.log("Signal remote complete", this.remoteComplete, this.localComplete)
            this.state = FlockClientState.Complete;

            this.remoteComplete = true;
            if ( this.localComplete ) this.socketCompletes()
        }
    }

    socketCompletes () {
        this.websocket.close()
        this.disconnectWebsocket()
        this.disconnectWebsocket = null
        delete this.websocket
    }

    // Called when the remote description is set and we need to send the answer
    onSetDescription() {
        this.rtc_connection.createAnswer()
            .then((answer) => {
                console.log("Got local description")
                console.log(answer)

                this.rtc_connection.setLocalDescription(answer)
                this.websocket.send(answer.sdp);

                this.onAnswerSent()
            })
    }

    addIceCandidate(c) {
        if ( this.answer_sent ) {
            this.sendIceCandidate(c);
        } else
            this.candidates.push(c);
    }

    sendIceCandidate(c) {
        console.log("Sending ice candidate", c)
        console.log(c.candidate)
        if ( c.candidate )
            this.websocket.send("a=" + c.candidate.candidate + "\r\n")
        else {
            this.websocket.send("\r\n\r\n");

            this.localComplete = true;
            if ( this.remoteComplete )
                this.socketCompletes();
        }
    }

    onAnswerSent() {
        this.answer_sent = true
        this.candidates.map((c) => { this.sendIceCandidate(c) })
    }

    parseVCardData(vcard) {
        var exp_prefix = "INTRUSTD PERSONAS";
        if ( vcard.startsWith(exp_prefix) ) {
            vcard = vcard.slice(exp_prefix.length);
            var vcards = vcard.split("\nEND:VCARD");
            vcards = vcards.map((vc) => (vc + "\nEND:VCARD").trim()).filter((vc) => vc.length > 0)
            vcards = vcards.map((vc) => vCardParser.parse(vc))

            vcards = vcards.map((vc) => {
                if ( vc.hasOwnProperty('X-INTRUSTDID') ) {
                    var ret = { displayname: vc['X-INTRUSTDID'][0].value,
                                id: vc['X-INTRUSTDID'][0].value };
                    if ( vc.hasOwnProperty('fn') )
                        ret.displayname = vc['fn'][0].value;
                    if ( vc.hasOwnProperty('photo') ) {
                        ret.photo = vc['photo'][0].value;
                        if ( ret.photo instanceof Array )
                            ret.photo = ret.photo.join(";")
                    }
                    return ret;
                } else return null
            }).filter((vc) => vc !== null)

            this.personas.push(...vcards)
        } else
            console.error("Invalid vcard data", vcard);
    }

    isLoggedIn() {
        return this.state == FlockClientState.StartIce ||
            this.state == FlockClientState.OfferReceived ||
            this.state == FlockClientState.AnswerSent ||
            this.state == FlockClientState.Complete;
    }

    hasPersonas() {
        return this.state == FlockClientState.ReadyToLogin ||
            this.isLoggedIn();
    }

    parseLine (ln) {
        var comps = ln.split(' ')
        var rspCode = parseInt(comps[0])
        if ( rspCode == rspCode ) {
            return { code: rspCode,
                     line: ln }
        } else return null;
    }

    handleError (line) {
        switch ( line.code ) {
        case 404:
            if ( this.state == FlockClientState.Connecting ) {
                delete this.appliance;
                this.dispatchEvent(new FlockNeedsApplianceEvent(this));
                return;
            }
            break;
        default: break;
        }

        this.sendError(new FlockErrorEvent(line.line));
    }

    tryLogin ( personaId, creds ) {
        this.websocket.send(personaId)
        this.websocket.send(creds)

        return new Promise((resolve, reject) => {
            var removeEventListeners = () => {
                this.removeEventListener('-channel-opens', onOpen)
                this.removeEventListener('error', onError)
            }
            var onOpen = () => {
                removeEventListeners()
                this.personaId = personaId;
                resolve()
            }
            var onError = (e) => {
                removeEventListeners()
                reject(e)
            }
            this.addEventListener('-channel-opens', onOpen)
            this.addEventListener('error', onError)
        })
    }

    sendError (err) {
        console.error("sendError called: ", err);
        this.state = FlockClientState.Error;
        this.websocket.close();
        this.dispatchEvent(err);
    }

    requestApps(apps) {
        var channel = this.newDataChannel()
        return new Promise((resolve, reject) => {
            if ( this.state != FlockClientState.Complete ) {
                console.error("State is ", this.state)
                throw new TypeError("Can't request apps until flock client is connected")
            } else {
                var cur_app, cur_timer = null;
                var complete = () => {
                    if ( cur_timer !== null ) {
                        clearTimeout(cur_timer);
                        cur_timer = null;
                    }
                    channel.removeEventListener('message', listener);
                    channel.close()
                    resolve();
                };

                var canceled = () => {
                    reject(new ApplicationDeniedError(cur_app, 'timeout'));
                };

                var go = () => {
                    if ( apps.length == 0 ) {
                        complete();
                    } else {
                        do {
                            cur_app = apps[0];

                            if ( apps.length > 0 )
                                apps.splice(0, 1);
                        } while ( this.applications.hasOwnProperty(cur_app) &&
                                  apps.length > 0 );

                        if ( apps.length == 0 && this.applications.hasOwnProperty(cur_app) ) {
                            // We have all applications
                            complete();
                        } else {
                            var msg = new RequestAppControlMessage(cur_app);
                            cur_timer = setTimeout(canceled, 30000);
                            channel.send(msg.write().toArrayBuffer());
                        }
                    }
                }

                var listener = ( e ) => {
                    if ( cur_timer !== null ) {
                        clearTimeout(cur_timer);
                        cur_timer = null;
                    }

                    var parser = new BufferParser(e.data);
                    var rsp = new RequestAppControlResponse(parser);
                    if ( rsp.error ) {
                        // TODO what error?
                        reject(new ApplicationDeniedError(cur_app, 'unknown'));
                    } else {
                        this.applications[cur_app] = rsp.app_descriptor;
                    }
                    go();
                };
                channel.addEventListener('message', listener);

                go();
            }
        });
    }

    newDataChannel(init) {
        var stream_name = 'stream' + this.rtc_stream_number;
        this.rtc_stream_number += 1;

        var ret = this.rtc_connection.createDataChannel(stream_name, init);
        ret.binaryType = 'arraybuffer'

        return ret
    }

    socketTCP (app_name, port) {
        if ( this.applications.hasOwnProperty(app_name) ) {
            if ( this.rtc_connection !== null ) {
                return new FlockSocket(this, { type: 'tcp',
                                               app: this.applications[app_name],
                                               port: port });
            } else
                throw new FlockConnectionNotOpenError();
        } else
            throw new AppNotOpenedError(app_name);
    }
};

window.FlockClient = FlockClient;
