import { EventTarget } from 'event-target-shim';
import { List } from 'immutable';
import b64 from 'base64-js';
import { HTTPParser } from 'http-parser-js';

import ourFetch from './FetchApi';
import { getClientPromise, canonicalUrl, parseAppUrl } from './Common';
import { DynamicArrayBuffer } from '../Buffer';

var oldWebSocket = window.WebSocket;

const MAX_WS_BUFFER = 1024 * 1024
const MAX_IN_TRANSIT = 16 * 1024
const MAX_PKT_LENGTH = 16 * 1024 * 1024

const WsConnectState = {
    WaitingForSocket: Symbol('WaitingForSocket'),
    HeadersSent: Symbol('HeadersSent'),
    Established: Symbol('Established'),
    Closed: Symbol('Closed'),
    Error: Symbol('Error')
}

const WsCloseReason = {
    NormalClosure: 1000,
    GoingAway: 1001,
    ProtocolError: 1002,
    UnsupportedData: 1003,
    NoStatusReceived: 1005,
    AbnormalClosure: 1006,
    InvalidFramePayloadData: 1007,
    PolicyViolation: 1008,
    MessageTooBig: 1009,
    MissingExtension: 1010,
    InternalError: 1011,
    ServiceRestart: 1012,
    TryAgainLater: 1013,
    BadGateway: 1014,
    TLSHandshake: 1015
}

const WsOpcode = {
    Continuation: 0x0,
    Text: 0x1,
    Binary: 0x2,
    Close: 0x8,
    Ping: 0x9,
    Pong: 0xA
}

function concatArrayBuffers(vs) {
    var totalLength = vs.reduce((accum, v) => accum + v.byteLength, 0)
    var ret = new ArrayBuffer(totalLength)
    var retArray = new Uint8Array(ret)

    vs.reduce((curPos, v) => {
        retArray.set(new Uint8Array(v), curPos)
        return curPos + v.byteLength
    }, 0)

    return ret
}

function wsPacket(v) {
    if ( v instanceof String ) {
        var enc = new TextEncoder('utf-8')
        var rawData = Promise.resolve(enc.encode(v).buffer)
        return { isBinary: false,
                 rawData,
                 length: rawData.byteLength }
    } else if ( v instanceof ArrayBuffer ) {
        return { isBinary: true,
                 rawData: Promise.resolve(v),
                 length: v.byteLength }
    } else if ( v instanceof Blob ) {
        var rawData = new Promise((resolve, reject) => {
            var reader = new FileReader()
            reader.addEventListener('loadend', () => {
                resolve(reader.result)
            })
            reader.addEventListener('error', reject)
            reader.readAsArrayBuffer(v)
        })
        return { isBinary: true,
                 rawData,
                 length: v.size }
    } else if ( v.buffer !== undefined &&
                v.buffer instanceof ArrayBuffer ) {
        if ( v.byteOffset == 0 &&
             v.buffer.byteLength == v.byteLength ) {
            return { isBinary: true,
                     rawData: Promise.resolve(v.buffer),
                     length: v.buffer.byteLength }
        } else {
            var newBuf = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)
            return { isBinary: true,
                     rawData: Promise.resolve(newBuf),
                     length: newBuf.byteLength }
        }

    } else
        throw new TypeError("WebSocket.send expects String, ArrayBuffer, Blob, or ArrayBufferView")
}

function splitFrame(pkt, where) {
    var baseOptions = { isBinary: pkt.isBinary }

    var firstChunk = pkt.rawData.then((rawData) => rawData.slice(0, where))
    var secondChunk = pkt.rawData.then((rawData) => rawData.slice(where))

    return { thisFrame: { isBinary: pkt.isBinary,
                          isContinued: true,
                          rawData: firstChunk,
                          length: where },
             nextFrame: { isBinary: pkt.isBinary,
                          isContinued: pkt.isContinued,
                          rawData: firstChunk,
                          length: pkt.length - where } }
}

function genMaskingKey() {
    var key = new Uint8Array(4)
    crypto.getRandomValues(key)
    return key
}

function copyWebSocketData(builder, maskingData, bytes) {
    var bytesArray = new Uint8Array(bytes)
    for ( var i = 0; i < bytesArray.length; i++ ) {
        builder.putUint8(maskingData[i % maskingData.length] ^ bytesArray[i])
    }
}

