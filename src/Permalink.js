import { EventTarget } from 'event-target-shim';
import queryString from 'query-string';

export function lookupWellKnownFlock() {
    return fetch("/.well-known/intrustd-flock")
        .then((r) => {
            if ( r.status == 200 ) {
                return r.text()
            } else
                return Promise.reject()
        })
}

function getPermalinkInfo() {
    const parsed = queryString.parse(location.search) // TODO use Hash

    if ( parsed.appliance !== undefined &&
         parsed.token !== undefined ) {

        var flock

        if ( parsed.flock !== undefined )
            flock = Promise.resolve(parsed.flock)
        else
            flock = lookupWellKnownFlock()

        return { flock,
                 persona: parsed.persona || '',
                 appliance: parsed.appliance,
                 token: parsed.token,
                 isPermalink: true }
    } else
        return { isPermalink: false }
}

export function isPermalink() {
    return getPermalinkInfo().isPermalink
}

class PermalinkErrorEvent {
    constructor(base) {
        this.type = 'error';
        this.error = base;
    }
}

class PermalinkOpensEvent {
    constructor(client) {
        this.type = 'open'
        this.device = client
    }
}


export class PermalinkAuthenticator extends EventTarget('open', 'error') {
    constructor() {
        super()

        var pl = getPermalinkInfo()

        pl.flock.then((flock) => {
            this.client = new FlockClient({ url: flock,
                                            appliance: pl.appliance })

            this.client.addEventListener('error', (e) => {
                console.error(e);
                this.dispatchEvent(new PermalinkErrorEvent(e))
            })

            this.client.addEventListener('needs-personas', () => {
                this.client.tryLogin(pl.persona, `token:${pl.token}`)
                    .then(() => this.dispatchEvent(new PermalinkOpensEvent(this.client)))
                    .catch((e) => this.dispatchEvent(new PermalinkErrorEvent(e)))
            })
        }).catch((e) => {
            console.error("Could not get permalink flock", e)
            this.dispatchEvent(new PermalinkErrorEvent(e))
        })
    }
}
