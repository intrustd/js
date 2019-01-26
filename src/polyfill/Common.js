export function parseAppUrl(url) {
    var url_obj

    try {
        url_obj = new URL(url);
    } catch (e) {
        if ( e instanceof TypeError ) {
            return { isApp: false }
        } else
            throw e
    }

    var host = url_obj.pathname;

    switch ( url_obj.protocol ) {
    case 'intrustd+app:':
        if ( host.startsWith('//') ) {
            var info = host.substr(2).split('/');
            if ( info.length >= 2 ) {
                return { isApp: true,
                         app: info[0],
                         path: '/' + info.slice(1).join('/') + url_obj.search,
                         port: 80 // TODO
                       };
            }
        }
        return { isApp: true, error: "Expected intrustd+app://app.domain/" };
    default:
        return { isApp: false };
    }
}

export function appCanonicalUrl( urlData ) {
    return 'intrustd+app://' + urlData.app;
}
