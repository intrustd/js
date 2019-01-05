import kiteFetch from './FetchApi.js'
import kiteXMLHttpRequest from './XhrApi.js'

export default function installKite(options) {
    if ( options === undefined )
        options = {}

    // Set this option if you want to enable explicit logins as part
    // of your app.
    if ( options.require_login ) {
        kiteFetch.require_login = true;
    }

    if ( options.permissions instanceof Array )
        kiteFetch.permissions = options.permissions
    else
        kiteFetch.permissions = []

    if ( options.rewrite instanceof Object )
        kiteFetch.rewrite = options.rewrite
    else
        kiteFetch.rewrite = {}

    if ( options.appName !== undefined )
        kiteFetch.appName = options.appName
    else
        kiteFetch.appName = location.host

    if ( options.requiredVersion !== undefined )
        kiteFetch.requiredVersions[kiteFetch.appName] = options.requiredVersion

    if ( typeof options.requiredVersions == 'object' )
        kiteFetch.requiredVersions = options.requiredVersions

    if ( options.autoUpdate === undefined &&
         ( options.requiredVersion !== undefined ||
           typeof options.requiredVersions == 'object' ) )
        options.autoUpdate = true

    if ( options.autoUpdate !== undefined )
        kiteFetch.autoUpdate = options.autoUpdate
    else
        kiteFetch.autoUpdate = false

    if ( options.httpAuthentication !== undefined )
        kiteFetch.httpAuthentication = options.httpAuthentication
    else
        kiteFetch.httpAuthentication = true

    if ( options.autoLogin !== undefined )
        kiteFetch.autoLogin = options.autoLogin
    else
        kiteFetch.autoLogin = true

    if ( options.loginHook !== undefined )
        kiteFetch.loginHook = options.loginHook
    else
        kiteFetch.loginHook = function () { }

    window.XMLHttpRequest = kiteXMLHttpRequest
    window.fetch = kiteFetch
}

window.installKite = installKite
