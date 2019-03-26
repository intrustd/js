import { EventTarget } from "event-target-shim";

import React from 'react';
import ReactDom from 'react-dom';

import { FlockClient } from './FlockClient.js';

import "./Common.scss";
import "./Authenticator.scss";
import { PermissionsError } from "./Portal.js";
import { lookupWellKnownFlock } from "./Permalink.js";
import { getAppliances, touchAppliance } from "./Logins.js";

export function makeAbsoluteUrl(url) {
    var a = document.createElement('a')
    a.href = url
    return `${a.href}`;
}

export function addTokens(tokens, options) {
    return fetch('intrustd+app://admin.intrustd.com/me/tokens',
                 Object.assign({ data: JSON.stringify(tokens),
                                 headers: { 'Content-type': 'application/json' },
                                 method: 'POST' }, options))
        .then((r) => {
            if ( r.status != 200 )
                r.json().then((details) => {
                    throw new PermissionsError(`Invalid status: ${r.status}: ${JSON.stringify(details)}`)
                }, () => {
                    throw new PermissionsError(`Invalid status: ${r.status}`)
                })
        })
}

export function mintToken(perms, options) {
    var defaults = { format: 'raw', ttl: null, siteOnly: false }

    if ( options === undefined )
        options = {};

    options = Object.assign(defaults, options);

    var site

    if ( options.siteOnly ) {
        // Get site TODO
    }

    var request = { 'permissions': perms }
    if ( options.ttl !== undefined && options.ttl !== null )
        request.ttl = options.ttl
    if ( site !== undefined )
        request.site = site

    var tokenPromise =
        fetch('intrustd+app://admin.intrustd.com/tokens',
                 { method: 'POST',
                   headers: { 'Content-type': 'application/json' },
                   body: JSON.stringify(request) })
        .then((r) => {
            switch ( r.status ) {
            case 200:
                return r.json().then(({token}) => { return { r, token } })
            case 400:
                return Promise.reject(new PermissionsError("Unknown"))
            case 401:
                return Promise.reject(new PermissionsError("Not authorized to create this token"));
            default:
                return Promise.reject(new PermissionsError("Unknown"));
            }
        })

    return Promise.all([lookupWellKnownFlock().catch((e) => null), tokenPromise])
        .then(([ wellKnownFlock, {r, token} ]) => {
            if ( options.format == 'query' ) {
                var fields = []

                if ( options.requiresPersona )
                    fields.push(`persona=${encodeURIComponent(r.intrustd.persona)}`)

                console.log("Well-known flock is ", wellKnownFlock)
                console.log("Our flock is", r.intrustd.flock, wellKnownFlock == r.intrustd.flock)
                if ( options.requiresFlock || wellKnownFlock === null ||
                     wellKnownFlock != r.intrustd.flock )
                    fields.push(`flock=${encodeURIComponent(r.intrustd.flock)}`)

                fields.push(`appliance=${encodeURIComponent(r.intrustd.appliance)}`)
                fields.push(`token=${token}`)

                return `?${fields.join('&')}`
            } else if ( options.format == 'json' ) {
                var ret = { token, appliance: r.intrustd.appliance }
                if ( options.requiresPersona )
                    ret['persona'] = r.intrustd.persona
                return ret
            } else
                return token
        })
}

function loginToAppliance(flocks, appliance) {
    var attempts = flocks.map((flock, flockIndex) => () => {
        return new Promise((resolve, reject) => {
            var protocol = flock.secure ? 'wss' : 'ws';
            var path = flock.path ? flock.path : '';
            var client = new FlockClient({ url: `${protocol}://${flock.url}${path}`,
                                           appliance })

            var onError = (e) => {
                removeEventListeners()
                if ( (flockIndex + 1) == flocks.length ) {
		    console.log("Could not find flock. Looked in ", flocks);
                    reject()
                } else {
                    resolve(attempts[flockIndex + 1]())
                }
            }
            var onSuccess = () => {
                resolve(client)
            }
            var removeEventListeners = () => {
                client.removeEventListener('error', onError)
                client.removeEventListener('needs-personas', onSuccess)
            }

            client.addEventListener('error', onError)
            client.addEventListener('needs-personas', onSuccess)
        })
    })

    if ( attempts.length > 0 ) {
        return attempts[0]()
    } else
        return Promise.reject('no-flocks')
}

