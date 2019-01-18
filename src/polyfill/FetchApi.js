// An implementation of the fetch API for flock
import { EventTarget } from 'event-target-shim';
import { HTTPParser } from 'http-parser-js';
import { FlockClient } from "../FlockClient.js";
import { Authenticator, attemptLogin } from "../Authenticator.js";
import { PortalAuthenticator } from "../Portal.js";
import { PermalinkAuthenticator, isPermalink } from "../Permalink.js";
import { parseKiteAppUrl, kiteAppCanonicalUrl } from "./Common.js";
import { generateKiteBonudary, makeFormDataStream } from "./FormData.js";
import { BlobReader } from "./Streams.js";
import { CacheControl } from "./Cache.js";
import { doUpdate } from "./Updates.js";
import ProgressManager from "./Progress.js";

var oldFetch = window.fetch;

var globalFlocks = {};
var globalAppliance;

if ( !window.ReadableStream ) {
    var streamsPolyfill = require('web-streams-polyfill')
    window.ReadableStream = streamsPolyfill.ReadableStream;
}

function makeAbsoluteUrl(url, base) {
    return (new URL(url, base)).toString()
}

function getLocation(rsp, req) {
    if ( rsp.headers.get('location') !== null ) {
        var locs = rsp.headers.get('location').split(',')
        if ( locs.length == 1) {
            return makeAbsoluteUrl(locs[0], req.url)
        } else return null
    } else
        return null;
}

function updateReq(req, update) {
    var url = req.url
    var init = { method: req.method,
                 headers: req.headers,
                 body: req.body,
                 mode: req.mode,
                 credentials: req.credentials,
                 cache: req.cache,
                 redirect: req.redirect,
                 referrer: req.referrer,
                 integrity: req.integrity
               }

    if ( update.url !== undefined ) {
        url = update.url
        delete update.url
    }

    Object.assign(init, update)

    return new Request(url, init)
}

function validRedirect(from, to) {
    var fromUrl = new URL(from)
    var toUrl = new URL(to)

    if ( fromUrl.scheme == toUrl.scheme ) return true

    if ( fromUrl.scheme == 'http' && toUrl.scheme == 'https') return true

    if ( fromUrl.scheme == 'kite+app' ) return true

    return false
}

function redirectedRequest(resp, req) {
    var loc = getLocation(resp, req)

    if ( (resp.status >= 301 && resp.status <= 303) ||
         (resp.status >= 307 && resp.status <= 308) ) {
        console.log("Redir", validRedirect(req.url, loc))
        switch (resp.status) {
        case 301:
            // TODO cache this
        case 302:
        case 303:
            if ( loc === null )
                return Response.error()

            if ( !validRedirect(req.url, loc) )
                return Response.error()

            return updateReq(req, { url: loc,
                                    referrer: req.url,
                                    method: 'GET' })

        case 308:
            // TODO cache this
        case 307:
            if ( loc === null )
                return Response.error()

            if ( !validRedirect(req.url, loc) )
                return Response.error()

            return updateReq(req, { url: loc,
                                    referrer: req.url })
        }
    } else
        return null
}

class KiteOpaqueRedirectResponse extends Response {
    constructor(actualResponse) {
        super("", { status: 0 })
        this.responnse
    }

    get redirected() {
        return true
    }

    get type() {
        return "opaqueredirect"
    }
}

class HTTPResponseEvent {
    constructor (response, responseBlob) {
        this.type = 'response'
        this.response = response
        this.responseBlob = responseBlob
    }
}

class HTTPPartialLoadEvent {
    constructor (requestor, loaded) {
        this.type = 'partialload'
        this.request = requestor
        this.loaded = loaded
        this.total = requestor.responseContentLength
    }
}

class HTTPRequesterError {
    constructor (sts) {
        this.type = 'error'
        this.explanation = sts
    }
}

class AppUpdateError {
    constructor (sts) {
        this.statusCode = sts
    }
}

