import{ BlobReader, Base64Encoder } from './Streams.js';

export function generateFormBoundary() {
    var random = "";
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    for ( var i = 0; i < 16; ++i ) {
        var charIndex = Math.floor(Math.random() * chars.length)
        random += chars.charAt(charIndex)
    }

    var boundary = `----IntrustdFormBoundary${random}`
    return { boundary,
             contentType: `multipart/form-data; boundary=${boundary}` }
}

const FormDataMode = {
    ITEM: Symbol('ITEM'),
    STREAM: Symbol('STREAM'),
    WAITING: Symbol('WAITING')
};


export function makeFormDataStream(formData, boundary) {
    var items = [], length = 0
    const itemBoundary = { raw: `--${boundary}\r\n` }

    const pushRaw = (raw) => {
        items.push({raw})
        length += raw.length
    }
    const pushBoundary = () => {
        items.push(itemBoundary)
        length += itemBoundary.raw.length
    }
    const pushStream = (stream) => {
        items.push({stream})
        length += stream.size
    }

    for ( var [name, value] of formData.entries() )  {
        pushBoundary()
        if ( value instanceof File ) {
            pushRaw(`Content-Disposition: form-data; name="${name}"; filename="${value.name}"\r\nContent-Type: ${value.type}\r\n\r\n`)
            pushStream(value)
            pushRaw('\r\n')
        } else {
            console.error("Can't handle non-file", value)
            throw new TypeError("TODO can't handle non-file")
        }
    }
    if ( items.length > 0 ) {
        const end = `--${boundary}--\r\n`
        items.push({ raw:  end})
        length += end.length
    }

    var oldItems = items
    items = items[Symbol.iterator]()
    var currentItem = items.next()
    var sentItem = false

    var mode = { mode: FormDataMode.ITEM }

    var enqueueNext = (controller) => {
        if ( currentItem.done ) {
            controller.close()
        } else {
            switch ( mode.mode ) {
            case FormDataMode.ITEM:
                if ( currentItem.value.raw ) {
                    controller.enqueue(currentItem.value.raw)
                    currentItem = items.next()

                    enqueueNext(controller)
                } else if ( currentItem.value.stream ) {
                    mode = { mode: FormDataMode.STREAM,
                             stream: (new BlobReader(currentItem.value.stream)).getReader() }
                    enqueueNext(controller)
                }
                break;

            case FormDataMode.STREAM:
                mode.stream.read().then(({value, done}) => {
                    var chunk = value
                    if ( done ) {
                        currentItem = items.next()
                        mode = { mode: FormDataMode.ITEM }
                        enqueueNext(controller)
                    } else {
                        if ( mode.mode == FormDataMode.WAITING ) {
                            controller.enqueue(chunk)
                            mode = mode.oldMode;
                            enqueueNext(controller)
                        } else
                            console.error("Read chunk, but we are not waiting", mode)
                    }
                })
                mode = { mode: FormDataMode.WAITING, oldMode: mode }
                break;
            }
        }
    }

    var stream = new ReadableStream({
        start (controller) {
            enqueueNext(controller)
        },

        pull (controller) {
            enqueueNext(controller)
        }
    })

    return { stream, length }
}