function mkPayloadLength(len) {
    if ( len <= 125 ) {
        return { len7: len }
    } else if ( len <= 0xFFFF ) {
        return { len7: 126, len16: len }
    } else {
        return { len7: 127, len64: len }
    }
}

function mkFrame({length, isBinary, isContinued, rawData}) {
    return rawData.then((bytes) => {
        var builder = new DynamicArrayBuffer()

        var opcode = 0
        if ( !isContinued ) {
            if ( isBinary )
                opcode = 0x2
            else
                opcode = 0x1

            opcode |= 0x80 // Fin bit
        }

        builder.putUint8(opcode)

        var lengthData = mkPayloadLength(bytes.byteLength)
        builder.putUint8(0x80 | lengthData.len7)

        if ( lengthData.len16 )
            builder.putUint16(lengthData.len16)
        else if ( lengthData.len64 )
            builder.putUint64(lengthData.len64)

        var maskingKey = genMaskingKey()
        builder.putBuffer(maskingKey.buffer)

        copyWebSocketData(builder, maskingKey, bytes)

        return builder.toArrayBuffer()
    })
}

class WebSocketErrorEvent {
    constructor(sk, e) {
        this.type = 'error'
        this.socket = sk
        this.error = e
    }
}

class WebSocketCloseEvent {
    constructor(type, desc, rsn) {
        var wasClean = false

        this.type = type

        if ( rsn == WsCloseReason.NormalClosure )
            wasClean = true

        Object.defineProperty(this, 'code', { writable: false,
                                              value: rsn })
        Object.defineProperty(this, 'reason', { writable: false,
                                                value: desc })
        Object.defineProperty(this, 'wasClean', { writable: false,
                                                  value: wasClean })
    }
}

class WebsocketFrameEvent {
    constructor(opc, frameData, isFinal) {
        this.type = 'frame'
        this.code = opc
        this.frame = frameData
        this.isFinal = isFinal
    }
}

const WsFrameParserState = {
    ParseOpcode: Symbol('ParseOpcode'),
    ParseMask: Symbol('ParseMask'),
    ParseLen16: Symbol('ParseLen16'),
    ParseLen64: Symbol('ParseLen64'),
    ParseMaskingKey: Symbol('ParseMaskingKey'),
    ParseData: Symbol('ParseData')
}

class WsFrameParser extends EventTarget('error', 'frame') {
    constructor(maxLength) {
        super()
        this.reset()

        Object.defineProperty(this, 'maxLength', { writable: false,
                                                   value: maxLength })
    }

    reset() {
        this.state = WsFrameParserState.ParseOpcode
        this.length = null
        this.maskingKey = null
        this.isFinal = null
        this.hasMask = false
        this.opcode = null
        this.bytesRemaining = 0
        this.currentPacket = []
        this.currentPacketLength = 0
    }

    _sendError(msg, code) {
        this.reset()
        this.dispatchEvent(new WebSocketCloseEvent('error', msg, code))
    }

    _afterLen() {
        if ( this.length > this.maxLength ) {
            _sendError(`Packet is too big (${this.length} > ${this.maxLength})`,
                       WsCloseReason.MessageTooBig)
        } else {
            if ( this.hasMask ) {
                this.maskingKey = new Uint8Array(4)
                this.bytesRemaining = 4
                this.state = WsFrameParserState.ParseMaskingKey
            } else
                this.state = WsFrameParserState.ParseData
        }
    }

    _makeCurrentFrame() {
        var currentPacket = concatArrayBuffers(this.currentPacket)

        if ( this.hasMask ) {
            var pktData = new Uint8Array(currentPacket)
            for ( var i = 0; i < pktData.length; i ++ )
                pktData[i] = pktData[i] ^ this.maskingKey[i % 4]
        }

        return currentPacket
    }

