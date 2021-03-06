// An implementation of the fetch API for flock
import { EventTarget } from 'event-target-shim';
import { HTTPParser } from 'http-parser-js';
import { FlockClient } from "../FlockClient.js";
import { Authenticator, attemptLogin } from "../Authenticator.js";
import { parseAppUrl, appCanonicalUrl, getClientPromise, parseCacheControl, parseDate } from "./Common.js";
import { generateFormBoundary, makeFormDataStream } from "./FormData.js";
import { BlobReader } from "./Streams.js";
import { CacheControl } from "./Cache.js";
import { doUpdate } from "./Updates.js";
import ProgressManager from "./Progress.js";
import parseUrl from 'url-parse';

var oldFetch = window.fetch;

var globalFlocks = {};
var globalAppliance;

const PROGRESS_DEBOUNCE_INTERVAL = 500;

if ( !window.ReadableStream ) {
    var streamsPolyfill = require('web-streams-polyfill')
    window.ReadableStream = streamsPolyfill.ReadableStream;
}

// Some statuses imply that there is no body. The response constructor
// must be given a null body in these cases, or it will error
function responseHasNoBody(sts) {
    switch ( sts ) {
    case 101:
    case 204:
    case 205:
    case 304:
        return true;
    default: return false;
    }
}

function needsValidation(rsp) {
    var cacheControl = parseCacheControl(rsp.headers)

    if ( cacheControl.noCache || cacheControl.mustRevalidate )
        return true // Always revalidate

    // Check expiry
    if ( rsp.headers.has('date') ) {
        var date = new Date(rsp.headers.get('date'))
        if ( date.getTime() == date.getTime() ) {
            if ( cacheControl.maxAge ) {
                var now = new Date()
                var secondsSince = (now - date) / 1000
                return secondsSince > cacheControl.maxAge
            }
        }
    }

    if ( rsp.headers.has('expires') ) {
        var expires = new Date(rsp.headers.get('expires'))
        if ( expires.getTime() == expires.getTime() ) {
            return expires > new Date();
        }
    }

    return true
}

function shouldUseCached(req, rsp) {
    return new Promise((resolve, reject) => {
        switch ( req.cache ) {
        case 'reload':
        case 'no-store':
            resolve({ useCached: false });
            break;
        case 'force-cache':
        case 'only-if-cached': // TODO
            resolve({ useCached: true });
            break;
        case 'default':
        default:
            if ( rsp !== undefined && needsValidation(rsp) ) {
                // Attempt revalidation using ETag
                if ( rsp.headers.has('etag') ) {
                    var etag = rsp.headers.get('etag')

                    // Attempt revalidation
                    resolve({ useCached: 'revalidate', etag })
                } else
                    resolve({ useCached: false })
            } else {
                // Otherwise, we should just use the cached one
                resolve({ useCached: rsp !== undefined });
            }
            break;
        }
    })
}

function shouldCache(req, rsp) {
    var cacheControl = parseCacheControl(rsp.headers)

    if ( req.method == 'GET' ) {
        if ( req.cache == 'no-store' || cacheControl.noStore )
            return false;

        if ( req.cache == 'reload' )
            return true;

        return (req.cache != 'no-store' && !cacheControl.noStore)
    } else
        return false;
}

function makeAbsoluteUrl(url, base) {
    var origUrl = parseUrl(base)
    var absUrl = parseUrl(url, base)
    if ( origUrl.host == absUrl.host ) {
        // If the server sends an absolute url in response that
        // redirects back to the same host, then we need to assume the
        // protocol should be changed.
        absUrl.set('protocol', 'intrustd+app:');
    }
    return absUrl.toString()
}