class AuthenticationEvent {
    constructor(dev) {
        this.type = 'open'
        this.device = dev
    }
}

export class AuthenticatorModal extends React.Component {
    constructor() {
        super()

        this.applianceNameRef = React.createRef()
        this.passwordRef = React.createRef()
        this.state = { }
    }

    componentDidMount() {
        getAppliances()
            .then((appliances) => { this.setState({ appliances }) })
    }

    render() {
        const E = React.createElement;

        var loading = this.state.loading;

        var goButton = 'Go'

        if ( loading ) {
            goButton = E('i', {className: 'fa fa-fw fa-3x fa-spin fa-circle-o-notch'})
        }

        var error

        if ( this.state.error ) {
            error = E('div', {className: 'intrustd-form-error'},
                      this.state.error)
        }

        var personas, appliances

        if ( typeof this.state.personas == 'object' ) {
            if ( this.state.personas.length == 0 ) {
            } else {
                personas = E('div', {className: 'intrustd-form-row'},
                             E('ul', {className: 'intrustd-list intrustd-persona-list'},
                               this.state.personas.map(
                                   (p, ix) => {
                                       var loginBox

                                       if ( this.state.selectedPersona == ix )
                                           loginBox = E('input', { className: 'intrustd-form-input', ref: this.passwordRef,
                                                                   onKeyDown: this.onKeyDown.bind(this),
                                                                   type: 'password', placeholder: 'Password' })

                                       return E('li', {key: p.id, className: (this.state.selectedPersona == ix ? 'active' : ''),
                                                       onClick: () => { this.selectPersona(ix) }},
                                                E('div', {className: 'intrustd-display-name'}, p.displayname),
                                                loginBox)
                                   })))
            }
        } else if ( typeof this.state.appliances == 'object' ) {
            appliances = E('div', { className: 'intrustd-form-row' },
                           E('ul', { className: 'intrustd-list intrustd-appliance-list' },
                             this.state.appliances.map(
                                 (app, ix) =>
                                     E('li', { key: app.appliance_name,
                                               onClick: () => { this.continueLogin(app.appliance_name) } },
                                       E('span', { className: 'intrustd-appliance-name' }, app.appliance_name),
                                       E('span', { className: 'intrustd-appliance-last-login'}, app.last_auth_time.toString()))
                             )))
        } else
            appliances = E('div', { className: 'intrustd-form-row' },
                           E('i', { className: 'fa fa-fw fa-3x fa-spin fa-circle-o-notch' }))

        var origin = this.props.origin || location.origin;

        return E('div', {className: 'intrustd-auth-modal intrustd-modal'},
                 E('header', {className: 'intrustd-modal-header'},
                   E('h3', null, 'Authenticate with Intrustd')),
                 E('p', {className: 'intrustd-auth-explainer'},
                   `The page at ${origin} is requesting to log in to your Intrustd device.`),
                 E('div', {className: 'intrustd-login-form'},
                   error,
                   E('div', {className: 'intrustd-form-row'},
                     E('div', {className: 'form-control'},
                       E('input', {className: 'form-input', disabled: this.state.loading,
                                   name: 'appliance-name', id: 'appliance-name',
                                   placeholder: 'Appliance Name',
                                   ref: this.applianceNameRef,
                                   onKeyDown: this.onKeyDown.bind(this) }))),
                   appliances,
                   personas,
                   E('div', {className: 'intrustd-form-row'},
                     E('button', {className: `intrustd-form-submit ${loading ? 'intrustd-form-submit--loading' : ''}`,
                                  disabled: loading,
                                  onClick: () => this.continueLogin() },
                       goButton))));
    }

    selectPersona(ix) {
        this.setState({selectedPersona: ix})
    }

    onKeyDown({keyCode}) {
        if ( keyCode == 13 )
            this.continueLogin()
    }

    continueLogin(applianceName) {
        if ( applianceName === undefined ) {
            applianceName = this.applianceNameRef.current.value
        } else
            this.applianceNameRef.current.value = applianceName

        if ( this.state.state == 'login' ) {
            var personaId = this.state.personas[this.state.selectedPersona].id

            this.setState({loading: true})
            this.state.device.tryLogin(personaId, `pwd:${this.passwordRef.current.value}`)
                .then(() => this.props.onSuccess(this.state.device),
                      (e) => this.setState({device: undefined, personas: undefined, loading: false,
                                            error: 'Invalid login', state: 'connecting'}))
        } else {
            this.setState({loading: true})

            loginToAppliance(this.props.flocks, applianceName)
                .then((dev) => (touchAppliance(applianceName)
                                .then(() => this.getPersonas(dev))))
                .catch((e) => {
                    this.setState({loading: false,
                                   error: 'Could not find appliance'})
                })
        }
    }

