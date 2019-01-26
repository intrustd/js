import ourFetch from './FetchApi.js'
import ourXMLHttpRequest from './XhrApi.js'

export default function install(options) {
    if ( options === undefined )
        options = {}

    // Set this option if you want to enable explicit logins as part
    // of your app.
    if ( options.require_login ) {
        ourFetch.require_login = true;
    }

    if ( options.permissions instanceof Array )
        ourFetch.permissions = options.permissions
    else
        ourFetch.permissions = []

    if ( options.rewrite instanceof Object )
        ourFetch.rewrite = options.rewrite
    else
        ourFetch.rewrite = {}

    if ( options.appName !== undefined )
        ourFetch.appName = options.appName
    else
        ourFetch.appName = location.host

    if ( options.requiredVersion !== undefined )
        ourFetch.requiredVersions[ourFetch.appName] = options.requiredVersion

    if ( typeof options.requiredVersions == 'object' )
        ourFetch.requiredVersions = options.requiredVersions

    if ( options.autoUpdate === undefined &&
         ( options.requiredVersion !== undefined ||
           typeof options.requiredVersions == 'object' ) )
        options.autoUpdate = true

    if ( options.autoUpdate !== undefined )
        ourFetch.autoUpdate = options.autoUpdate
    else
        ourFetch.autoUpdate = false

    if ( options.httpAuthentication !== undefined )
        ourFetch.httpAuthentication = options.httpAuthentication
    else
        ourFetch.httpAuthentication = true

    if ( options.autoLogin !== undefined )
        ourFetch.autoLogin = options.autoLogin
    else
        ourFetch.autoLogin = true

    if ( options.loginHook !== undefined )
        ourFetch.loginHook = options.loginHook
    else
        ourFetch.loginHook = function () { }

    window.XMLHttpRequest = ourXMLHttpRequest
    window.fetch = ourFetch
}

window.installIntrustd = install
