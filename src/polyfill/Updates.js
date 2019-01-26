// Application update support

import React from 'react';
import ReactDom from 'react-dom';
import { Map } from 'immutable';

import "../Common.scss";
import "./Updates.scss";

const AFTER_UPDATE_CLEAR_TIMEOUT = 5000;

var updateNotificationContainer = null
var currentUpdates = Map()

const UpdateStatus = {
    Starting: Symbol('Starting'),
    Error: Symbol('Error'),
    Complete: Symbol('Complete'),
    Updating: Symbol('Updating')
};

const E = React.createElement;

export function appManifestAddress(app) {
    return `https://${app}/manifest.json`;
}

class ApplicationInstallError {
    constructor(sts) {
        this.status = sts
    }
}

export class AppInstallItem extends React.Component {
    constructor() {
        super()
        this.state = { }
    }

    componentDidMount() {
        fetch(appManifestAddress(this.props.app))
            .then((r) => {
                if ( r.status == 200 )
                    return r.json().then((mf) => this.setState({ appInfo: mf }))
            })
            .catch((e) => this.setState({error: e}))
    }

    render() {
        if ( this.state.appInfo ) {
            var selectedClass = ''
            var progress

            if ( this.props.selected )
                selectedClass = 'intrustd-app--selected'

            if ( this.props.installing ) {
                if ( this.props.progress.finished )
                    selectedClass = 'intrustd-app--installed'
                else
                    selectedClass = 'intrustd-app--installing'

                if ( this.props.progress.error ) {
                    progress = [ E('div', { className: 'uk-alert uk-alert-danger', key: 'alert'}, `${this.props.progress.error}`) ];

                    if ( this.props.progress.onContinue ) {
                        progress.push(E('button', { className: 'uk-button', key: 'continue', 'uk-tooltip': 'Continue anyway...',
                                                    onClick: this.props.progress.onContinue },
                                        E('i', { className: 'fa fa-fw fa-arrow-right' })))
                    }
                } else {
                    var { complete, total, message } = this.props.progress

                    if ( this.props.progress.finished ) {
                        complete = total = 100;
                        message = "Complete"
                    }

                    progress = [
                        E('div', {className: 'progress-message', key: 'message'}, message),
                        E('progress', { className: 'uk-progress', key: 'progress',
                                        value: complete, max: total })
                    ]
                }
            }

            return E('div', { className: `intrustd-app ${selectedClass}` },
                     E('img', { className: 'intrustd-app-icon',
                                src: this.state.appInfo.icon }),
                     E('span', { className: 'intrustd-app-name' },
                       this.state.appInfo.name),
                     progress)
        } else {
            var error

            if ( this.state.error ) {
                error = E('i', { className: 'intrustd-app-error-indicator fa fa-fw fa-warning',
                                 'uk-tooltip': `${this.state.error}`})
            }

            return E('div', { className: 'intrustd-app intrustd-app--loading' },
                     error,
                     E('i', { className: 'fa fa-fw fa-spin fa-circle-o-notch intrustd-app-indicator' }),
                     E('span', { className: 'intrustd-app-loading-message' },
                       this.props.app))
        }
    }
}

class UpdatesNotification extends React.Component {
    constructor() {
        super()

        this.state = { }
    }

    render() {
        return [
            E('header', { className: 'intrustd-modal-header' },
              E('h3', null, 'Updating...')),
            E('ul', { className: 'intrustd-list intrustd-app-list' },
              Array.from(this.props.updates.entries()).map(([appName, { status, props }]) => {
                  return E('li', { className: 'intrustd-app-container--updating' },
                           E(AppInstallItem, { app: appName, installing: true,
                                               selected: false, progress: props }))
              }))
        ]
    }
}

