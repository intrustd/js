import { EventTarget } from 'event-target-shim';
import React from 'react';
import ReactDom from 'react-dom';
import { Set } from 'immutable';

import { Login, lookupLogins, getSite, getLoginsDb,
         resetLogins, rememberPermissions, lookupSavedPermissions } from './Logins.js';
import { AuthenticatorModal } from './Authenticator.js';
import { parseKiteAppUrl } from './polyfill/Common.js';
import { updateApp, AppInstallItem } from './polyfill/Updates.js';
import { KiteLoadingIndicator } from './react.js';

import './Portal.scss';

const E = React.createElement

class KiteMissingApps {
    constructor (missingApps) {
        this.missingApps = missingApps
    }
}

export class KitePermissionsError {
    constructor (msg) {
        this.message = msg
    }
}

function wrtcToKiteFingerprint({ algorithm, value }) {
    const AlgMapping = { 'sha-256': 'SHA256' }

    if ( AlgMapping.hasOwnProperty(algorithm) ) {
        return `${AlgMapping[algorithm]}:${value.replace(/:/g, '')}`
    } else
        return null
}

function findPortalApp(flocks, oldFetch) {
    var attempts = flocks.map((flock, ix) => () => {
        var proto = ''
        if ( flock.secure )
            proto = 'https:';

        return oldFetch(`${proto}//${flock.url}/portal`,
                 { method: 'GET' })
            .then((rsp) => rsp.text())
            .then((portalUrl) => `${portalUrl}#kite-auth`)
            .then((portalUrl) => { return { flock, portalUrl }; })
            .catch(( e ) => {
                if ( ix >= (flocks.length - 1) )
                    return Promise.reject(e)
                else
                    return attempts[ix + 1]()
            })
    })

    return attempts[0]()
}

function openPortalFrame(portalUrl) {
    var iframe = document.createElement('iframe')
    iframe.className = 'kite-hidden-iframe';

    document.body.appendChild(iframe)

    return new Promise((resolve, reject) => {
        iframe.onload = () => {
            iframe.onload = null
            resolve(iframe)
        }

        console.log("Got portal url", portalUrl)
        iframe.src = portalUrl;
    })
}

const PortalModalState = {
    LookingUpPortal: Symbol('LookingUpPortal'),
    RequestingPermissions: Symbol('RequestingPermissions'),
    NeedsPopup: Symbol('NeedsPopup'),
    Connecting: Symbol('Connecting'),
    ChooseLogin: Symbol('ChooseLogin'),
    Error: Symbol('Error')
}

class ConnectingAnimation extends React.Component {
    render() {
        return E('span', { className: 'kite-connecting' },
                 E('i', { className: 'kite-connecting-dot' }),
                 E('i', { className: 'kite-connecting-dot' }),
                 E('i', { className: 'kite-connecting-dot' }))
    }
}

class LoginList extends React.Component {
    render() {
        return E('ul', { className: 'kite-list kite-login-list' },
                 this.props.logins.map((login) => {
                     return E('li', { key: login.key,
                                      onClick: () => { this.props.onSelect(login) }},
                              E('span', { className: 'kite-appliance-name' }, login.applianceName),
                              E('span', { className: 'kite-login-expiration' }, `${login.expiration}`))
                 }))
    }
}

class DelayedGroup extends React.Component {
    constructor() {
        super()

        this.state = { timer: null, timedOut: false }
    }

    componentDidMount() {
        var timer = setTimeout(this.onTimeout.bind(this), this.props.delay)
        this.setState({ timer })
    }

    onTimeout() {
        this.setState({ timedOut: true })
    }

    render() {
        if ( this.state.timedOut )
            return this.props.children
        else
            return null
    }
}

class PortalModal extends React.Component {
    constructor() {
        super()

        this.state = { }
    }

