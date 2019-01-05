import React from 'react';

import { parseKiteAppUrl } from './polyfill/Common.js';

import './react.scss';

function getXhrImage(xhr, opts) {
    xhr.response
}

const E = React.createElement;

export class KiteLoadingIndicator extends React.Component {
    render() {
        return E('span', { className: 'kite-connecting' },
                 E('i', { className: 'kite-connecting-dot' }),
                 E('i', { className: 'kite-connecting-dot' }),
                 E('i', { className: 'kite-connecting-dot' }))
    }
}

export class KiteUploadButton extends React.Component {
    constructor() {
        super()
        this.upload = React.createRef();
    }

    startUpload() {
        this.upload.current.click()
    }

    doUpload() {
        if ( !this.props.hasOwnProperty('onUpload') )
            console.error("<KiteUploadButton> expects 'onUpload={...}' property")
        else
            this.props.onUpload(this.upload.current.files)
    }

    render() {
        var attrs = Object.assign({}, this.props)
        delete attrs.elName
        delete attrs.name
        delete attrs.onUpload
        attrs.onClick = (e) => { this.startUpload(e) }

        return E(this.props.elName, attrs,
                 E('input', {type: 'file', multiple: true, style: { display: 'none'},
                             name: this.props.name,
                             ref: this.upload, onChange: (e) => { this.doUpload(e) } }),
                 this.props.children)
    }
}

export class KiteImage extends React.Component {
    constructor() {
        super()
        this.state = {
            firstLoad: false,
            srcUrl: null,
            curBlob: null
        };
    }

    componentDidMount () {
        this.updateSource(this.props.src)
    }

    componentWillUnmount() {
        this.freeBlob()
    }

    freeBlob() {
        if ( this.state.isBlob ) {
            URL.revokeObjectURL(this.state.srcUrl)
            this.setState({ isBlob: false, srcUrl: null })
        }
    }

    componentDidUpdate(oldProps, oldState, snapshot) {
        if ( oldProps.src != this.props.src )
            this.updateSource(this.props.src)
    }

    dispatchFirstLoad() {
        if ( !this.state.firstLoad ) {
            this.setState({firstLoad: true})
            if ( this.props.onFirstLoad )
                this.props.onFirstLoad()
        }
    }

    updateSource(newSrc) {
        this.freeBlob()

        this.setState({srcUrl: null, isBlob: false})
        var parsed = parseKiteAppUrl(newSrc)
        fetch(newSrc, { method: 'GET',
//                        kiteOnPartialLoad: (e) => {
//                            var req = e.request
//                            var newBlob =  URL.createObjectURL(req.currentBody)
//                            this.freeBlob()
//
//                            console.log("New blob for ", this.props.src, " ", newBlob)
//                            this.setState({ srcUrl: newBlob,
//                                            isBlob: true })
//                            this.dispatchFirstLoad()
//                        }
                      })
            .then((d) => d.blob().then((b) => {
                return {contentType: d.headers.get('content-type'),
                        blob: b}
            }))
            .then(({contentType, blob}) => {
                var curBlob = URL.createObjectURL(blob);
                this.setState({srcUrl: curBlob,
                               isBlob: true})

                this.dispatchFirstLoad()
            })
    }

    render () {
        if ( this.state.srcUrl ) {
            var props = Object.assign({}, this.props);
            delete props.src;
            delete props.onFirstLoad
            props.src = this.state.srcUrl;

            return E('img', props);
        } else
            return E('span', null, 'loading');
    }
}

export class KiteForm extends React.Component {
    constructor () {
        super()
        this.formRef = React.createRef()
    }

    reset() {
        this.formRef.current.reset()
    }

    get formData() {
        return new FormData(this.formRef.current)
    }

    get isKite () {
        var url = this.props.action
        return url &&
            parseKiteAppUrl(url).isKite;
    }

    render() {
        var props = Object.assign({}, this.props)
        var url = props.action
        if ( this.isKite ) {
            props = Object.assign({}, props)
            props.action = "javascript:void(0)"
            props.onSubmit = (e) => { this.onFormSubmit(e) }
        }
        delete props.children

        props.ref = this.formRef

        return E('form', props, this.props.children)
    }
}

export class KitePersonaButton extends React.Component {
    constructor () {
        super()

        this.state = {}
    }

    componentDidMount() {
        fetch("kite+app://admin.flywithkite.com/me",
              { method: 'GET', cache: 'no-store' })
            .then((r) => r.json())
            .then((r) => this.setState({ ourInfo: r }))
            .catch((e) => console.error("error fetching info", e))
    }

    render() {
        if ( this.state.ourInfo ) {
            var ourInfo = this.state.ourInfo
            var { persona_id, persona } = ourInfo
            if ( !ourInfo.hasOwnProperty("persona_id") ) {
                return E('li', 'Error');
            } else {
                var personaInfo

                if ( persona && persona.display_name )
                    personaInfo = persona.display_name
                else
                    personaInfo = persona_id

                return E('li', {className: 'kite-persona-button'},
                         E('div', { className: 'kite-persona-name' }, personaInfo),
                         E('div', {className: 'uk-navbar-dropdown'},
                           E('ul', {className: 'uk-nav uk-navbar-dropdown-nav'},
                             E('li', null,
                               E('dl', {className: 'kite-persona-info'},
                                 E('dt', {className: 'kite-persona-info-item--appliance'}, 'Appliance'),
                                 E('dd', null, 'Test'),
                                 E('dt', {className: 'kite-persona-info-item--days-left'}, 'Time left'),
                                 E('dd', null, 'Test'))),
                             E('li', null, 'Log out'))));
            }
        } else {
            return E('li', {className: 'kite-persona-button kite-persona-button--loading'},
                     E('i', {className: 'fa fa-spin fa-fw fa-2x fa-circle-o-notch'}));
        }
    }
}

//    var url = null;
//    var srcUrl = null;
//    var curBlob = null;
//
//    var updateUrl = (newUrl) => {
//        url = newUrl;
//        var parsed = parseKiteAppUrl(url);
//        if ( parsed.isKite ) {
//            srcUrl = "about:blank";
//            console.error("TODO kite images")
//        } else {
//            srcUrl = "about:blank";
//            m.request({
//                method: 'GET',
//                url: url,
//                config: (xhr) => { xhr.responseType = 'blob'; return xhr; },
//                extract: (xhr) => {
//                    return { contentType: xhr.getResponseHeader('content-type'),
//                             body: xhr.response }
//                },
//                deserialize: (d) => { return d; }
//            }).then(({contentType, body}) => {
//                curBlob = URL.createObjectURL(body)
//                srcUrl = curBlob;
//                console.log("Got blob", srcUrl)
//            })
//            m.redraw()
//        }
//    }
//
//    return {
//        oncreate: (vnode) => {
//            updateUrl(vnode.attrs.src);
//        },
//
//        onbeforeupdate: (vnode) => {
//            console.log("before update", vnode);
//            return true;
//        },
//
//        view: (vnode) => {
//            console.log("view called", srcUrl)
//            var attrs = Object.assign({}, vnode.attrs)
//            attrs.src = srcUrl;
//            delete attrs.cls;
//
//            if ( srcUrl )
//                return m("img" + (vnode.attrs.cls || ""), attrs)
//            else
//                return "Loading"
//        }
//    }
//}
