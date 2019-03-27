import { PortalAuthenticator } from "../Portal.js";
import { PermalinkAuthenticator, isPermalink } from "../Permalink.js";
import { doUpdate } from './Updates.js';

import ourFetch from './FetchApi.js';

var oldFetch = window.fetch;

export function parseAppUrl(url) {
    var url_obj, base

    if ( ourFetch.customBase )
        base = ourFetch.customBase
    else
        base = location.href

    try {
        url_obj = new URL(url, base);
    } catch (e) {
        if ( e instanceof TypeError ) {
            return { isApp: false, urlData: null }
        } else
            throw e
    }

    var host = url_obj.pathname;

    console.log("Got url obj", host)

    switch ( url_obj.protocol ) {
    case 'intrustd+app:':
        if ( host.startsWith('//') ) {
            var info = host.substr(2).split('/');
            if ( info.length >= 2 ) {
                return { isApp: true,
                         app: info[0],
                         path: '/' + info.slice(1).join('/') + url_obj.search,
                         port: 80, // TODO,
                         urlData: url_obj
                       };
            }
        }
        return { isApp: true, error: "Expected intrustd+app://app.domain/",
                 urlData: url_obj};
    default:
        return { isApp: false, urlData: url_obj };
    }
}

export function appCanonicalUrl( urlData ) {
    return 'intrustd+app://' + urlData.app;
}

export function canonicalUrl( urlData ) {
    return `intrustd+app://${urlData.app}${urlData.path}`
}

/* Get client promise */

var globalClient;

function chooseNewAppliance(flocks, site) {
    if ( ourFetch.require_login ) {
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
            mkAuth = () => { return new PortalAuthenticator(flocks, site, oldFetch, ourFetch.permissions) }
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
    if ( ourFetch.updatedApps[canonAppUrl] === undefined ) {
        if ( ourFetch.requiredVersions[canonAppUrl] === undefined )
            ourFetch.updatedApps[canonAppUrl] = Promise.resolve()
        else {
            ourFetch.updatedApps[canonAppUrl] = ourFetch(`intrustd+app://admin.intrustd.com/me/applications/${canonAppUrl}/manifest/current`)
                .then((r) => {
                    if ( r.status == 200 ) {
                    return r.json()
                            .then(({version}) => {
                                if ( isVersionOlder(version, ourFetch.requiredVersions[canonAppUrl]) ) {
                                    // Do Update
                                    return doUpdate(ourFetch, client, canonAppUrl)
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

    return ourFetch.updatedApps[canonAppUrl]
}

export function getClientPromise(init, canonAppUrl) {
    if ( init === undefined )
        init = {}

    var clientPromise
    var flockUrls = ourFetch.flockUrls;

    if ( init.hasOwnProperty('appClient') )
        clientPromise = Promise.resolve(init['appClient'])
    else
        clientPromise = getGlobalClient(flockUrls)

    if ( ourFetch.autoUpdate ) {
        clientPromise =
            clientPromise.then((client) => {
                return updateApp(client, canonAppUrl).then(() => client)
            })
    }

    return clientPromise
}

export function parseCacheControl(headers) {
    var control = headers.get('cache-control')
    if ( control !== null )
        control = control.split(',')
    else
        control = []

    var ret = { noStore: false, noCache: false, noTransform: false,
                public: false, private: false, mustRevalidate: false,
                proxyRevalidate: false, immutable: false }

    control.map((c) => {
        var matches

        if ( c == 'no-store' )
            ret.noStore = true
        else if ( c == 'no-cache' )
            ret.noCache = true
        else if ( c == 'no-transform' )
            ret.noTransform = true
        else if ( c == 'public' )
            ret.public = true
        else if ( c == 'private' )
            ret.private = true
        else if ( c == 'must-revalidate' )
            ret.mustRevalidate = true
        else if ( c == 'proxy-revalidate' )
            ret.proxyRevalidate = true
        else if ( c == 'immutable' )
            ret.immutable = true
        else if ( matches = c.match(/max-age=([0-9]+)/i) )
            ret.maxAge = parseInt(matches[1])
        else if ( matches = c.match(/s-maxage=([0-9]+)/i) )
            ret.sMaxAge = parseInt(matches[1])
        else if ( matches = c.match(/stale-while-revalidate=([0-9]+)/i) )
            ret.staleWhileRevalidate = parseInt(matches[1])
        else if ( matches = c.match(/stale-if-error=([0-9]+)/i) )
            ret.staleIfError = parseInt(matches[1])
        else
            console.warning("Unrecognized cache-control directive", c)
    })

    return ret
}