function updateUpdatesNotifier() {
    if ( currentUpdates.isEmpty() && updateNotificationContainer !== null ) {
        updateNotificationContainer.parentNode.removeChild(updateNotificationContainer)
        updateNotificationContainer = null

    } else if ( !currentUpdates.isEmpty() && updateNotificationContainer === null ) {
        updateNotificationContainer = document.createElement('div')
        updateNotificationContainer.classList.add('intrustd-modal')
        updateNotificationContainer.classList.add('intrustd-update-notification-box')

        document.body.appendChild(updateNotificationContainer)
    }

    if ( !currentUpdates.isEmpty() ) {
        ReactDom.render(E(UpdatesNotification, { updates: currentUpdates }), updateNotificationContainer)
    }
}

function clearUpdate(app) {
    currentUpdates = currentUpdates.delete(app)
    updateUpdatesNotifier()
}

function setUpdateStatus(app, status, props) {
    if ( props === undefined )
        props = {};

    if ( status == UpdateStatus.Complete &&
         !currentUpdates.has(app) )
        return

    var oldSts = currentUpdates.get(app)

    if ( oldSts !== undefined ) {
        if ( status == UpdateStatus.Complete &&
             oldSts.status != UpdateStatus.Complete ) {
            props.timeout = setTimeout(() => { clearUpdate(app) }, AFTER_UPDATE_CLEAR_TIMEOUT)
            props.finished = true
        } else if ( oldSts.status == UpdateStatus.Complete && oldSts.props.timeout !== undefined ) {
            clearTimeout(oldSts.props.timeout)
        }
    }

    currentUpdates = currentUpdates.set(app, { status, props })

    updateUpdatesNotifier()
}

export function updateApp(fetch, appClient, canonAppUrl, progressFunc) {
    return new Promise((resolve, reject) => {
        var processResponse =
            ({state, progress, status_url}) => {

                if ( state == 'installed' ) {
                    progressFunc({finished: true})
                    resolve()
                } else if ( state == 'error' ) {
                    progressFunc({error: progress.message})
                    reject(progress.message)
                } else {
                    progressFunc(progress)

                    var retries = 0
                    var poll = () => {
                        fetch(`intrustd+app://admin.intrustd.com${status_url}`,
                              {method: 'GET', appClient,
                               cache: 'no-store'})
                            .then((r) => {
                                if ( r.status == 200 ) {
                                    retries = 0
                                    return r.json().then(processResponse)
                                } else {
                                    retries += 1
                                    if (retries > 7)
                                        return Promise.reject(`Bad status: ${r.status}`)
                                    else
                                        timeout = setTimeout(poll, 2000)
                                }})
                    }

                    setTimeout(poll, 2000)
                }
            }
        fetch(`intrustd+app://admin.intrustd.com/me/applications/${canonAppUrl}`,
              { method: 'PUT', appClient })
            .then((r) => {
                if ( r.status == 200 || r.status == 202 )
                    return r.json().then(processResponse)
                else
                    return Promise.reject(`Bad status: ${r.status}`)
            })
            .catch(reject)
    })
}

export function doUpdate(fetch, client, canonAppUrl) {
    setUpdateStatus(canonAppUrl, UpdateStatus.Starting)

    var progress = (sts) => {
        if ( sts.error ) {
            setUpdateStatus(canonAppUrl, UpdateStatus.Error,
                            { error: sts.error })
        } else if ( !sts.finished ) {
            setUpdateStatus(canonAppUrl, UpdateStatus.Progress,
                            { complete: sts.complete,
                              total: sts.total,
                              message: sts.message })
        }
    }
    return updateApp(fetch, client, canonAppUrl, progress)
        .then((r) => {
            setUpdateStatus(canonAppUrl, UpdateStatus.Complete)
        })
        .catch((msg) => {
            return new Promise((resolve, reject) => {
                setUpdateStatus(canonAppUrl, UpdateStatus.Error,
                                { error: `${msg}`,
                                  onContinue: () => {
                                      setUpdateStatus(canonAppUrl, UpdateStatus.Complete)
                                      resolve()
                                  }})
            })
        })
}