    render() {
        var explanation

        switch ( this.props.state ) {
        case PortalModalState.LookingUpPortal:
            explanation = 'Looking up portal...';
            break;
        case PortalModalState.RequestingPermissions:
            explanation = 'Requesting permissions...'; // TODO pop-up blockers
            break;
        case PortalModalState.ChooseLogin:
            explanation = E('div', { className: 'kite-form-row', key: 'choose-login'  },
                            'You are currently logged in to multiple Kites. Select which login you\'d like to use',
                            E(LoginList, { logins: this.props.logins,
                                           onSelect: this.props.selectLogin }))
            break;
        case PortalModalState.NeedsPopup:
            explanation = E('div', { className: 'popup-request', key: 'popup-request' },
                            E('p', null, 'The login popup was blocked.'),
                            E('p', null, 'Click below to open the window.'),
                            E('button', { onClick: this.props.doPopup, className: 'uk-button uk-button-primary' }, 'Login'))
            break;
        case PortalModalState.Error:
            explanation = E('div', { className: 'popup-error-box', key: 'popup-error-box' },
                            E('p', null, 'There was an error logging in:'),
                            E('p', null, this.props.error),
                            E('button', { onClick: this.props.requestNewLogin },
                              'Try again'));
            break;
        case PortalModalState.Connecting:
            explanation = [ E(ConnectingAnimation, { key: 'connecting-animation' }),
                            E(DelayedGroup, { delay: 5000, key: 'connecting-delay-message' },
                              E('p', null, 'This seems to be taking a bit, click ',
                                E('a', { href: '#', onClick: this.props.requestNewLogin }, 'here'),
                                ' to reconnect')) ];
            break;
        }

        return E('div', { className: 'kite-auth-modal kite-modal' },
                 E('header', { className: 'kite-modal-header' },
                   E('h3', {}, 'Authenticating with Kite')),
                 E('p', { className: 'kite-auth-explainer' },
                   explanation))
    }
}

class PortalAuthOpensEvent {
    constructor(client) {
        this.type = 'open';
        this.device = client;
    }
}

export class PortalAuthenticator extends EventTarget('open', 'error') {
    constructor(flocks, site, oldFetch, permissions) {
        super()

        this.modalContainer = document.createElement("div");
        this.modalContainer.classList.add("kite-modal-backdrop");

        document.body.appendChild(this.modalContainer)

        this.logins = null

        this.state = PortalModalState.LookingUpPortal
        this.permissions = permissions
        this.render()

        Promise.all([findPortalApp(flocks, oldFetch),
                     getLoginsDb().then(getSite),
                     getLoginsDb().then(lookupLogins)])
            .then(([{flock, portalUrl}, site, logins]) => {
                var url = new URL(portalUrl)

                this.chosenFlock = flock
                this.site = site
                this.portalUrl = portalUrl
                this.portalOrigin = url.origin

                this.logins = logins
                if ( logins.length == 1 ) {
                    this.selectLogin(logins[0])
                } else if ( logins.length > 0 ) {
                    this.state = PortalModalState.ChooseLogin
                    this.render()
                } else {
                    return openPortalFrame(portalUrl)
                        .then((iframe) => {
                            this.portalFrame = iframe
                            this.attachWindowMessageHandler()
                            this.startPortalAuth()
                        })
                }
            })
            .catch((e) => {
                this.state = PortalModalState.Error
                this.onError(e)
            })
    }

    get portalFrameWindow() {
        var display = PortalDisplay.Popup
        var contentWindow = this.portalFrame
        if ( this.portalFrame instanceof HTMLIFrameElement ) {
            display = PortalDisplay.Hidden
            contentWindow = contentWindow.contentWindow
        }
        return { contentWindow, display }
    }

    startPortalAuth() {
        var { contentWindow, display } = this.portalFrameWindow

        contentWindow.postMessage(
            { type: 'start-auth',
              permissions: this.permissions,
              ttl: 30 * 60, // TODO accept as an argument
              siteFingerprints: this.site.getFingerprints().map(wrtcToKiteFingerprint).filter((c) => c !== null),
              flocks: [ this.chosenFlock ],
              display },
            this.portalOrigin)
    }

    requestPortalAuth() {
        // TODO timeout until this succeeds
        setTimeout(() => { this.startPortalAuth() }, 500)
    }

    selectLogin(login) {
        // Login as this one token
        this.state = PortalModalState.Connecting
        this.login = login
        this.doConnect()
        this.render()
    }

    render() {
        ReactDom.render(React.createElement(PortalModal,
                                            { state: this.state,
                                              logins: this.logins,
                                              error: this.error,
                                              doPopup: this.doPopup,
                                              selectLogin: this.selectLogin.bind(this),
                                              requestNewLogin: this.requestNewLogin.bind(this) }),
                        this.modalContainer)
    }

