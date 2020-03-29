export default class IntrustdImage {
    constructor(href) {
        this.href = href
        this.loaded = false
        this.loadPromise = this.startLoad()
    }

    startLoad() {
        return fetch(this.href, { method: 'GET' })
            .then((d) => d.blob().then((b) => {
                var blob = URL.createObjectURL(b)
                this.blobUrl = blob
                this.preloaded = new Image()
                this.preloaded.src = this.blobUrl
                this.loaded = true
                return true
            }))
    }
}