class HTTPRequester extends EventTarget('response', 'error', 'progress') {
    constructor(socket, url, req) {
        super()

        this.socket = socket
        this.request = req
        this.url = url

        this.decoder = new TextDecoder()
        this.responseParser = new HTTPParser(HTTPParser.RESPONSE)

        this.response = {
            credentials: 'same-origin',
            mode: 'no-cors',
            headers: new Headers(),
            status: 500,
            statusText: 'No response'
        };
        this.body = []

        var addHeaders = (hdrs) => {
//            console.log("Adding headers", hdrs)
            for ( var i = 0; i < hdrs.length; i += 2 ) {
                this.response.headers.set(hdrs[i], hdrs[i + 1])
            }

            var contentLength = this.response.headers.get('content-length')
            if ( contentLength !== null ) {
                this.responseContentLength = parseInt(contentLength)
            }
        }

        this.responseParser[this.responseParser.kOnHeaders] =
            this.responseParser.onHeaders = (hdrs, url) => {
                addHeaders(hdrs)
            }
        this.responseParser[this.responseParser.kOnHeadersComplete] =
            this.responseParser.onHeadersComplete =
            ({versionMajor, versionMinor, headers, statusCode, statusMessage}) => {
                if ( versionMajor == 1 && versionMinor <= 1 ) {
                    addHeaders(headers)
                    this.response.status = statusCode
                    this.response.statusText = statusMessage
                } else {
                    this.dispatchEvent(new HTTPRequesterError("Invalid HTTP version " + versionMajor + "." + versionMinor))
                    this.cleanupSocket()
                }
            }
        var totalBody = 0;
        var frameRequested = null;
        this.responseParser[this.responseParser.kOnBody] =
            this.responseParser.onBody =
            (b, offset, length) => {
                var sliced = b.slice(offset, offset + length)
                totalBody += length
                this.body.push(sliced)
                if ( frameRequested === null ) {
                    frameRequested = window.requestAnimationFrame(() => { this.sendPartialLoadEvent(totalBody); frameRequested = null })
                }
            }

        var onComplete =
            this.responseParser[this.responseParser.kOnMessageComplete] =
            this.responseParser.onMessageComplete =
            () => {
                this.response.headers.set('access-control-allow-origin', '*')

                var responseBlob = this.currentBody
                if ( frameRequested !== null )
                    window.cancelAnimationFrame(frameRequested)
                this.sendPartialLoadEvent(totalBody)
                var response = new Response(responseBlob, this.response)
                response.kite = { 'flock': this.socket.conn.flockUrl,
                                  'appliance': this.socket.conn.appliance,
                                  'persona': this.socket.conn.personaId };

                this.dispatchEvent(new HTTPResponseEvent(response, responseBlob))
                this.cleanupSocket()
            }

        this.socket.addEventListener('open', () => {
            //console.log("Going to send headers", this.request.headers)
            var headers = new Headers(this.request.headers)
            headers.append('Host', url.app)
            headers.append('Accept', '*/*')
            headers.append('Accept-Language', navigator.language)
            headers.append('Cache-Control', 'no-cache')
            headers.append('Pragma', 'no-cache')
            headers.append('User-Agent', navigator.userAgent)

            var stsLine = this.request.method + ' ' + this.url.path + ' HTTP/1.1\r\n';
            var bodyLengthCalculated = Promise.resolve()
            //console.log("Sending ", stsLine)

            this.socket.send(stsLine)
            var doSendBody = () => {
                this.sendProgressEvent(50, 50)
            }
            var continueSend = () => {
                for ( var header of headers ) {
                    var hdrLn = `${header[0]}: ${header[1]}\r\n`
                    //console.log("Header", hdrLn)
                    this.socket.send(hdrLn)
                }
                this.socket.send('\r\n')
                //console.log("Sending body")
                doSendBody()
            }

            //console.log("Fetching", this.request, this.request.hasOwnProperty('body'))
            if ( this.request.hasOwnProperty('body') ) {
                bodyLengthCalculated =
                    this.calculateBodyLength(this.request.body)
                    .then(({length, bodyStream, contentType}) => {
                        this.sendProgressEvent(0, length)
                        this.bodyLength = length

                        headers.set('Content-Length', length + '')
                        if ( contentType !== undefined && contentType !== null &&
                             !headers.has('Content-type') ) {
                            headers.set('Content-type', contentType)
                        }
                        doSendBody = () => { this.sendBody(bodyStream) }
                    })
                    .catch((e) => {
                        console.error("could not calculate length", e)
                        this.dispatchEvent(new HTTPRequesterError("Could not calculate body length: " + e))
                        this.cleanupSocket()
                    })
            } else
                this.sendProgressEvent(0, 50)

            bodyLengthCalculated
                .then(() => {
                    continueSend()
                })
        })
        this.socket.addEventListener('data', (e) => {
            var dataBuffer = Buffer.from(e.data)
            //console.log("Got response", dataBuffer)
            this.responseParser.execute(dataBuffer)
        })
        this.socket.addEventListener('close', () => {
            this.responseParser.finish()
        })
        this.socket.addEventListener('error', (e) => {
            this.dispatchEvent(e);
        })
    }