    execute(buffer) {
        var bufferData = new Uint8Array(buffer)
        for ( var i = 0; i < buffer.byteLength; i++ ) {
            switch ( this.state ) {
            case WsFrameParserState.ParseOpcode:
                this.isFinal = (bufferData[i] & 0x80) == 0x80
                this.opcode = (bufferData[i] & 0xF)
                this.state = WsFrameParserState.ParseMask
                break

            case WsFrameParserState.ParseMask:
                this.hasMask = (bufferData[i] & 0x80) == 0x80
                this.length = (bufferData[i] & 0x7F)
                if ( this.length >= 126 ) {
                    if ( this.length == 126 ) {
                        this.length = new Uint8Array(2)
                        this.bytesRemaining = 2
                        this.state = WsFrameParserState.ParseLen16
                    } else if ( this.length == 127 ) {
                        this.length = new Uint8Array(8)
                        this.bytesRemaining = 8
                        this.state = WsFrameParserState.ParseLen64
                    }
                } else {
                    this._afterLen()
                }
                break

            case WsFrameParserState.ParseLen16:
            case WsFrameParserState.ParseLen64:
                var expLen = this.state == WsFrameParserState.ParseLen16 ? 2 : 8
                this.length.set(bufferData.slice(i, i + this.bytesRemaining), expLen - this.bytesRemaining)
                if ( (buffer.byteLength - i) >= this.bytesRemaining ) {
                    var dv = new DataView(this.length.buffer)
                    console.log("Got length", this.length)
                    if ( this.state == WsFrameParserState.ParseLen16 )
                        this.length = dv.getUint16(0)
                    else
                        this.length = dv.getUint64(0)
                    i += this.bytesRemaining - 1

                    this._afterLen()
                } else {
                    this.bytesRemaining -= buffer.byteLength - i
                    i = buffer.byteLength
                }
                break

            case WsFrameParserState.ParseMaskingKey:
                this.maskingKey.set(bufferData.slice(i, i + this.bytesRemaining), 4 - this.bytesRemaining)
                if ( (buffer.byteLength - i) >= this.bytesRemaining ) {
                    i += this.bytesRemaining - 1
                    this.bytesRemaining = 0

                    this.state = WsFrameParserState.ParseData
                } else {
                    this.bytesRemaining -= buffer.byteLength - i
                    i = buffer.byteLength
                }
                break

            case WsFrameParserState.ParseData:
                if ( (buffer.byteLength - i) >= (this.length - this.currentPacketLength) ) {
                    this.currentPacket.push(bufferData.slice(i, i + this.length - this.currentPacketLength))
                    i += this.length - this.currentPacketLength - 1
                    this.currentPacketLength = this.length

                    this.dispatchEvent(new WebsocketFrameEvent(this.opcode,
                                                               this._makeCurrentFrame(),
                                                               this.isFinal))
                    this.reset()
                } else {
                    this.currentPacket.push(bufferData.slice(i))
                    this.currentPacketLength += bufferData.byteLength - i
                    i = buffer.byteLength
                }
                break

            default:
                _sendError(`Invalid frame parser state: ${this.state}`,
                           WsCloseReason.ProtocolError)
            }
        }
    }
}