    hide() {
        document.body.removeChild(this.modalContainer)
        delete this.modalContainer
    }

    attachWindowMessageHandler() {
        if ( this.windowMessageHandler === undefined ) {
            this.windowMessageHandler = this.onWindowMessage.bind(this)
            window.addEventListener('message', this.windowMessageHandler)
        }
    }

    requestNewLogin() {
        this.attachWindowMessageHandler()
        this.openPopup()
        this.requestPortalAuth()
    }

    onError(e) {
        this.hide()
        console.error("Closing PortalAuthenticator due to ", e)
        this.dispatchEvent(new Event('error'))
    }

    onWindowMessage(msg) {
        if ( msg.origin == this.portalOrigin ) {
            if ( msg.data == 'show-portal' ) {
                if ( this.portalFrame instanceof HTMLIFrameElement )
                    this.portalFrame.parentNode.removeChild(this.portalFrame)

                console.log("Received request to open portal. Opening", this.portalUrl)
                this.openPopup()
            } else {
                window.removeEventListener('message', this.windowMessageHandler)
                if ( msg.data.success ) {
                    this.login = new Login({ persona_id: msg.data.persona,
                                             flock: msg.data.flockUrl,
                                             appliance: msg.data.applianceName,
                                             token: msg.data.token,
                                             exp: msg.data.exp },
                                           this.site)

                    this.login.save()
                        .then(() => {
                            this.state = PortalModalState.Connecting;
                            this.render()
                            this.doConnect()
                        })
                    this.closePopup()
                } else {
                    console.log("Permissions denied")
                    this.closePopup()
                    this.state = PortalModalState.Error
                    this.error = msg.data.error
                    // Denied
                }
            }
        } else
            console.log("Ignoring message", msg)
    }

    closePopup() {
        this.portalFrameWindow.contentWindow.postMessage({ type: 'finish-auth' }, this.portalOrigin)
    }

    openPopup() {
        var src = this.portalUrl
        console.log("Open popup")
        this.portalFrame = window.open(src, 'kite-login-popup', 'width=500,height=500')
        if ( this.portalFrame === null ) {
            this.state = PortalModalState.NeedsPopup
            this.doPopup = () => this.openPopup()
            this.render()
        } else {
            this.state = PortalModalState.RequestingPermissions
            this.requestPortalAuth()
            this.render()
        }
    }

    doConnect() {
        this.login.createClient()
            .then((client) => {
                // Connected client

                this.dispatchEvent(new PortalAuthOpensEvent(client))
                this.hide()
            })
            .catch((e) => {
                this.state = PortalModalState.Error
                this.error = `Could not connect to flock: ${e}`
                this.render()
            })
    }
}

export const PortalDisplay = {
    Hidden: 'Hidden',
    Popup: 'Popup'
}

class PermissionsModal extends React.Component {
    constructor() {
        super()
        this.rememberPermissionsRef = React.createRef()
        this.state = { deselectedApps: Set() }
    }

    renderPermissionsList() {
        return E('ul', {className: 'kite-list kite-permission-list'},
                 this.props.tokenPreview.sections.map(({domain, entries, icon, name, version}) => {
                     var iconEl
                     if ( icon !== undefined )
                         iconEl = E('div', { className: 'app-icon' },
                                    E('img', { src: icon }))

                     var r = [ E('li', { className: 'kite-permission-header kite-list-header', key: `header-${domain}` },
                                 iconEl,
                                 E('span', { className: 'app-name' }, name)) ]

                     entries.map(({short, long, icon}, i) => {
                         r.push(E('li', { className: 'kite-permission', key: `perm-${domain}-${i}` }, short))
                     })

                     return r
                 }))
    }

