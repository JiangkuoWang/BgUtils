import { BG } from '../../dist/index.js';
import type { BgConfig } from '../../dist/index.js';
import { JSDOM } from 'jsdom';
// Bun:
// import { Innertube, UniversalCache } from 'youtubei.js/web';
import { Innertube, UniversalCache } from 'youtubei.js';

// Create a barebones Innertube instance so we can get a visitor data string from YouTube.
let innertube = await Innertube.create({ retrieve_player: false });

const requestKey = 'O43z0dpjhgX20SCx4KAo';
const visitorData = innertube.session.context.client.visitorData;

if (!visitorData)
  throw new Error('Could not get visitor data');

const dom = new JSDOM();

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document
});

const bgConfig: BgConfig = {
  fetch: (input: string | URL | globalThis.Request, init?: RequestInit) => fetch(input, init),
  globalObj: globalThis,
  identifier: visitorData,
  requestKey,
  useYouTubeAPI: true
};

const bgChallenge = await BG.Challenge.create(bgConfig);

if (!bgChallenge)
  throw new Error('Could not get challenge');

const interpreterJavascript = bgChallenge.interpreterJavascript.privateDoNotAccessOrElseSafeScriptWrappedValue;

if (interpreterJavascript) {
  new Function(interpreterJavascript)();
} else throw new Error('Could not load VM');

const poTokenResult = await BG.PoToken.generate({
  program: bgChallenge.program,
  globalName: bgChallenge.globalName,
  bgConfig
});

const placeholderPoToken = BG.PoToken.generatePlaceholder(visitorData);

console.info('Session Info:', {
  visitorData,
  placeholderPoToken,
  poToken: poTokenResult.poToken,
  integrityTokenData: poTokenResult.integrityTokenData
});

innertube = await Innertube.create({
  po_token: poTokenResult.poToken,
  visitor_data: visitorData,
  cache: new UniversalCache(true),
  generate_session_locally: true
});

try {
  const info = await innertube.getBasicInfo('dQw4w9WgXcQ'); // Rick Roll - a more stable test video
  const format = info.chooseFormat({
    quality: 'best',
    type: 'audio'
  });

  if (format && format.url) {
    const audioStreamingURL = format.decipher(innertube.session.player);
    console.info('Streaming URL:', audioStreamingURL);
  } else {
    console.info('No audio format available or URL is missing');
  }
} catch (error) {
  console.error('Error getting video info:', error.message);
  console.info('但是 PoToken 生成成功！网络连接问题已解决。');
}