    sendBody(bodyStream) {
        this.socket.sendStream(bodyStream, (sent) => {
            //console.log("Sending", sent)
            this.sendProgressEvent(sent, this.bodyLength)
        })
    }

    get currentBody() {
        var blobProps = { type: this.response.headers.get('content-type') }
        return new Blob(this.body, blobProps)
    }

    sendPartialLoadEvent(loaded) {
        this.dispatchEvent(new HTTPPartialLoadEvent(this, loaded))
    }

    sendProgressEvent(length, total) {
        this.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true,
                                                           loaded: length, total: total }))
    }

    cleanupSocket() {
        this.socket.close()
        delete this.socket
    }

    calculateBodyLength(body) {
        if ( body instanceof ReadableStream ) {
            return this.calculateBodyLengthStream(body)
        } else if ( body instanceof Blob ) {
            return { length: body.length,
                     bodyStream: BlobReader(body) }
        } else if ( body instanceof String || typeof body == 'string' ) {
            var blob = new Blob([body])
            return Promise.resolve({ length: body.length,
                                     bodyStream: BlobReader(blob) })
        } else if ( body instanceof FormData ) {
            var boundary = generateKiteBoundary()
            return this.calculateBodyLengthStream(makeFormDataStream(body, boundary.boundary))
                .then((o) => { o.contentType = boundary.contentType; return o })
        } else if ( body instanceof BufferSource ) {
            return Promise.reject(new TypeError("TODO BufferSource send"))
        } else if ( body instanceof URLSearchParams ) {
            return Promise.reject(new TypeError("TODO URLSearchParams send"))
        } else {
            return Promise.reject(new TypeError("Invalid type for 'body'"))
        }
    }

    calculateBodyLengthStream(body) {
        var bodies = body.tee()
        var lengthBody = bodies[0]
        var bodySource = bodies[1]

        return new Promise((resolve, reject) => {
            var lengthReader = lengthBody.getReader()
            var totalLength = 0
            var doCalc = () => {
                lengthReader.read().then(({done, value}) => {
                    if ( done ) {
                        resolve({ length: totalLength, bodyStream: bodySource })
                    } else {
                        if ( value instanceof ArrayBuffer )
                            totalLength += value.byteLength
                        else if ( typeof value == 'string' )
                            totalLength += value.length
                        else {
                            console.error("Can't get length of ", value)
                            throw new TypeError("Don't know how to get length of " + value)
                        }
                        doCalc()
                    }
                })
            }
            doCalc()
        })
    }
}

var globalClient;

function chooseNewAppliance(flocks, site) {
    if ( kiteFetch.require_login ) {
        return new Promise((resolve, reject) => {
            var chooser = new Authenticator(flocks, site)
            chooser.addEventListener('error', (e) => {
                globalClient = undefined;
                reject(e);
            });

            chooser.addEventListener('open', (e) => {
                // TODO request permissions from admin app
                resolve(e.device)
            });
        })
    } else {
        // The best way to log in is to use the flock recommended
        // portal app. Ask the flock which application is best

        var mkAuth

        if ( isPermalink() ) {
            mkAuth = () => { return new PermalinkAuthenticator() }
        } else {
            mkAuth = () => { return new PortalAuthenticator(flocks, site, oldFetch, kiteFetch.permissions) }
        }

        return new Promise((resolve, reject) => {
            var chooser = mkAuth()

            chooser.addEventListener('error', (e) => {
                globalClient = undefined;
                reject(e);
            })

            chooser.addEventListener('open', (e) => {
                resolve(e.device)
            })
        })
    }
}