    render() {
        var body
        var loading = false

        switch ( this.props.state ) {
        case PortalServerState.WaitingToStart:
            body = [ E('p', {className: 'kite-auth-explainer'},
                       'Logging in to appliance...'),

                     E('button', { className: 'uk-button uk-button-primary' },
                       'Settings...') ]
            break;
        case PortalServerState.Error:
            body = [ E('p', {className: 'kite-auth-explainer'},
                       'Error: ', `${this.props.error}`),

                     E('button', { type: 'button',
                                   className: 'uk-button uk-button-primary',
                                   onClick: this.props.onResetLogins },
                       'Try again') ]
            break;
        case PortalServerState.Connecting:
            body = [ E(ConnectingAnimation),
                     E(DelayedGroup, { delay: 5000 },
                       E('p', null,
                         'This seems to be taking a while. Click ',
                         E('a', { href: '#', onClick: this.props.cancelConnection }, 'here'),
                         ' to try a new set of credentials'))
                   ]
            break;
        case PortalServerState.DisplayLogins:
            body = E('p', {className: 'kite-auth-explainer'},
                     'You are currently logged in to multiple Kites. Select which login you\'d like to use',
                     E(LoginList, { logins: this.props.logins,
                                    onSelect: this.props.onChooseLogin }))
            break;
        case PortalServerState.LoadingTokenPreview:
            body = E(KiteLoadingIndicator, { key: 'loading-preview' })
            break;
        case PortalServerState.AskForConfirmation:
            if ( this.props.tokenPreview ) {
                body = [ E('p', { className: 'kite-auth-explainer' },
                           `The page at ${this.props.origin} is asking for permission to access your Kite device`),
                         this.renderPermissionsList(),
                         E('div', {className: 'kite-form-row'},
                           E('label', { className: 'uk-form-label' },
                             E('input', { type: 'checkbox', className: 'uk-checkbox', ref: this.rememberPermissionsRef }),
                             'Remember these permissions')),
                         E('div', {className: 'kite-form-row'},
                           E('button', {className: `kite-form-submit ${loading ? 'kite-form-submit--loading' : ''}`,
                                        disabled: loading,
                                        onClick: () => this.acceptPermissions() },
                             'Accept')) ]
            } else {
                var error = 'Error fetching permissions preview';
                if ( this.tokenPreview !== undefined && typeof this.tokenPreview.error == 'string' ) {
                    error = this.tokenPreview.error
                }
                body = [ E('p', null, error) ]
            }
            break;

        case PortalServerState.InstallingApplications:
        case PortalServerState.ApplicationInstallError:
        case PortalServerState.ApplicationsSuccess:
            body = [ E('div', { className: 'kite-form-row', key: 'app-list' },
                       E('ul', { className: 'kite-list kite-app-list' },
                         this.props.missingApps.map(
                             (a) => {
                                 if ( this.props.appProgress.hasOwnProperty(a) ) {
                                     return E('li', { key: a,
                                                      className: 'kite-app-container--installing' },
                                              E(AppInstallItem, { app: a, installing: true,
                                                                  progress: this.props.appProgress[a] }));
                                 }
                             }))
                      ),

                     (this.props.state == PortalServerState.ApplicationInstallError ?
                      E('div', { className: 'kite-form-row', key: 'confirm-list' },
                        E('button', { className: 'uk-button uk-button-danger',
                                      onClick: this.props.installApps },
                          E('i', { className: 'fa fa-fw fa-refresh' }),
                          ' Retry')) : null ),

                     (this.props.state == PortalServerState.ApplicationsSuccess ?
                      E('div', { className: 'kite-form-row', key: 'confirm-list' },
                        E('button', { className: 'uk-button uk-button-primary',
                                      onClick: this.props.onRetryAfterInstall },
                          E('i', { className: 'fa fa-fw fa-check' }),
                          'Continue')) : null)
                   ];

            break;

        case PortalServerState.InstallAppsRequest:
            var missingAppsSet = Set(this.props.missingApps)
            var appsLeft = missingAppsSet.isSuperset(this.state.deselectedApps) && !this.state.deselectedApps.isSuperset(missingAppsSet)

            body = [ E('p', { className: 'kite-auth-explainer', key: 'request-explainer' },
                       'The following applications are not installed on your appliance. Would you like to install them now?'),
                     E('div', { className: 'kite-form-row', key: 'apps-list' },
                       E('ul', { className: 'kite-list kite-app-list' },
                         this.props.missingApps.map(
                             (a) =>
                                 E('li', { key: a,
                                           onClick: () => {
                                               var isSelected = !this.state.deselectedApps.contains(a);
                                               if ( isSelected )
                                                   this.setState({deselectedApps: this.state.deselectedApps.add(a)})
                                               else
                                                   this.setState({deselectedApps: this.state.deselectedApps.delete(a)})
                                           },
                                           className: (!this.state.deselectedApps.contains(a)) ? 'kite-app-container--selected' : '' },
                                   E(AppInstallItem, { app: a, selected: !this.state.deselectedApps.contains(a) }))))),
                     E('div', { className: 'kite-form-row' },
                       E('button', { type: 'button',
                                     className: 'uk-button uk-button-primary',
                                     onClick: () => {
                                         var toInstall = this.state.deselectedApps.reduce((a, app) => a.delete(app), missingAppsSet)
                                         this.props.installApps(toInstall.toArray())
                                     },
                                     disabled: !appsLeft },
                         'Install'))
                   ]

            break;
        default:
            console.log("Found default case", this.props.state)
            break;
        }

        return E('div', {className: 'kite-auth-modal kite-modal'},
                 E('header', {className: 'kite-modal-header'},
                   E('h3', {}, 'Authenticate with Kite')),
                 body)
    }

