import { EventTarget } from 'event-target-shim';
import React from 'react';
import ReactDom from 'react-dom';
import { Set } from 'immutable';

import { Login, lookupLogins, lookupLogin, getSite, getLoginsDb,
         resetLogins, rememberPermissions, lookupSavedPermissions } from './Logins.js';
import { AuthenticatorModal, ReauthModal } from './Authenticator.js';
import { parseAppUrl, getCertificateFingerprints } from './polyfill/Common.js';
import { updateApp, AppInstallItem } from './polyfill/Updates.js';
import { LoadingIndicator } from './react.js';

import './Portal.scss';

const E = React.createElement

const needsNewFrame =  navigator.userAgent.match(/Firefox|Safari/) !== null;

class MissingApps {
    constructor (missingApps) {
        this.missingApps = missingApps
    }
}

export class PermissionsError {
    constructor (msg) {
        this.message = msg
    }
}

function wrtcToFingerprint({ algorithm, value }) {
    const AlgMapping = { 'sha-256': 'SHA256' }

    if ( AlgMapping.hasOwnProperty(algorithm) ) {
        return `${AlgMapping[algorithm]}:${value.replace(/:/g, '')}`
    } else
        return null
}

function findPortalApp(flocks, oldFetch) {
    var attempts = flocks.map((flock, ix) => () => {
        var proto = '', url
        if ( typeof flock == "string" ) {
            var flockUrl = new URL(flock, location.href)
            if ( flockUrl.protocol == 'wss:' || flockUrl.protocol == 'https:' ) {
                proto = 'https:';
            }
            url = flockUrl.host;
        } else {
            url = flock.url
            if ( flock.secure ) {
                proto = 'https:';
            }
        }

        return oldFetch(`${proto}//${url}/portal`,
                 { method: 'GET' })
            .then((rsp) => rsp.text())
            .then((portalUrl) => `${portalUrl}#intrustd-auth`)
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
    iframe.className = 'intrustd-hidden-iframe';

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

class LoginList extends React.Component {
    render() {
        return E('ul', { className: 'intrustd-list intrustd-login-list' },
                 this.props.logins.map((login) => {
                     return E('li', { key: login.key,
                                      onClick: () => { this.props.onSelect(login) }},
                              E('span', { className: 'intrustd-appliance-name' }, login.applianceName),
                              E('span', { className: 'intrustd-login-expiration' }, `${login.expiration}`))
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
            explanation = E('div', { className: 'intrustd-form-row', key: 'choose-login'  },
                            'You are currently logged in to multiple Intrustd appliances. Select which login you\'d like to use',
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
            explanation = [ E(LoadingIndicator, { key: 'connecting-animation' }),
                            E(DelayedGroup, { delay: 5000, key: 'connecting-delay-message' },
                              E('p', null, 'This seems to be taking a bit, click ',
                                E('a', { href: '#', onClick: this.props.requestNewLogin }, 'here'),
                                ' to reconnect')) ];
            break;
        }

        return E('div', { className: 'intrustd-auth-modal intrustd-modal' },
                 E('header', { className: 'intrustd-modal-header' },
                   E('h3', {}, 'Authenticating with Intrustd')),
                 E('p', { className: 'intrustd-auth-explainer' },
                   explanation))
    }
}

class PortalAuthOpensEvent {
    constructor(client) {
        this.type = 'open';
        this.device = client;
    }
}

class DelegationFailedEvent {
    constructor(msg) {
        this.type = 'error';
        this.msg = msg;
    }
}

class DelegationSucceededEvent {
    constructor({token, persona, flockUrl, applianceName, exp}) {
        this.permissionsAccepted = true
        this.type = 'success'
        this.token = token
        this.persona = persona
        this.flock = flockUrl
        this.appliance = applianceName
        this.exp = exp
    }
}

class DelegationRejectedEvent {
    constructor() {
        this.type = 'success'
        this.permissionsAccepted = false
    }
}

export class DelegatedTokenAuthenticator extends EventTarget('success', 'error') {
    constructor(intrustd, token) {
        super()
        var {flock, persona, appliance} = intrustd
        this.token = token
        this.flock = flock
        this.persona = persona
        this.appliance = appliance
        findPortalApp([flock], fetch)
            .then(({flock, portalUrl}) => {
                this.portalUrl = portalUrl
                this.portalOrigin = (new URL(portalUrl)).origin

                console.log("Got portal", portalUrl)
                if ( needsNewFrame ) {
                    this.attachWindowMessageHandler()
                    this.openPopup();
                } else
                    return openPortalFrame(portalUrl).then((iframe) => {
                        this.portalFrame = iframe
                        this.attachWindowMessageHandler()
                        this.startDelegatedAuth()
                    })
            })
    }

    finish() {
        if ( this.windowMessageHandler !== undefined ) {
            window.removeEventListener('message', this.windowMessageHandler)
            delete this.windowMessageHandler
        }

        if ( this.modalContainer !== undefined )
            this.hide()

        if ( this.portalFrame !== undefined &&
             this.portalFrame instanceof HTMLIFrameElement ) {
            this.portalFrame.parentNode.removeChild(this.portalFrame)
            delete this.portalFrame
        } else if ( this.portalFrame !== undefined ) {
            this.portalFrameWindow.contentWindow.postMessage({ type: 'finish-auth' }, this.portalOrigin)
        }
    }

    hide() {
        document.body.removeChild(this.modalContainer)
        delete this.modalContainer
    }

    attachWindowMessageHandler () {
        if ( this.windowMessageHandler === undefined ) {
            this.windowMessageHandler = this.onWindowMessage.bind(this)
            window.addEventListener('message', this.windowMessageHandler)
        }
    }

    onWindowMessage(msg) {
        if ( msg.origin == this.portalOrigin ) {
            if ( msg.data == 'no-such-login' ) {
                this.dispatchEvent(new DelegationFailedEvent('No such login'))
            } else if ( msg.data == 'no-such-delegation' ) {
                this.dispatchEvent(new DelegationFailedEvent(`No such delegation: ${this.token}`))
            } else if ( msg.data == 'show-portal' ) {
                this.showPortal()
            } else {
                if ( msg.data.success ) {
                    this.dispatchEvent(new DelegationSucceededEvent(msg.data))
                } else {
                    this.dispatchEvent(new DelegationRejectedEvent())
                }
            }
        } else
            console.log("Ignoring message with wrong origin", msg)
    }

    showPortal() {
        if ( this.portalFrame instanceof HTMLIFrameElement ) {
            console.log(this.portalFrame, this.portalFrame.parentNode)
            this.portalFrame.parentNode.removeChild(this.portalFrame)
            delete this.portalFrame
        }

        this.openPopup()
    }

    openPopup() {
        this.portalFrame = window.open(this.portalUrl, 'intrustd-login-popup', 'width=500,height=500')
        if ( this.portalFrame === null ) {
            this.state = PortalModalState.NeedsPopup
            this.doPopup = () => this.openPopup()
            this.render()
        } else {
            this.state = PortalModalState.RequestingPermissions
            this.requestDelegatedAuth()
        }
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

    requestDelegatedAuth() {
        // TODO timeout until this succeeds
        setTimeout(() => { this.startDelegatedAuth() }, 500)
    }

    startDelegatedAuth(flock, persona, appliance, token) {
        var { contentWindow, display } = this.portalFrameWindow
        var { token, flock, persona, appliance } = this

        console.log("Starting delegated auth again")

        contentWindow.postMessage({ type: 'start-delegation', display,
                                    token, flock, persona, appliance },
                                  this.portalOrigin)
    }
}

export class PortalAuthenticator extends EventTarget('open', 'error') {
    constructor(flocks, site, oldFetch, permissions) {
        super()

        this.modalContainer = document.createElement("div");
        this.modalContainer.classList.add("intrustd-modal-backdrop");

        document.body.appendChild(this.modalContainer)

        this.logins = null

        this.state = PortalModalState.LookingUpPortal
        this.permissions = permissions
        this.render()

        Promise.all([findPortalApp(flocks, oldFetch),
                     getLoginsDb().then(
                         (db) => getSite(db).then(
                             (site) => lookupLogins(db).then(
                                 (logins) => { return { db, site, logins } }))) ])
            .then(([{flock, portalUrl}, {db, site, logins}]) => {
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

        getCertificateFingerprints(this.site).then((fps) => {
            contentWindow.postMessage(
                { type: 'start-auth',
                  permissions: this.permissions,
                  ttl: 30 * 60, // TODO accept as an argument
                  siteFingerprints: fps.map(wrtcToFingerprint).filter((c) => c !== null),
                  flocks: [ this.chosenFlock ],
                  display },
                this.portalOrigin)
        })
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
        this.portalFrame = window.open(src, 'intrustd-login-popup', 'width=500,height=500')
        if ( this.portalFrame === null ) {
            this.state = PortalModalState.NeedsPopup
            this.doPopup = () => this.openPopup()
        } else {
            this.state = PortalModalState.RequestingPermissions
            this.requestPortalAuth()
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
        return E('ul', {className: 'intrustd-list intrustd-permission-list'},
                 this.props.tokenPreview.sections.map(({domain, entries, icon, name, version}) => {
                     var iconEl
                     if ( icon !== undefined )
                         iconEl = E('div', { className: 'app-icon' },
                                    E('img', { src: icon }))

                     var r = [ E('li', { className: 'intrustd-permission-header intrustd-list-header', key: `header-${domain}` },
                                 iconEl,
                                 E('span', { className: 'app-name' }, name)) ]

                     entries.map(({short, long, icon}, i) => {
                         r.push(E('li', { className: 'intrustd-permission', key: `perm-${domain}-${i}` }, short))
                     })

                     return r
                 }))
    }

    render() {
        var body
        var loading = false

        switch ( this.props.state ) {
        case PortalServerState.WaitingToStart:
            body = [ E('p', {className: 'intrustd-auth-explainer'},
                       'Logging in to appliance...'),

                     E('button', { className: 'uk-button uk-button-primary' },
                       'Settings...') ]
            break;
        case PortalServerState.Error:
            body = [ E('p', {className: 'intrustd-auth-explainer'},
                       'Error: ', `${this.props.error}`),

                     E('button', { type: 'button',
                                   className: 'uk-button uk-button-primary',
                                   onClick: this.props.onResetLogins },
                       'Try again') ]
            break;
        case PortalServerState.Connecting:
            body = [ E(LoadingIndicator),
                     E(DelayedGroup, { delay: 5000 },
                       E('p', null,
                         'This seems to be taking a while. Click ',
                         E('a', { href: '#', onClick: this.props.cancelConnection }, 'here'),
                         ' to try a new set of credentials'))
                   ]
            break;
        case PortalServerState.DisplayLogins:
            body = E('p', {className: 'intrustd-auth-explainer'},
                     'You are currently logged in to multiple Intrustd appliances. Select which login you\'d like to use',
                     E(LoginList, { logins: this.props.logins,
                                    onSelect: this.props.onChooseLogin }))
            break;
        case PortalServerState.LoadingTokenPreview:
            body = E(LoadingIndicator, { key: 'loading-preview' })
            break;
        case PortalServerState.AskForConfirmation:
            if ( this.props.tokenPreview && this.props.tokenPreview.error === undefined ) {
                body = [ E('p', { className: 'intrustd-auth-explainer' },
                           `The page at ${this.props.origin} is asking for permission to access your Intrustd device`),
                         this.renderPermissionsList(),
                         E('div', {className: 'intrustd-form-row'},
                           E('label', { className: 'uk-form-label' },
                             E('input', { type: 'checkbox', className: 'uk-checkbox', ref: this.rememberPermissionsRef }),
                             'Remember these permissions')),
                         E('div', {className: 'intrustd-form-row'},
                           E('button', {className: `intrustd-form-submit ${loading ? 'intrustd-form-submit--loading' : ''}`,
                                        disabled: loading,
                                        onClick: () => this.acceptPermissions() },
                             'Accept')) ]
            } else {
                var error = 'Error fetching permissions preview';
                if ( this.props.tokenPreview !== undefined && typeof this.props.tokenPreview.error == 'string' ) {
                    error = this.props.tokenPreview.error
                }
                body = [ E('p', null, error) ]
            }
            break;

        case PortalServerState.InstallingApplications:
        case PortalServerState.ApplicationInstallError:
        case PortalServerState.ApplicationsSuccess:
            body = [ E('div', { className: 'intrustd-form-row', key: 'app-list' },
                       E('ul', { className: 'intrustd-list intrustd-app-list' },
                         this.props.missingApps.map(
                             (a) => {
                                 if ( this.props.appProgress.hasOwnProperty(a) ) {
                                     return E('li', { key: a,
                                                      className: 'intrustd-app-container--installing' },
                                              E(AppInstallItem, { app: a, installing: true,
                                                                  progress: this.props.appProgress[a] }));
                                 }
                             }))
                      ),

                     (this.props.state == PortalServerState.ApplicationInstallError ?
                      E('div', { className: 'intrustd-form-row', key: 'confirm-list' },
                        E('button', { className: 'uk-button uk-button-danger',
                                      onClick: this.props.installApps },
                          E('i', { className: 'fa fa-fw fa-refresh' }),
                          ' Retry')) : null ),

                     (this.props.state == PortalServerState.ApplicationsSuccess ?
                      E('div', { className: 'intrustd-form-row', key: 'confirm-list' },
                        E('button', { className: 'uk-button uk-button-primary',
                                      onClick: this.props.onRetryAfterInstall },
                          E('i', { className: 'fa fa-fw fa-check' }),
                          'Continue')) : null)
                   ];

            break;

        case PortalServerState.InstallAppsRequest:
            var missingAppsSet = Set(this.props.missingApps)
            var appsLeft = missingAppsSet.isSuperset(this.state.deselectedApps) && !this.state.deselectedApps.isSuperset(missingAppsSet)

            body = [ E('p', { className: 'intrustd-auth-explainer', key: 'request-explainer' },
                       'The following applications are not installed on your appliance. Would you like to install them now?'),
                     E('div', { className: 'intrustd-form-row', key: 'apps-list' },
                       E('ul', { className: 'intrustd-list intrustd-app-list' },
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
                                           className: (!this.state.deselectedApps.contains(a)) ? 'intrustd-app-container--selected' : '' },
                                   E(AppInstallItem, { app: a, selected: !this.state.deselectedApps.contains(a) }))))),
                     E('div', { className: 'intrustd-form-row' },
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

        return E('div', {className: 'intrustd-auth-modal intrustd-modal'},
                 E('header', {className: 'intrustd-modal-header'},
                   E('h3', {}, 'Authenticate with Intrustd')),
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
    Relogin: Symbol('Relogin'),
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
        console.log("Starting portal server")
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
            } else if ( type == 'start-delegation' && this.state == PortalServerState.WaitingToStart ) {
                console.log("Start delegation")
                this.state = PortalServerState.LookingUpLogins
                this.delegated = true
                this.delegationToken = e.data.token
                this.display = e.data.display
                this.origin = e.origin
                this.flock = e.data.flock
                this.persona = e.data.persona
                this.appliance = e.data.appliance
                this.respond = (r) => {
                    e.source.postMessage(r, e.origin)
                }
                lookupLogin(e.data.persona, e.data.flock, e.data.appliance)
                    .then((login) => {
                        this.selectLoginForDelegation(login)
                        this.showDisplay()
                    }, (e) => {
                        this.state = PortalServerState.Relogin
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

    selectLoginForDelegation(login) {
        this.state = PortalServerState.Connecting;

        console.log("Creating login client")
        login.createClient()
            .then((client) => {
                this.flockClient = client
                //                this.makePreview()
                this.continueWithDelegation()
            })
            .catch((e) => {
                this.state = PortalServerState.Error;
                this.error = e;
                this.showDisplay()
            })
    }

    continueWithDelegation() {
        var permissionsPromise =
            fetch(`intrustd+app://admin.intrustd.com/tokens/delegated/${this.delegationToken}`,
                  { method: 'GET' })
            .then((r) => {
                if ( r.ok ) {
                    return r.json().then((r) => {
                        console.log("GOt perms", r)
                        return r
                    })
                } else
                    return Promise.reject()
            })

        Promise.all([permissionsPromise,
                     lookupSavedPermissions(this.origin)])
            .then(([neededPerms, granted]) => {
                console.log("Needed", neededPerms, "granted", granted)
                this.required = Set(neededPerms.perms).subtract(granted).toArray()
                if ( this.required.length == 0 ) {
                    this.mintDelegatedToken()
                } else {
                    this.tokenPreview = neededPerms
                    this.state = PortalServerState.AskForConfirmation
                    this.showDisplay()
                }
            })
            .catch((e) => {
                console.error(e)
                this.respond('no-such-delegation')
            })
    }

    mintDelegatedToken(shouldRememberPermissions) {
        fetch(`intrustd+app://admin.intrustd.com/tokens/delegated/${this.delegationToken}`,
              { method: 'POST' })
            .then((r) => {
                if ( r.ok ) {
                    var onComplete = Promise.resolve();

                    if ( shouldRememberPermissions ) {
                        onComplete = rememberPermissions(this.origin, this.tokenPreview.perms)
                    }

                    console.log("Got delegated token")

                    return onComplete.then(() => r.json())
                        .then(({token, expiration}) => {
                            this.respond({ success: true,
                                           persona: this.flockClient.personaId,
                                           flockUrl: this.flockClient.flockUrl,
                                           applianceName: this.flockClient.appliance,
                                           exp: new Date(expiration).getTime(), token })
                    })
                } else {
                    this.respond({ success: false })
                }
            })
    }

    showDisplay() {
        if ( this.display == PortalDisplay.Hidden ) {
            this.requestDisplay()
        } else
            this.updateModal()
    }

    requestDisplay(source) {
        this.respond('show-portal')
    }

    showModal() {
        this.modalShown = true
        this.modalContainer = document.createElement('div')
        this.modalContainer.classList.add('intrustd-auth-modal-backdrop')

        document.body.classList.add('intrustd-portal-server')
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
        var fetchOpts = { method: 'POST',
                          headers: { 'Content-type': 'application/json' },
                          appClient: this.flockClient },
            url = 'intrustd+app://admin.intrustd.com/tokens/preview'

        this.state = PortalServerState.LoadingTokenPreview
        this.tokenPreview = null
        this.showDisplay()

        if ( this.delegated ) {
            url = `intrustd+app://admin.intrustd.com/tokens/delegated/${this.delegationToken}`
            fetchOpts.method = 'GET'
        } else
            fetchOpts.body = JSON.stringify(this.mkTokenRequest(this.allRequestedPermissions,
                                                                this.request.ttl,
                                                                this.request.siteFingerprints))

        fetch(url, fetchOpts)
            .then((r) => {
                var badStatus = () => {
                    this.state = PortalServerState.AskForConfirmation
                    this.tokenPreview = { error: `Invalid status: ${r.status}` }
                    this.showDisplay()
                }
                if ( r.status == 200 ) {
                    return r.json().then((preview) => {
                        this.state = PortalServerState.AskForConfirmation
                        this.tokenPreview = preview
                        this.showDisplay()
                    }, (e) => {
                        this.state = PortalServerState.AskForConfirmation
                        this.tokenPreview = { error: `Failed to parse response: ${e}` }
                        this.showDisplay()
                    })
                } else if ( r.status == 400 ) {
                    r.json().then((e) => {
                        if ( e['missing-apps'] ){
                            this.onMissingApps(e['missing-apps'])
                        } else
                            badStatus()
                    })
                } else
                    badStatus()
            })
            .catch((e) => {
                console.error("Could not fetch token preview:", e)
                this.state = PortalServerState.AskForConfirmation
                this.tokenPreview = { error: 'Error while getting permissions list' };
                this.showDisplay()
            })
    }

    badLogin() {
        this.respond('no-such-login')
    }

    createNewLogin(flockClient) {
        this.flockClient = flockClient
        this.state = PortalServerState.MintingToken

        // Request the nuclear permission for this computer

        console.log("Creating new token", flockClient)
        return getLoginsDb().then(getSite)
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

                this.makePreview()

                return login
            })
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

        return fetch('intrustd+app://admin.intrustd.com/tokens',
                     { method: 'POST',
                       headers: { 'Content-type': 'application/json' },
                       body: JSON.stringify(tokenRequest),
                       appClient: this.flockClient })
            .then((r) => {
                if ( r.status == 200 )
                    return r.json()
                if ( r.status == 400 ) {
                    return r.json()
                        .then((e) => {
                            if ( e['missing-apps'] ) {
                                return Promise.reject(new MissingApps(e['missing-apps']))
                            } else {
                                console.error("Error minting token: ", e)
                                return Promise.reject(new PermissionsError('An unknown error occurred'))
                            }
                        })
                } else if ( r.status == 401 )
                    return Promise.reject(new PermissionsError('Not authorized to create this token'))
                else {
                    console.error("An unknown response code was received", r.status)
                    return Promise.reject(new PermissionsError('An unknown error occurred'))
                }
            })
    }

    requestNuclear(site) {
        return getCertificateFingerprints(site).then((fps) => {
            return this.requestPermissions([ 'intrustd+perm://admin.intrustd.com/login',
                                             'intrustd+perm://admin.intrustd.com/site',
                                             'intrustd+perm://admin.intrustd.com/nuclear' ],
                                           7 * 24 * 60 * 60, // One week
                                           fps.map(wrtcToFingerprint).filter((c) => c !== null))
        })
    }

    onResetLogins() {
        resetLogins()
            .then(() => {
                this.state = PortalServerState.NewLogin
                this.showDisplay()
            })
    }

    get allRequestedPermissions() {
        return [ 'intrustd+perm://admin.intrustd.com/login',
                 'intrustd+perm://admin.intrustd.com/site',
                 ...this.request.permissions ]
    }

    onMissingApps(missing) {
        this.state = PortalServerState.InstallAppsRequest
        this.missingApps = missing
        this.updateModal()
    }

    onAccept(shouldRememberPermissions) {
        if ( this.delegated ) {
            this.mintDelegatedToken(shouldRememberPermissions)
        } else {
            this.mintNewToken(shouldRememberPermissions)
        }
    }

    mintNewToken(shouldRememberPermissions) {
        // Attempt to make a token using this site ID
        var permissions = this.allRequestedPermissions
        var mintTokenPromise

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
                if ( e instanceof MissingApps) {
                    this.onMissingApps(e.missingApps)
                } else if ( e instanceof PermissionsError ) {
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
        return perms.filter((perm) => apps.some((app) => perm.startsWith(`intrustd+perm://${app}`)))
    }

    finishApplications() {
        var { complete, errors } =
            Object.values(this.applicationProgress)
            .reduce((({ complete, success, errors }, { finished, error }) => {
                return { complete: complete && (finished || error),
                         success: success && finished,
                         errors: errors || error }
            }), { complete: true, success: true, errors: false })

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

        console.log("Update modal", this)

        switch ( this.state ) {
        case PortalServerState.NewLogin:
            ReactDom.render(React.createElement(AuthenticatorModal,
                                                { key: 'new-login',
                                                  origin: this.origin,
                                                  flocks: this.flocks,
                                                  onSuccess: this.createNewLogin.bind(this) }),
                            this.modalContainer)
            break;

        case PortalServerState.Relogin:
            ReactDom.render(React.createElement(ReauthModal,
                                                { key: 'relogin',
                                                  origin: this.origin,
                                                  flock: this.flock,
                                                  appliance: this.appliance,
                                                  persona: this.persona,
                                                  onSuccess: this.createNewLogin.bind(this),
                                                  onApplianceNotFound: this.badLogin.bind(this) }),
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
                                                  onResetLogins: this.onResetLogins.bind(this),
                                                  onSuccess: this.onAccept.bind(this),
                                                  onRetryAfterInstall: this.makePreview.bind(this),
                                                  onChooseLogin: this.selectLogin.bind(this),
                                                  cancelConnection: this.cancelConnection.bind(this)
                                                }),
                            this.modalContainer)
            break;
        }
    }
}
