import { resolveCurlBinary, curlFetch } from './src/curl.ts';

const binary = resolveCurlBinary();
if (!binary) throw new Error('no curl-impersonate binary');
const html = await curlFetch('https://www.hltv.org/matches', { binary });

const at = html.indexOf('heroic-vs-m80-pgl-major');
console.log('offset', at);
console.log(html.slice(at - 1100, at + 900).replace(/\s+/g, ' '));