    acceptPermissions() {
        this.props.onSuccess(this.rememberPermissionsRef.current.checked)
    }
}

export const PortalServerState = {
    WaitingToStart: Symbol('WaitingToStart'),
    LookingUpLogins: Symbol('LookingUpLogins'),
    NewLogin: Symbol('NewLogin'),
    LoginOne: Symbol('LoginOne'),
    DisplayLogins: Symbol('DisplayLogins'),
    Connecting: Symbol('Connecting'),
    MintingToken: Symbol('MintingToken'),
    Error: Symbol('Error'),
    InstallAppsRequest: Symbol('InstallAppsRequest'),
    InstallingApplications: Symbol('InstallingApplications'),
    ApplicationInstallError: Symbol('ApplicationInstallError'),
    ApplicationsSuccess: Symbol('ApplicationsSuccess'),
    AskForConfirmation: Symbol('AskForConfirmation'),
    LoadingTokenPreview: Symbol('LoadingTokenPreview')
}

export class PortalServer {
    constructor() {
        this.state = PortalServerState.WaitingToStart;
        this.modalShown = false;
        this.display = PortalDisplay.Hidden;

        window.addEventListener('message', (e) => {
            var { type, display, request } = e.data
            if ( type == 'start-auth' && this.state == PortalServerState.WaitingToStart ) {
                this.display = display
                // Attempt to look up any logins we have available at this
                // admin site.  If we have only one and it is logged in,
                // then continue. Otherwise, prompt

                // If no logins are available, then prompt for a login
                this.state = PortalServerState.LookingUpLogins;
                this.request = e.data
                this.origin = e.origin
                this.flocks = e.data.flocks

                Promise.all([lookupLogins(), lookupSavedPermissions(this.origin)])
                    .then(([logins, granted]) => {
                        this.logins = logins
                        this.granted = granted
                        this.respond = (r) => {
                            e.source.postMessage(r, e.origin)
                        }

                        console.log("Looked up permissions for ", this.origin, ":", this.granted)

                        this.required = Set(this.request.permissions).subtract(this.granted).toArray()

                        if ( logins.length == 0 ) {
                            // Prompt for a new login
                            this.state = PortalServerState.NewLogin;
                        } else if ( logins.length == 1 ) {
                            // Respond with success
                            var login = logins[0]
                            if ( login.isExpired ) {
                                this.state = PortalServerState.DisplayLogins;
                            } else {
                                this.selectLogin(login)
                            }
                        } else {
                            this.state = PortalServerState.DisplayLogins;
                        }

                        this.showDisplay()
                    })
            } else if ( type == 'finish-auth' ) {
                window.close()
            }
        })
    }

    selectLogin(login) {
        // Valid login... ask for confirmation
        // Attempt to login to server
        this.state = PortalServerState.Connecting;

        login.createClient()
            .then((client) => {
                this.flockClient = client
                this.continueWithClient()
            })
            .catch((e) => {
                this.state = PortalServerState.Error;
                this.error = e;
                this.showDisplay()
            })
    }

