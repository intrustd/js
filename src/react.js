import React from 'react';

import { parseAppUrl } from './polyfill/Common.js';
import { resetLogins } from './Logins.js';
import IntrustdImage from './polyfill/Image.js';

import './react.scss';

function getXhrImage(xhr, opts) {
    xhr.response
}

const E = React.createElement;

export class LoadingIndicator extends React.Component {
    render() {
        return E('span', { className: 'intrustd-connecting' },
                 E('i', { className: 'intrustd-connecting-dot' }),
                 E('i', { className: 'intrustd-connecting-dot' }),
                 E('i', { className: 'intrustd-connecting-dot' }))
    }
}

export class UploadButton extends React.Component {
    constructor() {
        super()
        this.upload = React.createRef();
    }

    startUpload() {
        this.upload.current.click()
    }

    doUpload() {
        if ( !this.props.hasOwnProperty('onUpload') )
            console.error("<UploadButton> expects 'onUpload={...}' property")
        else
            this.props.onUpload(this.upload.current.files)
    }

    render() {
        var attrs = Object.assign({}, this.props)
        delete attrs.elName
        delete attrs.name
        delete attrs.onUpload
        attrs.onClick = (e) => { this.startUpload(e); }

        return E(this.props.elName, attrs,
                 E('input', {type: 'file', multiple: true, style: { display: 'none'},
                             name: this.props.name,
                             ref: this.upload, onChange: (e) => { this.doUpload(e) } }),
                 this.props.children)
    }
}

export class ImageHost extends React.Component {
    constructor(props) {
        super()

        this.state = {
            firstLoad: false,
            srcUrl: null,
            curBlob: null
        };

        this.updateSource(props.src, (newState) => {
            this.state = Object.assign({}, this.state, newState)
        })
    }

    // componentDidMount () {
    //     this.updateSource(this.props.src)
    // }

    componentWillUnmount() {
        this.freeBlob()
    }

    freeBlob() {
        if ( this.state.isBlob ) {
            if ( this.state.shouldRevoke )
                URL.revokeObjectURL(this.state.srcUrl)
            this.setState({ isBlob: false, srcUrl: null })
        }
    }

    componentDidUpdate(oldProps, oldState, snapshot) {
        if ( oldProps.src != this.props.src )
            this.updateSource(this.props.src)
    }

    dispatchFirstLoad(setState) {
        if ( !this.state.firstLoad ) {
            setState({firstLoad: true})
            if ( this.props !== undefined && this.props.onFirstLoad )
                setTimeout(() => this.props.onFirstLoad(), 0)
        }
    }

    updateSource(newSrc, setState) {
        this.freeBlob()

        if ( setState === undefined )
            setState = this.setState.bind(this)

        if ( newSrc instanceof IntrustdImage ) {
            if ( newSrc.loaded ) {
                setState({srcUrl: newSrc.blobUrl, isBlob: true, shouldRevoke: false })
                this.dispatchFirstLoad(setState)
            } else {
                newSrc.loadPromise.then(() => this.updateSource(newSrc))
            }
        } else {
            setState({srcUrl: null, isBlob: false, shouldRevoke: false})
            var parsed = parseAppUrl(newSrc)
            fetch(newSrc, { method: 'GET'})
                .then((d) => d.blob().then((b) => {
                    return {contentType: d.headers.get('content-type'),
                            blob: b}
                }))
                .then(({contentType, blob}) => {
                    var curBlob = URL.createObjectURL(blob);
                    this.setState({srcUrl: curBlob,
                                   isBlob: true,
                                   shouldRevoke: true})

                    this.dispatchFirstLoad(setState)
                })
        }
    }

    reload() {
        this.updateSource(this.props.src)
    }

    render () {
        if ( this.state.srcUrl ) {
            return this.props.renderImg(this.state.srcUrl)
        } else
            return this.props.renderLoad()
    }
}

export class Image extends React.Component {
    render() {
        return E(ImageHost, { src: this.props.src,
                              onFirstLoad: this.props.onFirstLoad,
                              renderImg: (src) => {
                                  var props = Object.assign({}, this.props);
                                  delete props.src;
                                  delete props.onFirstLoad;
                                  props.src = src

                                  return E('img', props)
                              },
                              renderLoad: () => {
                                  return E('span', { className: 'intrustd-img-loading' }, ' ')
                              } })
    }
}

export class Form extends React.Component {
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

    get isApp () {
        var url = this.props.action
        return url &&
            parseAppUrl(url).isApp;
    }

    render() {
        var props = Object.assign({}, this.props)
        var url = props.action
        if ( this.isApp ) {
            props = Object.assign({}, props)
            props.action = ""
            props.onSubmit = (e) => { this.onFormSubmit(e) }
        }
        delete props.children

        props.ref = this.formRef

        return E('form', props, this.props.children)
    }
}

export class PersonaButton extends React.Component {
    constructor () {
        super()

        this.state = { dropped: false }
    }

    componentDidMount() {
        fetch("intrustd+app://admin.intrustd.com/me",
              { method: 'GET', cache: 'no-store' })
            .then((r) => r.json())
            .then((r) => this.setState({ ourInfo: r }))
            .catch((e) => console.error("error fetching info", e))
    }

    doLogout(e) {
        e.preventDefault()
        resetLogins().then(() => { location.reload() })
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

                return E('li', {className: 'intrustd-persona-button',
                                tabIndex: 1,
                                onClick: () => { this.setState({dropped: !this.state.dropped}) },
                                onBlur: () => { this.setState({dropped: false}) } },
                         E('div', { className: 'intrustd-persona-name' }, personaInfo),
                         E('div', {className: 'intrustd-persona-dropdown',
                                   style: { display: this.state.dropped ? 'block' : 'none' } },
                           E('ul', {className: 'intrustd-persona-dropdown-nav'},
                             E('li', null,
                               E('dl', {className: 'intrustd-persona-info'},
                                 E('dt', {className: 'intrustd-persona-info-item--appliance'}, 'Appliance'),
                                 E('dd', null, 'Test'),
                                 E('dt', {className: 'intrustd-persona-info-item--days-left'}, 'Time left'),
                                 E('dd', null, 'Test'))),
                             E('li', null,
                               E('a', { 'href': '#', onClick: this.doLogout.bind(this) }, 'Log out')))));
            }
        } else {
            return E('li', {className: 'intrustd-persona-button intrustd-persona-button--loading'},
                     E('i', {className: 'fa fa-spin fa-fw fa-2x fa-circle-o-notch'}));
        }
    }
}
