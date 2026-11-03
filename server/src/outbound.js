// The app's one outbound door: createNetguard() bound to the app's mode and to the in-process mock. Code that used to call
// fetch() calls outboundFetch(); code that opens its own sockets calls guardSocket(url) first.
import { currentMode } from './mode.js';
import { MOCK_ORIGINS, mockFetch } from './mock/index.js';
import { createNetguard } from './netguard.js';
import { trustedFetch } from './pfTrust.js';

export const netguard = createNetguard({ mode: currentMode, mock: { origins: MOCK_ORIGINS, fetch: mockFetch }, realFetch: trustedFetch });
export const outboundFetch = (url, init) => netguard.fetch(url, init);
export const guardSocket = (url) => netguard.assertAllowed(url);