    showDisplay() {
        if ( this.display == PortalDisplay.Hidden )
            this.requestDisplay()
        else
            this.updateModal()
    }

    requestDisplay(source) {
        this.respond('show-portal')
    }

    showModal() {
        this.modalShown = true
        this.modalContainer = document.createElement('div')
        this.modalContainer.classList.add('kite-auth-modal-backdrop')

        document.body.classList.add('kite-portal-server')
        document.body.appendChild(this.modalContainer)
    }

    continueWithClient() {
        if ( this.required.length == 0 ) {
            // Grant all permissions and return
            this.onAccept(false)
        } else {
            this.makePreview()
        }
    }

    makePreview() {
        this.state = PortalServerState.LoadingTokenPreview;
        this.tokenPreview = null
        this.showDisplay()

        fetch('kite+app://admin.flywithkite.com/tokens/preview',
              { method: 'POST',
                headers: { 'Content-type': 'application/json' },
                body: JSON.stringify(this.mkTokenRequest(this.allRequestedPermissions,
                                                         this.request.ttl,
                                                         this.request.siteFingerprints)),
                kiteClient: this.flockClient })
            .then((r) => {
                this.state = PortalServerState.AskForConfirmation
                if ( r.status == 200 ) {
                    return r.json().then((preview) => {
                        this.tokenPreview = preview
                        this.showDisplay()
                    })
                } else {
                    this.tokenPreview = { error: `Invalid status: ${r.status}` }
                    this.showDisplay()
                }
            })
            .catch((e) => {
                this.state = PortalServerState.AskForConfirmation
                this.tokenPreview = { error: 'Error while getting permissions list' };
                this.showDisplay()
            })
    }

    onSuccess(flockClient) {
        this.flockClient = flockClient
        this.state = PortalServerState.AskForConfirmation

        // Request the nuclear permission for this computer

        getLoginsDb().then(getSite)
            .then((site) => {
                return  this.requestNuclear(site)
                    .then((nuclearToken) => { return { nuclearToken, site }; })
            })
            .then(({ nuclearToken, site }) => {
                var loginData = { persona_id: this.flockClient.personaId,
                                  flock: this.flockClient.flockUrl,
                                  appliance: this.flockClient.appliance,
                                  token: nuclearToken.token,
                                  exp: nuclearToken.expiration }
                var login = new Login(loginData, site)
                login.save()
            })
            .then(() => this.updateModal())
    }

    mkTokenRequest(perms, ttl, site) {
        return  {
            'permissions': perms,
            'ttl': ttl,
            'for_site': site
        }
    }

    requestPermissions(perms, ttl, site) {
        var tokenRequest = this.mkTokenRequest(perms, ttl, site)

        return fetch('kite+app://admin.flywithkite.com/tokens',
                     { method: 'POST',
                       headers: { 'Content-type': 'application/json' },
                       body: JSON.stringify(tokenRequest),
                       kiteClient: this.flockClient })
            .then((r) => {
                if ( r.status == 200 )
                    return r.json()
                if ( r.status == 400 ) {
                    return r.json()
                        .then((e) => {
                            if ( e['missing-apps'] ) {
                                return Promise.reject(new KiteMissingApps(e['missing-apps']))
                            } else {
                                console.error("Error minting token: ", e)
                                return Promise.reject(new KitePermissionsError('An unknown error occurred'))
                            }
                        })
                } else if ( r.status == 401 )
                    return Promise.reject(new KitePermissionsError('Not authorized to create this token'))
                else {
                    console.error("An unknown response code was received", r.status)
                    return Promise.reject(new KitePermissionsError('An unknown error occurred'))
                }
            })
    }

    requestNuclear(site) {
        return this.requestPermissions([ 'kite+perm://admin.flywithkite.com/login',
                                         'kite+perm://admin.flywithkite.com/site',
                                         'kite+perm://admin.flywithkite.com/nuclear' ],
                                       7 * 24 * 60 * 60, // One week
                                       site.getFingerprints().map(wrtcToKiteFingerprint).filter((c) => c !== null))

    }

    onResetLogins() {
        resetLogins()
            .then(() => {
                this.state = PortalServerState.NewLogin
                this.showDisplay()
            })
    }