    getPersonas(dev) {
        console.log("Got device", dev, dev.personas.length)
        this.setState({loading: false, error: false, state: 'login',
                       personas: dev.personas, device: dev})
    }
}

export class Authenticator extends EventTarget('open', 'error') {
    constructor(flocks, site) {
        super();

        this.modalContainer = document.createElement("div");
        this.modalContainer.classList.add("intrustd-modal-backdrop");

        document.body.appendChild(this.modalContainer)

        ReactDom.render(React.createElement(AuthenticatorModal,
                                            { flocks: flocks,
                                              onError: this.onError.bind(this),
                                              onSuccess: this.onSuccess.bind(this) }),
                        this.modalContainer)
    }

    hide() {
        document.body.removeChild(this.modalContainer)
        delete this.modalContainer
    }

    onError() {
        this.hide()
        this.dispatchEvent(new Event('error'))
    }

    onSuccess(dev) {
        this.hide()
        this.dispatchEvent(new AuthenticationEvent(dev))
    }
}

class LoginBox extends React.Component {
    constructor() {
        super()

        this.passwordBoxRef = React.createRef()
        this.state = { loading: false }
    }

    componentWillUnmount() {
        if ( this.props.onComplete )
            this.props.onComplete()
    }

    onKeyDown({keyCode}) {
        if ( keyCode == 13 )
            this.submit()
    }

    cancel() {
        this.props.onCancel()
    }

    submit() {
        var pw = this.passwordBoxRef.current.value

        if ( !this.state.loading ) {
            this.setState({loading: true})
            fetch('intrustd+app://admin.intrustd.com/login',
                  { method: 'POST',
                    body: pw })
                .then((r) => {
                    if ( r.status == 200 ) {
                        this.props.onSuccess()
                        this.setState({loading: false})
                    } else {
                        this.setState({loading: false,
                                       error: true})
                        this.passwordBoxRef.current.value = ""
                    }
                })
        }
    }

    render() {
        const E = React.createElement
        var { loading } = this.state

        var error

        if ( this.state.error ) {
            error = E('div', { className: 'intrustd-form-error' },
                      'Invalid credentials')
        }

        return E('div', { className: 'intrustd-login-modal intrustd-modal' },
                 E('header', { className: 'intrustd-modal-header' },
                   E('h3', null, 'Authorization')),
                 E('p', { className: 'intrustd-login-explainer' },
                   'Please enter your password to complete this action'),
                 error,
                 E('div', { className: 'intrustd-login-form' },
                   E('div', { className: 'intrustd-form-row' },
                     E('div', { className: 'form-control' },
                       E('input', { className: 'form-input', name: 'intrustd-password',
                                    placeholder: 'Password', type: 'password',
                                    ref: this.passwordBoxRef,
                                    onKeyDown: this.onKeyDown.bind(this) }))),
                   E('div', { className: 'intrustd-form-row' },
                     E('button', { className: `intrustd-form-cancel ${loading ? 'intrustd-form-cancel--loading' : '' }`,
                                   disabled: loading,
                                   onClick: this.cancel.bind(this) },
                       'Cancel'),
                     E('button', { className: `intrustd-form-submit ${loading ? 'intrustd-form-submit--loading' : '' }`,
                                   disabled: loading,
                                   onClick: this.submit.bind(this) },
                       'Login'))))
    }
}

export function attemptLogin() {
    var modalContainer = document.createElement("div");
    modalContainer.classList.add("intrustd-modal-backdrop")

    document.body.appendChild(modalContainer)

    var onComplete = () => { document.body.removeChild(modalContainer) }

    return new Promise((resolve, reject) => {
        ReactDom.render(React.createElement(LoginBox, {
            onComplete,
            onSuccess: () => { resolve(true); onComplete() },
            onCancel: () => { resolve(false); onComplete() }
        }), modalContainer)
    })
}
