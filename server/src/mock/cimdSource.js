// The bridge between the CIMD tester and the mock world: hands the mock PingFederate this app's
// documents (its CIMD policy) and exposes the mock world to the tester. The mock package never
// imports the tester; only this module touches both.
import { mockWorld } from './index.js';

export { mockWorld };

/** Point the mock PingFederate at these documents: (url) -> Response for each allowed URL. */
export function wireMockCimd(source, urls) {
  mockWorld().pfCimd?.(source, urls);
}