function getGlobalClient(flocks) {
    if ( globalClient === undefined ) {
        globalClient = chooseNewAppliance(flocks)
    }
    return globalClient;
}

function isVersionOlder(a, b) {
    var va = a.split('.')
    var vb = b.split('.')

    if ( va.length != vb.length ) return false

    for ( var i = 0; i < va.length; ++i ) {
        if ( va[i] < vb[i] ) return true
        else if ( va[i] > vb[i] ) return false
    }

    return false
}

function updateApp(client, canonAppUrl) {
    if ( kiteFetch.updatedApps[canonAppUrl] === undefined ) {
        if ( kiteFetch.requiredVersions[canonAppUrl] === undefined )
            kiteFetch.updatedApps[canonAppUrl] = Promise.resolve()
        else {
            kiteFetch.updatedApps[canonAppUrl] = kiteFetch(`kite+app://admin.flywithkite.com/me/applications/${canonAppUrl}/manifest/current`)
                .then((r) => {
                    if ( r.status == 200 ) {
                    return r.json()
                            .then(({version}) => {
                                if ( isVersionOlder(version, kiteFetch.requiredVersions[canonAppUrl]) ) {
                                    // Do Update
                                    return doUpdate(kiteFetch, client, canonAppUrl)
                                } else
                                    return
                            })
                    } else {
                        console.log("Got", r.status, "while requesting version of", canonAppUrl)
                        // TODO raise notification
                        return
                    }
                })
        }
    }

    return kiteFetch.updatedApps[canonAppUrl]
}