    get allRequestedPermissions() {
        return [ 'kite+perm://admin.flywithkite.com/login',
                 'kite+perm://admin.flywithkite.com/site',
                 ...this.request.permissions ]
    }

    onAccept(shouldRememberPermissions) {
        // Attempt to make a token using this site ID
        var permissions = this.allRequestedPermissions

        this.requestPermissions(permissions, this.request.ttl, this.request.siteFingerprints)
            .then(({token, expiration}) => {
                var onComplete = Promise.resolve()

                if ( shouldRememberPermissions ) {
                    onComplete = rememberPermissions(this.origin, permissions)
                }

                return onComplete.then(() => {
                    expiration = new Date(expiration).getTime()
                    this.respond({ success: true,
                                   persona: this.flockClient.personaId,
                                   flockUrl: this.flockClient.flockUrl,
                                   applianceName: this.flockClient.appliance,
                                   exp: expiration, token })
                })
            }).catch((e) => {
                if ( e instanceof KiteMissingApps) {
                    this.state = PortalServerState.InstallAppsRequest
                    this.missingApps = e.missingApps
                } else if ( e instanceof KitePermissionsError ) {
                    this.state = PortalServerState.Error
                    this.error = `${e.message}`
                } else {
                    console.error("Got error", e)
                    this.state = PortalServerState.Error
                    this.error = "An unknown error occurred"
                }
                this.updateModal()
            })

        this.state = PortalServerState.MintingToken;
        this.updateModal();
    }

    filterPermissions(perms, apps) {
        return perms.filter((perm) => apps.some((app) => perm.startsWith(`kite+perm://${app}`)))
    }

    finishApplications() {
        var { complete, errors } =
            Object.values(this.applicationProgress)
            .reduce((({ complete, success, errors }, { finished, error }) => {
                return { complete: complete && (finished || error),
                         success: success && finished,
                         errors: errors || error }
            }), { complete: true, success: true, errors: false })

        console.log("Check finishApplications", complete, errors)

        if ( complete ) {
            if ( errors ) {
                this.state = PortalServerState.ApplicationInstallError
            } else {
                this.state = PortalServerState.ApplicationsSuccess
            }
            this.updateModal()
        }
    }

    doInstallApps(apps) {
        this.request.permissions = this.filterPermissions(this.request.permissions, apps)

        // Install the applications
        this.applicationProgress = {}
        apps.map((app) => {
            this.applicationProgress[app] = { total: 0, complete: 0 }
            updateApp(fetch, this.flockClient, app, (progress) => { this.applicationProgress[app] = progress; this.updateModal(); })
                .then(() => { this.applicationProgress[app] = { finished: true };
                              this.finishApplications();
                              this.updateModal(); })
                .catch((error) => { this.applicationProgress[app] = { error };
                                    this.finishApplications();
                                    this.updateModal(); })
        })
        this.state = PortalServerState.InstallingApplications
        this.updateModal()
    }

    cancelConnection() {
        this.state = PortalServerState.NewLogin;
        this.updateModal();
    }

    updateModal() {
        if ( !this.modalShown )
            this.showModal()

        switch ( this.state ) {
        case PortalServerState.NewLogin:
            ReactDom.render(React.createElement(AuthenticatorModal,
                                                { key: 'new-login',
                                                  origin: this.origin,
                                                  flocks: this.flocks,
                                                  onSuccess: this.onSuccess.bind(this) }),
                            this.modalContainer)
            break;

        default:
            ReactDom.render(React.createElement(PermissionsModal,
                                                { key: 'permissions',
                                                  state: this.state,
                                                  error: this.error,
                                                  logins: this.logins || [],
                                                  missingApps: this.missingApps,
                                                  appProgress: this.applicationProgress,
                                                  installApps: this.doInstallApps.bind(this),
                                                  tokenPreview: this.tokenPreview,
                                                  permissions: this.request.permissions,
                                                  onResetLogins: this.onResetLogins.bind(this),
                                                  onSuccess: this.onAccept.bind(this),
                                                  onRetryAfterInstall: this.onAccept.bind(this),
                                                  onChooseLogin: this.selectLogin.bind(this),
                                                  cancelConnection: this.cancelConnection.bind(this)
                                                }),
                            this.modalContainer)
            break;
        }
    }
}