class IntrustdWebSocket extends EventTarget('open', 'close', 'error', 'message') {
    constructor(url, socketPromise, protocols) {
        super()

        var urlData = parseAppUrl(url)

        if ( !urlData.isApp )
            throw new TypeError("IntrustdWebSocket requires intrustd+app url")

        var readyState = this.CONNECTING;
        var selectedProtocol = ""
        var extensions = []

        var oldStyleEvents = {}

        Object.defineProperty(this, 'url', { enumerable: true,
                                             writable: false,
                                             value: url })
        Object.defineProperty(this, 'readyState', { enumerable: true,
                                                    get: () => readyState })
        Object.defineProperty(this, 'protocol', { enumerable: true,
                                                  get: () => selectedProtocol })
        Object.defineProperty(this, 'extensions', { enumerable: true,
                                                    get: () => extensions })

        const eventGetter = (evt) => {
            return () => {
                if ( oldStyleEvents[evt] !== undefined )
                    return oldStyleEvents[evt]
                else return null
            }
        }
        const eventSetter = (evt) => {
            return (newFn) => {
                if ( oldStyleEvents[evt] !== undefined ) {
                    this.removeEventListener(evt, oldStyleEvents[evt])
                    delete oldStyleEvents[evt]
                }

                if ( evt !== null && evt !== undefined ) {
                    this.addEventListener(evt, newFn)
                    oldStyleEvents[evt] = newFn
                }
            }
        }
        const defineOldStyleEvent = (evt) => {
            Object.defineProperty(this, `on${evt}`,
                                  { enumerable: true,
                                    get: eventGetter(evt),
                                    set: eventSetter(evt) })
        }
        defineOldStyleEvent('close')
        defineOldStyleEvent('open')
        defineOldStyleEvent('error')
        defineOldStyleEvent('message')

        this.binaryType = "blob"

        // Start open
        var connectState = WsConnectState.WaitingForSocket
        var queue = List()
        var bufferedAmount = 0

        Object.defineProperty(this, 'bufferedAmount', { enumerable: true,
                                                        get: () => bufferedAmount })

        var curSocket

        const _flushQueue = () => {
            if ( bufferedAmount < 0 ) {
                bufferedAmount = 0
                aelbuaeou();
            }

            if ( queue.size > 0 ) {
                if ( curSocket.data_chan.bufferedAmount < MAX_IN_TRANSIT ) {
                    var bytesAvailable = MAX_IN_TRANSIT - curSocket.data_chan.bufferedAmount
                    var pkt = queue.first()

                    mkFrame(pkt).then((frame) => {
                        if ( frame.byteLength < bytesAvailable ) {
                            curSocket.send(frame)
                            bufferedAmount -= pkt.length
                            queue = queue.shift()
                            _flushQueue()
                        } else if ( frame.byteLength > MAX_IN_TRANSIT ) {
                            if ( bytesAvailable > 16 ) {
                                var { thisFrame, nextFrame } = splitFrame(pkt, bytesAvailable - 16)
                                mkFrame(thisFrame).then((frameData) => {
                                    if ( frameData.byteLength <= bytesAvailable ) {
                                        curSocket.send(frameData)
                                        bufferedAmount -= thisFrame.byteLength
                                        queue = queue.shift().unshift(nextFrame)
                                    }
                                    _flushQueue()
                                })
                            } else
                                _flushQueue()
                        } else
                            _flushQueue()
                    })
                } else {
                    curSocket.waitForWrite().then(_flushQueue)
                }
            }
        }

        const _close = () => {
            if ( curSocket !== undefined ) {
                curSocket.close()
                curSocket = undefined
                readyState = this.CLOSED
            }
        }

        const _send = (v) => {
            if ( readyState != WsConnectState.OPEN ||
                 connectState != WsConnectState.Established ) {
                throw new Error("Not opened at WebSocket.send")
            } else {
                var pkt = wsPacket(v)

                if ( (pkt.length + this.bufferedAmount) > MAX_WS_BUFFER ) {
                    _close()
                    return
                } else {
                    var oldBufferedAmount = bufferedAmount

                    queue = queue.push(pkt)
                    bufferedAmount += pkt.length

                    if ( oldBufferedAmount == 0 && bufferedAmount > 0 ) {
                        _flushQueue() // Wait until we have enough space in the socket to send more
                    }
                }
            }
        }

        var httpParser = new HTTPParser(HTTPParser.RESPONSE)
        var headerStatus = { upgradeRecvd: false,
                             connectionUpgradeRecvd: false,
                             websocketAcceptRecvd: false }
        var expectedKey

        const _sendError = (e, closeReason) => {
            if ( connectState != WsConnectState.Error ) {
                connectState = WsConnectState.Error

                this.dispatchEvent(new WebSocketErrorEvent(this, e))
                this.dispatchEvent(new WebSocketCloseEvent('close', e, closeReason))
                _close()
            }
        }

        httpParser[httpParser.kOnHeaders] = httpParser.onHeaders =
            (hdrs, url) => {
                for ( var i = 0; i < hdrs.length; i += 2 ) {
                    var k = hdrs[i]
                    var v = hdrs[i + 1]
                    switch ( k.toLowerCase() ) {
                    case 'upgrade':
                        if ( v.toLowerCase() == 'websocket' )
                            headerStatus.upgradeRecvd = true
                        else {
                            _sendError('Invalid Upgrade header', WsCloseReason.ProtocolError)
                            return
                        }
                        break

                    case 'connection':
                        if ( v.toLowerCase() == 'upgrade' )
                            headerStatus.connectionUpgradeRecvd = true
                        else {
                            _sendError("Invalid Connection header", WsCloseReason.ProtocolError)
                            return
                        }
                        break

                    case 'sec-websocket-accept':
                        if ( v == expectedKey )
                            headerStatus.websocketAcceptRecvd = true
                        else {
                            _sendError(`Invalid Sec-WebSocket-Accept header, expected ${expectedKey}, got ${v}`, WsCloseReason.ProtocolError)
                            return
                        }
                        break

                    case 'sec-websocket-protocol':
                        selectedProtocol = v
                        break

                    default:
                        console.log(`Unknown websocket header ${k}: ${v}`)
                    }
                }
            }

        httpParser[httpParser.kOnHeadersComplete] = httpParser.onHeadersComplete =
            ({versionMajor, versionMinor, headers, statusCode, statusMessage}) => {
                if ( statusCode != 101 ) {
                    _sendError('Invalid status', WsCloseReason.ProtocolError)
                } else {
                    httpParser.onHeaders(headers, null)

                    httpParser = null

                    if ( !headerStatus.upgradeRecvd ) {
                        _sendError("No Upgrade header received", WsCloseReason.ProtocolError)
                    } else if ( !headerStatus.connectionUpgradeRecvd ) {
                        _sendError("No Connection header received", WsCloseReason.ProtocolError)
                    } else if ( !headerStatus.websocketAcceptRecvd ) {
                        _sendError("No Sec-WebSocket-Accept header received", WsCloseReason.ProtocolError)
                    } else {
                        connectState = WsConnectState.Established
                        readyState = this.OPEN

                        this.dispatchEvent(new Event('open'))
                    }
                }
            }

        httpParser[httpParser.kOnBody] = httpParser.onBody =
            (b, offset, length) => {
                _sendError('HTTP body received', WsCloseReason.NoStatusReceived)
            }

        httpParser[httpParser.kOnMessageComplete] = httpParser.onMessageComplete =
            () => {
                if ( connectState != WsConnectState.Established ) {
                    _sendError('HTTP message complete', WsCloseReason.NoStatusReceived)
                }
            }

        var wsFrameParser = new WsFrameParser(MAX_PKT_LENGTH)
        wsFrameParser.addEventListener('error', () => {
            _sendError(e.reason, e.code)
        })

        var currentFrame = null

        const _deliverFrame = () => {
            if ( currentFrame === null ) {
                console.error("_deliverFrame called with currentFrame === null")
            } else {
                if ( currentFrame.binary ) {
                    var data
                    if ( this.binaryType == 'blob' )
                        data = new Blob(currentFrame.packets)
                    else
                        data = concatArrayBuffers(currentFrame.packets)

                    currentFrame = null
                    this.dispatchEvent(new MessageEvent('message', { data }))
                } else {
                    var data = currentFrame.packets.join('')
                    currentFrame = null
                    this.dispatchEvent(new MessageEvent('message', { data }))
                }
            }
        }

        wsFrameParser.addEventListener('frame', (e) => {
            console.log("Got frame", e.code, e.frame, e.isFinal)
            switch ( e.code ) {
            case WsOpcode.Continuation:
                if ( currentFrame == null )
                    _sendError('Continuation frame received, but no packet in progress', WsCloseReason.ProtocolError)
                else {
                    if ( currentFrame.binary )
                        currentFrame.packets.push(e.frame)
                    else {
                        var decoded
                        try {
                            decoded = currentFrame.decoder.decode(e.frame, {stream: !e.isFinal})
                        } catch (e) {
                            if ( e instanceof TypeError ) {
                                _sendError(`Invalid frame payload data: ${e.message}`, WsCloseReason.InvalidFramePayloadData)
                            } else
                                throw e
                        }
                        currentFrame.packets.push(decoded)
                    }
                    if ( e.isFinal )
                        _deliverFrame()
                }
                break


            case WsOpcode.Text:
                if ( currentFrame !== null ) {
                    _sendError('Text frame received, but another packet is in progress', WsCloseReason.ProtocolError)
                } else {
                    var decoder = new TextDecoder('utf-8', { fatal: true })

                    try {
                        currentFrame = { binary: false, decoder,
                                         packets: [ decoder.decode(e.frame, {stream: !e.isFinal}) ] }
                    } catch (e) {
                        if ( e instanceof TypeError )
                            _sendError(`Invalid frame payload data: ${e.message}`, WsCloseReason.InvalidFramePayloadData)
                        else
                            throw e
                    }

                    if ( e.isFinal )
                        _deliverFrame()
                }
                break

            case WsOpcode.Binary:
                if ( currentFrame !== null ) {
                    _sendError('Binary frame received, but another packet is in progress', WsCloseReason.ProtocolError)
                } else {
                    currentFrame = { binary: true,
                                     packets: [ e.frame ] }

                    if ( e.isFinal )
                        _deliverFrame()
                }
                break

            case WsOpcode.Pong:
                console.log("TODO received WS pong")
                break

            case WsOpcode.Ping:
                console.log("TODO received WS ping")
                break

            case WsOpcode.Close:
                connectState = WsConnectState.Closed
                readyState = this.CLOSED
                curSocket.close()
                this.dispatchEvent(new WebSocketCloseEvent('close', 'Remote closed connection', WsCloseReason.NormalClosure))
                break

            default:
                console.error("Unknown websocket operation:", e.code)
                _sendError(`Invalid websocket opcode: ${e.code}`, WsCloseReason.ProtocolError)
                break

            }
        })
        const onSkData = (e) => {
            var decoder = new TextDecoder('iso-8859-2')
            switch ( connectState ) {
            case WsConnectState.HeadersSent:
                var dataBuffer = Buffer.from(e.data)
                httpParser.execute(dataBuffer)
                break

            case WsConnectState.Established:
                // Parse frames, keep any extra data around for later
                console.log("Got data ", e.data)
                wsFrameParser.execute(e.data)
                break

            default:
                console.log("Received data in unknown state", connectState)
            }
        }

        const generateKey = () => {
            var keyBytes = new ArrayBuffer(16)
            var keyData = []

            for ( var i = 0; i < keyBytes.byteLength; i++ ) {
                var n = Math.floor(Math.round(Math.random() * 256))
                if ( n == 256 )
                    n = 0
                keyData.push(n)
            }

            var keyBuffer = new Uint8Array(keyBytes)
            keyBuffer.set(keyData, 0)

            return b64.fromByteArray(keyBuffer)
        }

        const sendHeaders = (socket) => {
            var key = generateKey()

            curSocket = socket

            var keyHash = (new TextEncoder('utf-8')).encode(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).buffer
            window.crypto.subtle.digest('SHA-1', keyHash).then((dgst) => {
                const header = (hdr) => {
                    socket.send(`${hdr}\r\n`)
                }

                expectedKey = b64.fromByteArray(new Uint8Array(dgst))

                header(`GET ${urlData.path} HTTP/1.1`)
                header(`Host: ${urlData.app}`)
                header(`Accept-Language: ${navigator.language}`)
                header(`User-Agent: ${navigator.userAgent}`)
                header(`Origin: ${location.origin}`)
                header('Upgrade: websocket')
                header('Connection: Upgrade')
                header('Sec-WebSocket-Version: 13')
                header(`Sec-WebSocket-Key: ${key}`)

                if ( protocols !== undefined &&
                     typeof protocols.length == 'number' &&
                     protocols.length != 0 ) {
                    header(`Sec-WebSocket-Protocol: ${protocols.join(', ')}`)
                }

                socket.send('\r\n')
            })
        }

        Object.defineProperty(this, 'close', { enumerable: true,
                                               value: _close })
        Object.defineProperty(this, 'send', { enumerable: true,
                                              value: _send })

        socketPromise.then((socket) => {
            const _skOpens = () => {
                socket.removeEventListener('open', _skOpens)
                socket.addEventListener('data', onSkData)
                sendHeaders(socket)
            }
            socket.addEventListener('open', _skOpens)

            socket.addEventListener('close', () => {
                _sendError('Socket closed from underneath', WsCloseReason.GoingAway)
            })

            // Now wait for the response on the socket
            connectState = WsConnectState.HeadersSent
        })
    }

}

