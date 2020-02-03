import { EventTarget } from "event-target-shim";

import React from 'react';
import ReactDom from 'react-dom';

import { FlockClient } from './FlockClient.js';
import { LoadingIndicator } from './react.js';

import "./Common.scss";
import "./Authenticator.scss";
import { PermissionsError, DelegatedTokenAuthenticator } from "./Portal.js";
import { lookupWellKnownFlock } from "./Permalink.js";
import { getAppliances, touchAppliance } from "./Logins.js";

function zp(l) {
    if ( l.length == 0 ) return '00';
    if ( l.length == 1 ) return `0${l}`;
    else return l
}

function lerp(t, s, e) {
    return Math.floor(s + t * (e - s))
}

export function makeAbsoluteUrl(url) {
    var a = document.createElement('a')
    a.href = url
    return `${a.href}`;
}

export function addTokens(tokens, options) {
    console.log("Adding tokens", tokens)
    return fetch('intrustd+app://admin.intrustd.com/me/tokens',
                 Object.assign({ body: JSON.stringify({tokens}),
                                 headers: { 'Content-type': 'application/json' },
                                 method: 'POST' }, options))
        .then((r) => {
            if ( r.status != 200 )
                r.text().then((details) => {
                    throw new PermissionsError(`Invalid status: ${r.status}: ${details}`)
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

    if ( options.delegationOk )
        request.delegation_ok = true

    var tokenPromise =
        fetch('intrustd+app://admin.intrustd.com/tokens',
                 { method: 'POST',
                   headers: { 'Content-type': 'application/json' },
                   body: JSON.stringify(request) })
        .then((r) => {
            switch ( r.status ) {
            case 200:
                return r.json().then(({token, delegated}) => {
                    if ( delegated && options.delegationOk ) {
                        return new Promise((resolve, reject) => {
                            var tokenAuth = new DelegatedTokenAuthenticator(r.intrustd, token)
                            var onError = (e) => {
                                tokenAuth.finish()
                                reject(new PermissionsError(e.msg))
                            }
                            var onSuccess = ({ permissionsAccepted, token }) => {
                                tokenAuth.finish()
                                if ( permissionsAccepted )
                                    resolve({token})
                                else
                                    reject(new PermissionsError('User rejected new permissions'))
                            }
                            tokenAuth.addEventListener('error', onError)
                            tokenAuth.addEventListener('success', onSuccess)
                        })
                    } else {
                        return { r, token }
                    }
                })
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
            var url
            if ( typeof flock == 'string' )
                url = flock;
            else {
                var protocol = flock.secure ? 'wss' : 'ws';
                var path = flock.path ? flock.path : '';
                url = `${protocol}://${flock.url}${path}`;
            }

            var client = new FlockClient({ url, appliance })

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
                                       var loginBox, avatar

                                       if ( this.state.selectedPersona == ix )
                                           loginBox = E('input', { className: 'intrustd-form-input intrustd-login-box-password', ref: this.passwordRef,
                                                                   onKeyDown: this.onKeyDown.bind(this),
                                                                   autoFocus: true,
                                                                   type: 'password', placeholder: 'Password' })

                                       if ( p.photo ) {
                                           avatar = E('div', { className: 'intrustd-avatar',
                                                               style: { backgroundImage: `url(${p.photo})` } })
                                       } else {
                                           var r, g, b

                                           r = parseInt(p.id.substring(0, 2), 16) / 255
                                           g = parseInt(p.id.substring(4, 6), 16) / 256
                                           b = parseInt(p.id.substring(10, 12), 16) / 256

                                           r = lerp(r, 76, 200)
                                           g = lerp(g, 76, 200)
                                           b = lerp(b, 76, 200)

                                           var sty =  { backgroundColor: `#${zp(r.toString(16))}${zp(g.toString(16))}${zp(b.toString(16))}` }

                                           avatar = E('div', { className: 'intrustd-avatar intrustd-avatar--initials',
                                                               style: sty },
                                                      p.displayname[0])
                                       }

                                       return E('li', {key: p.id, className: (this.state.selectedPersona == ix ? 'active' : ''),
                                                       onClick: () => { this.selectPersona(ix) }},
                                                avatar,
                                                E('div', { className: 'intrustd-login' },
                                                  E('div', {className: 'intrustd-display-name'}, p.displayname),
                                                  loginBox))
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

export class ReauthModal extends React.Component {
    constructor() {
        super ()
        this.passwordRef = React.createRef()
        this.state = { state: 'connecting' }
    }

    componentDidMount() {
        loginToAppliance([this.props.flock], this.props.appliance)
            .then((dev) => {
                this.setState({device: dev})
                return touchAppliance(this.props.appliance)
                    .then(() => this.findPersona(dev))
            })
            .catch((e) => {
                this.props.onApplianceNotFound()
            })
    }

    findPersona(dev) {
        var matching = dev.personas.filter(({id}) => id == this.props.persona)
        if ( matching.length == 0 )
            this.props.onApplianceNotFound()
        else {
            this.setState({ persona: matching[0],
                            state: 'login' })
        }
    }

    onKeyDown(e) {
        if ( e.keyCode == 13 )
            this.submit()
    }

    submit() {
        var pw = this.passwordRef.current.value;
        this.setState({state: 'authenticating'})
        console.log("Device", this.state.device)
        this.state.device.tryLogin(this.props.persona, `pwd:${pw}`)
            .then(() => {
                console.log("Signal success")
                this.props.onSuccess(this.state.device)
                this.setState({state: 'complete'})
            })
            .catch((e) => {
                this.setState({error: true, state: 'login'})
                this.passordRef.current.value = '';
            })
    }

    render() {
        const E = React.createElement
        var body, avatar, error

        switch ( this.state.state ) {
        case 'connecting':
            body = E(LoadingIndicator);
            break;
        case 'authenticating':
        case 'login':
            if ( this.state.persona.photo )
                avatar = E('div', { className: 'intrustd-avatar',
                                    style: { backgroundImage: `url(${this.state.persona.photo})` }})
            body = E('ul', { className: 'intrustd-list intrustd-persona-list' },
                     E('li', null,
                       avatar,
                       E('div', { className: 'intrustd-login' },
                         E('div', { className: 'intrustd-display-name' }, this.state.persona.displayname),
                         E('input', { className: 'intrustd-form-input',
                                      ref: this.passwordRef,
                                      disabled: this.state.state == 'authenticating',
                                      onKeyDown: this.onKeyDown.bind(this),
                                      autoFocus: true,
                                      type: 'password', placeholder: 'Password' }))),

                     this.state.state == 'authenticating' ? E(LoadingIndicator) : null )
        default:
        }

        if ( this.state.error )
            error = E('div', { className: 'intrustd-form-error' },
                      'Invalid credentials')

        return E('div', { className: 'intrust-auth-modal intrustd-modal' },
                 E('header', { className: 'intrustd-modal-header' },
                   E('h3', null, 'Confirm your identity')),
                 E('p', { className: 'intrustd-auth-explainer' },
                   this.props.explanation ||
                   'You need to confirm your identity to proceed'),
                 error,
                 E('div', { className: 'intrustd-login-form' },
                   E('div', { className: 'intrustd-form-row' },
                     body)))
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
                    if ( r.ok ) {
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
                     E('div', { className: 'form-group' },
                       E('input', { className: 'form-control', name: 'intrustd-password',
                                    autoFocus: true,
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