function getLocation(rsp, req, origUrl) {
    if ( rsp.headers.get('location') !== null ) {
        var locs = rsp.headers.get('location').split(',')
        if ( locs.length == 1) {
            return makeAbsoluteUrl(locs[0], origUrl)
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

    if ( fromUrl.scheme == 'intrustd+app' ) return true

    return false
}

function redirectedRequest(resp, req, origUrl) {
    var loc = getLocation(resp, req, origUrl)

    if ( (resp.status >= 301 && resp.status <= 303) ||
         (resp.status >= 307 && resp.status <= 308) ) {
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
                                    method: resp.status == 301 ? req.method : 'GET' })

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

class OurOpaqueRedirectResponse extends Response {
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

        this.deferredProgress = null

        this.response = {
            credentials: 'same-origin',
            mode: 'no-cors',
            headers: new Headers(),
            status: 500,
            statusText: 'No response'
        };
        this.body = []

        var addHeaders = (hdrs) => {
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
                if ( responseHasNoBody(this.response.status) )
                    responseBlob = null
                var response = new Response(responseBlob, this.response)
                response.intrustd = { 'flock': this.socket.conn.flockUrl,
                                      'appliance': this.socket.conn.appliance,
                                      'persona': this.socket.conn.personaId };

                this.dispatchEvent(new HTTPResponseEvent(response, responseBlob))
                this.cleanupSocket()
            }

        this.socket.addEventListener('open', () => {
            var headers = new Headers(this.request.headers)
            headers.append('Host', url.app)
            headers.append('Accept', '*/*')
            headers.append('Accept-Language', navigator.language)
            headers.append('Cache-Control', 'no-cache')
            headers.append('Pragma', 'no-cache')
            headers.append('User-Agent', navigator.userAgent)
            headers.append('Origin', location.origin)

            var stsLine = this.request.method + ' ' + this.url.path + ' HTTP/1.1\r\n';
            var bodyLengthCalculated = Promise.resolve()

            this.socket.send(stsLine)
            var doSendBody = () => {
                this.sendProgressEvent(50, 50, true)
            }
            var continueSend = () => {
                for ( var header of headers ) {
                    var hdrLn = `${header[0]}: ${header[1]}\r\n`
                    this.socket.send(hdrLn)
                }
                this.socket.send('\r\n')
                doSendBody()
            }

            if ( this.request.hasOwnProperty('body') ) {
                bodyLengthCalculated =
                    this.calculateBodyLength(this.request.body)
                    .then(({length, bodyStream, contentType}) => {
                        this.sendProgressEvent(0, length, true)
                        this.bodyLength = length

                        headers.set('Content-Length', length + '')
                        if ( contentType !== undefined && contentType !== null &&
                             this.request.headers['Content-type'] === undefined ) {
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
                this.sendProgressEvent(0, 50, true)

            bodyLengthCalculated
                .then(() => {
                    continueSend()
                })
        })
        this.socket.addEventListener('data', (e) => {
            var dataBuffer = Buffer.from(e.data)
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
            this.sendProgressEvent(sent, this.bodyLength, false)
        })
    }

    get currentBody() {
        var blobProps = { type: this.response.headers.get('content-type') }
        return new Blob(this.body, blobProps)
    }

    sendPartialLoadEvent(loaded) {
        this.dispatchEvent(new HTTPPartialLoadEvent(this, loaded))
    }

    _cancelDeferredProgress() {
        if ( this.deferredProgress ) {
            clearTimeout(this.deferredProgress.timeout)
            this.deferredProgress = null
        }
    }

    _deliverDeferredProgress() {
        var { progress } = this.deferredProgress
        this.deferredProgress = null
        this.dispatchEvent(progress)
    }

    sendProgressEvent(length, total, imm) {
        var evt = new ProgressEvent('progress', { lengthComputable: true,
                                                  loaded: length, total: total })
        if ( length >= total )
            imm = true

        if ( imm ) {
            this._cancelDeferredProgress()
            this.dispatchEvent(evt)
        } else {
            if ( this.deferredProgress )
                this.deferredProgress.progress = evt
            else {
                this.deferredProgress = { progress: evt }
                this.deferredProgress.timeout = setTimeout(this._deliverDeferredProgress.bind(this),
                                                           PROGRESS_DEBOUNCE_INTERVAL)
            }
        }
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
            var boundary = generateFormBoundary()
            var { stream, length } = makeFormDataStream(body, boundary.boundary)
            return Promise.resolve({ length,
                                     bodyStream: stream,
                                     contentType: boundary.contentType })
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

export default function ourFetch (req, init) {
    var url = req, origUrl;
    if ( req instanceof Request ) {
        url = req.url;
    }

    origUrl = url;

    var appUrl = parseAppUrl(url);
    if ( appUrl.isApp ) {
        if ( appUrl.hasOwnProperty('error') )
            throw new TypeError(appUrl.error)
        else {
            var canonAppUrl = appUrl.app;
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

            if ( ourFetch.rewrite.hasOwnProperty(canonAppUrl) ) {
                var newUrl = ourFetch.rewrite[canonAppUrl].replace(/\[path\]/g, appUrl.path)

                req = new Request(newUrl, { method: req.method,
                                            body: req.body,
                                            mode: req.mode,
                                            credentials: req.credentials,
                                            cache: req.cache,
                                            redirect: req.redirect,
                                            referrer: req.referrer,
                                            integrity: req.integrity,
                                            headers: req.headers })
                return oldFetch.apply(this, [ req ])
            }

            clientPromise = getClientPromise(init, canonAppUrl)

            var runRequest = (dev) => {
                var tracker = ProgressManager.startFetch()

                return dev.requestApps([ canonAppUrl ], { update: ourFetch.update })
                    .then(() => dev)
                    .then((dev) => new Promise((resolve, reject) => {
                        var socket = dev.socketTCP(canonAppUrl, appUrl.port);
                        var httpRequestor = new HTTPRequester(socket, appUrl, req)
                        var requestTracker = tracker.subtracker(50, 100)

                        if ( init.intrustdOnProgress ) {
                            httpRequestor.addEventListener('progress', init.intrustdOnProgress)
                        }
                        httpRequestor.addEventListener('progress', (p) => {
                            if ( p.lengthComputable ) {
                                requestTracker.setProgress(p.loaded, p.total)
                            }
                        })

                        if ( init.intrustdOnPartialLoad ) {
                            httpRequestor.addEventListener('partialload', init.intrustdOnPartialLoad)
                        }
                        httpRequestor.addEventListener('partialload', (pl) => {
                            if ( pl.total ) {
                                tracker.setProgress(pl.loaded, pl.total)
                            }
                        })

                        httpRequestor.addEventListener('response', (resp) => {
                            var redirect = redirectedRequest(resp.response, clonedReq, origUrl)

                            if ( redirect !== null ) {
                                if ( redirect.type == 'error' ) {
                                    resolve(redirect)
                                    return
                                }

                                switch ( req.redirect ) {
                                case 'follow':
                                    resolve(ourFetch(redirect));
                                    return;

                                case 'manual':
                                    resolve(new OurOpaqueRedirectResponse(resp.response))
                                    return

                                case 'error':
                                    resolve(new OurErrorResponse()) // TODO
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

                                if ( ourFetch.autoLogin && schemes.includes("X-Intrustd-Login") &&
                                     !ourFetch.loggedIn && req.method == 'GET' ) {
                                    attemptLogin()
                                        .then((success) => {
                                            if ( success ) {
                                                ourFetch.loggedIn = true
                                                resolve(ourFetch(req))
                                            } else {
                                                resolve(resp)
                                            }
                                        }, reject)
                                    return
                                }
                            }


                            if ( shouldCache(req, resp.response) ) {
                                var cache = new Promise((resolve, reject) => {
                                    if ( dev._intrustdCache === undefined ) {
                                        dev._intrustdCache = new CacheControl(dev.flockUrl,
                                                                              dev.appliance,
                                                                              dev.personaId,
                                                                              canonAppUrl)
                                        resolve(dev._intrustdCache)
                                    } else
                                        resolve(dev._intrustdCache)
                                })

                                cache.then((cache) => {
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
                                // TODO if method is not GET, invalidate all entries
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
                        if ( dev._intrustdCache &&
                             req.method == 'GET' ) {
                            return dev._intrustdCache.matchRequest(req)
                                .then((rsp) => {
                                    return shouldUseCached(req, rsp).then(({ useCached, etag }) => {
                                        if ( useCached == 'revalidate' ) {
                                            req.headers.set('If-None-Match', etag);
                                            return runRequest(dev).then((r) => {
                                                if ( r.status == 304 )
                                                    return Promise.resolve(rsp);
                                                else
                                                    return Promise.resolve(r);
                                            })
                                        } else if ( useCached ) return Promise.resolve(rsp);
                                        else return runRequest(dev);
                                    })
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

ourFetch.flockUrls = [
    { url: "localhost:6855",
      secure: false,
      path: '/flock/' },
    { url: "flock.intrustd.com",
      path: "/",
      secure: true }
]

ourFetch.updatedApps = { }
ourFetch.requiredVersions = { }
ourFetch.loggedIn = false