export default function kiteFetch (req, init) {
    var url = req;
    if ( req instanceof Request ) {
        url = req.url;
    }

    var kiteUrl = parseKiteAppUrl(url);
    if ( kiteUrl.isKite ) {
        if ( kiteUrl.hasOwnProperty('error') )
            throw new TypeError(kiteUrl.error)
        else {
            var flockUrls = kiteFetch.flockUrls;
            var canonAppUrl = kiteUrl.app;
            var clientPromise, clonedReq

            if ( init === undefined )
                init = {};

            if ( req instanceof Request )
                req = new Request(req)
            else {
                req = new Request(req, init)

                if ( init.hasOwnProperty('body') )
                    req.body = init.body
            }

            var clonedReq = req.clone()

            if ( kiteFetch.rewrite.hasOwnProperty(canonAppUrl) ) {
                var newUrl = kiteFetch.rewrite[canonAppUrl].replace(/\[path\]/g, kiteUrl.path)

                req = new Request(newUrl, { method: req.method,
                                            body: req.body,
                                            mode: req.mode,
                                            credentials: req.credentials,
                                            cache: req.cache,
                                            redirect: req.redirect,
                                            referrer: req.referrer,
                                            integrity: req.integrity })
                return oldFetch.apply(this, [ req ])
            }

            if ( init.hasOwnProperty('kiteClient') )
                clientPromise = Promise.resolve(init['kiteClient'])
            else
                clientPromise = getGlobalClient(flockUrls)

            if ( kiteFetch.autoUpdate ) {
                clientPromise =
                    clientPromise.then((client) => {
                        return updateApp(client, canonAppUrl).then(() => client)
                    })
            }

            var runRequest = (dev) => {
                var tracker = ProgressManager.startFetch()

                return dev.requestApps([ canonAppUrl ], { update: kiteFetch.update })
                    .then(() => dev)
                    .then((dev) => new Promise((resolve, reject) => {
                        var socket = dev.socketTCP(canonAppUrl, kiteUrl.port);
                        var httpRequestor = new HTTPRequester(socket, kiteUrl, req)
                        var requestTracker = tracker.subtracker(50, 100)

                        if ( init.kiteOnProgress ) {
                            httpRequestor.addEventListener('progress', init.kiteOnProgress)
                        }
                        httpRequestor.addEventListener('progress', (p) => {
                            if ( p.lengthComputable ) {
                                requestTracker.setProgress(p.loaded, p.total)
                            }
                        })

                        if ( init.kiteOnPartialLoad ) {
                            httpRequestor.addEventListener('partialload', init.kiteOnPartialLoad)
                        }
                        httpRequestor.addEventListener('partialload', (pl) => {
                            if ( pl.total ) {
                                tracker.setProgress(pl.loaded, pl.total)
                            }
                        })

                        httpRequestor.addEventListener('response', (resp) => {
                            var redirect = redirectedRequest(resp.response, clonedReq)

                            if ( redirect !== null ) {
                                if ( redirect.type == 'error' ) {
                                    resolve(redirect)
                                    return
                                }

                                switch ( req.redirect ) {
                                case 'follow':
                                    resolve(kiteFetch(redirect));
                                    return;

                                case 'manual':
                                    resolve(new KiteOpaqueRedirectResponse(resp.response))
                                    return

                                case 'error':
                                    resolve(new KiteErrorResponse())
                                    return

                                default:
                                    break;
                                }
                            }

                            if ( resp.response.status == 401 ) {
                                // Check WWW-Authenticate header
                                var schemes = resp.response.headers.get("WWW-Authenticate")

                                if ( schemes === null )
                                    schemes = []
                                else
                                    schemes = schemes.split(",")

                                if ( kiteFetch.autoLogin && schemes.includes("X-Kite-Login") &&
                                     !kiteFetch.loggedIn && req.method == 'GET' ) {
                                    attemptLogin()
                                        .then((success) => {
                                            if ( success ) {
                                                kiteFetch.loggedIn = true
                                                resolve(kiteFetch(req))
                                            } else {
                                                resolve(resp)
                                            }
                                        }, reject)
                                    return
                                }
                            }

                            if ( req.cache != 'no-store' ) {
                                var cache = new Promise((resolve, reject) => {
                                    if ( dev._kiteCache === undefined ) {
                                        dev._kiteCache = new CacheControl(dev.flockUrl,
                                                                          dev.appliance,
                                                                          dev.personaId,
                                                                          canonAppUrl)
                                        resolve(dev._kiteCache)
                                    } else
                                        resolve(dev._kiteCache)
                                })

                                cache.then((cache) => {
                                    // console.log("Got response", resp.response);
                                    var responseInit = { status: resp.response.status,
                                                         statusText: resp.response.statusText,
                                                         headers: resp.response.headers };

                                    cache.cacheResponse(req, responseInit, resp.responseBlob)
                                        .then(() => {
                                            tracker.done()
                                            resolve(resp.response)
                                        })
                                        .catch(() => { tracker.done() })
                                }).catch((e) => { console.error("Error while caching", e) })
                            } else {
                                tracker.done()
                                resolve(resp.response)
                            }
                        })
                        httpRequestor.addEventListener('error', (e) => {
                            reject(new TypeError(e.explanation))
                        })
                    }))
            }

            return clientPromise
                .then((dev) => {
                    if ( req.cache == 'no-store' ||
                         req.cache == 'reload' ) {
                        return runRequest(dev)
                    } else {
                        if ( dev._kiteCache ) {
                            return dev._kiteCache.matchRequest(req)
                                .then((rsp) => {
                                    if ( rsp === undefined )
                                        return runRequest(dev)
                                    else {
                                        return rsp
                                    }
                                })
                        } else {
                            return runRequest(dev)
                        }
                    }
                })
        }
    } else
        return oldFetch.apply(this, arguments);
}

kiteFetch.flockUrls = [
    { url: "localhost:6855",
      secure: false,
      path: '/flock/' },
    { url: "flock.flywithkite.com",
      path: "/flock/",
      secure: true }
]

kiteFetch.updatedApps = { }
kiteFetch.requiredVersions = { }
kiteFetch.loggedIn = false
