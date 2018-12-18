import { EventTarget } from 'event-target-shim';
import queryString from 'query-string';

function getPermalinkInfo() {
    const parsed = queryString.parse(location.search) // TODO use Hash

    if ( parsed.flock !== undefined &&
         parsed.persona !== undefined &&
         parsed.appliance !== undefined &&
         parsed.token !== undefined ) {
        return { flock: parsed.flock,
                 persona: parsed.persona,
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

        this.client = new FlockClient({ url: pl.flock,
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
    }
}