Object.defineProperty(IntrustdWebSocket, 'CONNECTING', { writable: false, value: 0 })
Object.defineProperty(IntrustdWebSocket, 'OPEN', { writable: false, value: 1 })
Object.defineProperty(IntrustdWebSocket, 'CLOSING', { writable: false, value: 2 })
Object.defineProperty(IntrustdWebSocket, 'CLOSED', { writable: false, value: 3 })

export default function WebSocket(url, protocols, options) {
    var urlData = parseAppUrl(url)


    if ( options === undefined )
        options = {}

    if ( !urlData.isApp && urlData.urlData !== null ) {
        if ( (urlData.urlData.protocol == 'ws:' ||
              urlData.urlData.protocol == 'wss:') &&
             WebSocket.captureWebSocketsFor.indexOf(urlData.urlData.host) != -1 )
            urlData = { isApp: true,
                        app: ourFetch.appName,
                        path: urlData.urlData.pathname,
                        port: 80, // TODO
                        urlData: urlData.urlData }
    }

    if ( urlData.isApp ) {
        var clientPromise = getClientPromise(options, urlData.app)
        var socketPromise =
            clientPromise.then((client) =>
                               client.requestApps([ urlData.app ]).then(() => client))
               .then((client) => client.socketTCP(urlData.app, urlData.port))

        return new IntrustdWebSocket(canonicalUrl(urlData), socketPromise, protocols)
    } else
        return new oldWebSocket(url, protocols)
}

