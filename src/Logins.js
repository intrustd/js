import Dexie from 'dexie';
import { Record, Map, List } from 'immutable';

import { FlockClient } from './FlockClient.js';

var loginsDb

const LoginKey = Record({ flock: '',
                          appliance: '',
                          persona: '' })

export class Login {
    constructor(data, siteCertificate, now) {
        this.personaId = data.persona_id
        this.flockUrl = data.flock
        this.applianceName = data.appliance
        this.loginToken = data.token
        this.expiration = data.exp
        this.siteCertificate = siteCertificate

        if ( now === undefined )
            now = Date.now()

        this.now = now
    }

    get key() {
        return LoginKey({ flock: this.flockUrl,
                          appliance: this.applianceName,
                          persona: this.personaId })
    }

    get isExpired() {
        return this.expiration <= this.now
    }

    createClient() {
        return new Promise((resolve, reject) => {
            var client = new FlockClient({ url: this.flockUrl,
                                           appliance: this.applianceName })
            client.addEventListener('error', (e) => { console.error(e); reject(e); })
            client.addEventListener('needs-personas', () => {
                var persona = this.personaId
                if ( persona === undefined )
                    persona = 'token'
                client.tryLogin(persona, `token:${this.loginToken}`)
                    .then(() => touchAppliance(this.applianceName))
                    .then(() => {
                        resolve(client)
                    })
                    .catch((e) => {
                        console.error("Could not login to client", e)
                        reject(e)
                    })
            })

        })
    }

    save() {
        var loginData = { persona_id: this.personaId,
                          flock: this.flockUrl,
                          appliance: this.applianceName,
                          token: this.loginToken,
                          exp: this.expiration }
        console.log("Saving", loginData)
        return getLoginsDb()
            .then((db) => db.login.put(loginData))
            .then((key) => console.log("Got key", key))
    }
}

export function getLoginsDb() {
    if ( loginsDb === undefined )
        loginsDb = new Promise((resolve, reject) => {
            var db = new Dexie('intrustd-logins');
            db.version(10).stores({
                login: 'token,exp,[persona_id+flock+appliance]',
                site: 'exp',
                appliance: 'appliance_name,last_auth_time',
                savedPermission: '[origin+permission]'
            })
            db.version(9).stores({
                login: 'token,exp,[persona_id+flock+appliance]',
                site: 'exp',
                appliance: 'appliance_name,last_auth_time'
            })
            db.version(8).stores({
                login: 'token,exp,[persona_id+flock+appliance]',
                site: 'exp'
            })
            db.version(7).stores({
                logins: 'token,exp,[persona_id+flock+appliance]',
                site: 'exp'
            })
            db.version(6).stores({
                logins: '[exp+token],[persona_id+flock+appliance+exp]',
                site: 'exp'
            })
            db.version(5).stores({
                logins: '[persona_id+flock+appliance+exp], token',
                site: 'exp'
            })
            db.version(4).stores({
                logins: '[persona_id+flock+appliance+exp]',
                site: 'exp'
            })
            db.version(3).stores({
                logins: 'persona_id, [flock+appliance], exp',
                site: 'exp'
            })
            db.version(2).stores({
                logins: 'persona_id, [flock+appliance]',
                site: 'exp'
            })
            db.version(1).stores({
                logins: 'persona_id, [flock+appliance]'
            })

            resolve(db.open())
        })

    return loginsDb
}

export function getSite(db) {
    var now = Date.now()
    return db.site.where('exp').above(now).toArray()
        .then((sites) => {
            if ( sites.length == 0 ) {
                return Promise.all(
                    [RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' }),
                     db.site.where('exp').belowOrEqual(now).delete()])
                    .then(([cert, done]) => db.site.add({exp: cert.expires, cert}).then(() => cert))
            } else {
                return sites[0].cert
            }
        });
}

export function lookupLogins() {
    var now = Date.now()
    return getLoginsDb()
        .then((db) => {
            return Promise.all([getSite(db), db.login.where('exp').above(now).toArray()])
        }).then(([site, logins]) => {
            logins = List(logins)
                .map((login) => new Login(login, site, now))
                .groupBy((login) => login.key)


            logins = logins
                .map((loginOptions) => loginOptions.maxBy((login) => login.expiration))
                .valueSeq().toArray()

            return logins
        }).catch((e) => { console.error("Error while running dexie", e)})
}

export function resetLogins() {
    return Promise.all([ getLoginsDb(),
                         lookupLogins() ])
        .then(([ db, logins ]) => {
            return Promise.all(logins.map(({loginToken}) => {
                return db.login.where('token').equals(loginToken).delete()
            }))
        }).then(() => null)
}

export function touchAppliance(appliance_name) {
    var appObj = { appliance_name,
                   last_auth_time: new Date() }
    return getLoginsDb()
        .then((db) => db.appliance.put(appObj))
}

export function getAppliances() {
    return getLoginsDb()
        .then((db) => {
            return db.appliance.orderBy('last_auth_time').reverse().toArray()
        })
}

export function rememberPermissions(origin, permissions) {
    return getLoginsDb()
        .then((db) =>
              db.savedPermission.bulkPut(permissions.map((permission) => { return { origin, permission } })))
        .then(() => { return null })
}

export function lookupSavedPermissions(origin) {
    return getLoginsDb()
        .then((db) => db.savedPermission.where('[origin+permission]')
              .between([origin, Dexie.minKey], [origin, Dexie.maxKey]).toArray())
        .then((entries) => entries.map(({permission}) => permission))
}
