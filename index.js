import { FlockClient, install } from './src/Flock.js';
import { mintToken, addTokens, makeAbsoluteUrl } from './src/Authenticator.js';
import { isPermalink } from './src/Permalink.js';
import Image from './src/polyfill/Image.js';

export { install, mintToken, addTokens, makeAbsoluteUrl, isPermalink, Image }
