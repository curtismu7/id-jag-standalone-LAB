# Talk track: ID-JAG LAB

Presenter script, about 12 minutes. Each `##` heading is one step. Press **Present** in the header (or `P`) for presenter mode: bigger type, and Left and Right arrows move between the playground steps. The simulation banner stays on screen the whole time.

Start the app for this script with `ALLOW_MOCK_SIGNIN=1 npm start` (or `docker compose -f deploy/docker-compose.yml up --build -d`, which sets it) and open http://localhost:4720. Mock mode is the default and needs no tenant, no network and no setup.

## Step 1: Say what this is and what is simulated

Say: "ID-JAG is the Identity Assertion JWT Authorization Grant. It lets a company's identity provider tell another company's authorization server, in one signed assertion, 'this user's agent may ask you for access.' Today you are looking at it in Mock mode: the PingFederate, the second PingFederate, the authorization server and the MCP server are all small simulations running inside this app. Nothing leaves this machine."

Point at the banner and at the **Mock** and **Live** buttons in the header. Say that Live runs against real PingFederate servers named in the owner's settings. It is owner-run and is not part of this demo.

Be honest about the limits: the cryptography is real (ES256 signatures, real JWT checks), but the keys belong to the simulation, and every token carries `"mock": true` and a `kid` that starts with `mock-`. A mock token proves how the flow works. It does not prove anything about a customer's PingFederate.

## Step 2: Start with the sample-data mode

In the Playground, the first mode is **Sample data (browser)**. Say: "This mode uses canned answers in the page. It needs no sign-in, so it is the one that cannot fail on stage." Walk the six steps quickly. Point at the **Sample data: nothing is sent** badge.

Say: "That is a different thing from the Mock switch in the header. Sample data is fixtures in your browser. Mock mode runs the real playground code against the in-app simulation."

## Step 3: Sign in at the issuer (PingFederate to resource AS)

Choose **PingFederate → resource AS**. Click **Sign in with PingFederate** in step 1 (or **Sign in** in the header). The dialog shows the public mock demo account. Sign in with it.

Say: "This is the pi.flow sign-in: no redirect, the password step is this dialog. The simulated PingFederate checks the password and keeps a refresh token for this session on the server. The browser never holds it."

Offer a wrong password first if you want to show the refusal.

## Step 4: Get an ID-JAG

Click **Request ID-JAG** in step 2. Say: "This is an RFC 8693 token exchange. The app asks PingFederate for a token of type id-jag, addressed to the resource authorization server, for one named MCP resource."

Open the decoded ID-JAG and the spec-check table. Point at `typ` (`oauth-id-jag+jwt`), a single `aud`, the `client_id` and the short lifetime. Say: "The ID-JAG is not an access token. It is a grant. It lives about five minutes and works once."

Point at `mock: true` in the claims. Say: "That is how you tell a simulated token from a real one."

## Step 5: Redeem it

Click **Redeem ID-JAG**. Say: "Now the authorization server receives the ID-JAG as an RFC 7523 JWT bearer grant. It checks the type, the signature against the issuer's keys, the audience, the expiry, that the client redeeming it is the client named in it, and that the `jti` has not been seen before. Then it mints its own access token."

Open the AS record line that appears under the step. Say: "The authorization server shows its own work: accepted or refused, and why."

## Step 6: Call the MCP server

Click **List tools this token can see**, then pick a tool and click **Call tool**. Say: "The ID-JAG stops at the authorization server. The MCP call carries the new access token, and the server verifies it against the authorization server's keys. The tools you see are whatever the token's scope allows."

Switch the resource to **REST API**, click **Open with the access token**, then **Try without a token** and **Try with the raw ID-JAG**. Say: "The raw ID-JAG is refused, and the server names the check that failed."

## Step 7: Run the refusals

Click **Run all** in step 5. Four tests run, each with a fresh ID-JAG that is broken one way: replayed, a tampered signature, redeemed by a different client, and asking for a scope that was not granted.

Say: "A resource server that only ever says yes proves nothing. Each of these must come back as an OAuth error with no token. If one ever returned a token, that would be a security bug." The replay refusal is a hardening this kit adds: the draft does not require single use of the `jti`.

## Step 8: Revoke and prove it

Click **Revoke and retry**. Say: "Revoking the refresh token at PingFederate (RFC 7009) stops new ID-JAGs for this session, and the next request is refused."

Be honest here: access tokens that were already minted stay valid until they expire, and the resource authorization server is not told about the revocation.

## Step 9: Show the diagram

Click **View PingFederate → resource AS diagram**. It opens in a new tab. Press **Simulate** and watch the numbered arrows light step by step. Drag a box, then press **Reset**: the boxes go back and the Overview step returns (at the lowest zoom, which shows part of the map on most screens; drag the background to pan). Change **Speed** to Slow for a talk.

Say: "This diagram is drawn from shared diagram data, the same format other demos in this family use. The blue dashed lines are where trust comes from: a keys fetch or a registry read."

## Step 10: Two PingFederates

Choose **Acme PingFederate → PingFederate**. Say: "Here an outside company, Acme, issues the ID-JAG at its own PingFederate, and our PingFederate redeems it through an IdP connection. They are two servers on purpose: an issuer must not redeem its own ID-JAG, which the draft says in section 9.3."

Run through to the MCP call. Say: "The call is refused, and that is the expected result in this mode. The sample MCP server trusts our resource authorization server only, and this access token came from PingFederate. Look at which check it names."

## Step 11: Where ID-JAG stands, and who supports it

Say: "ID-JAG is an IETF draft, not a finished standard, so details can still move. The Learn page and the **IETF draft** link in the header point at it."

Say: "Among Ping products, PingFederate is the one that supports ID-JAG, and it is also the only one that supports DPoP. PingOne and Advanced Identity Cloud do not issue or redeem ID-JAGs today. That is why this kit needs PingFederate for its live modes." This is the kit owner's standing position. Check the current Ping documentation before you promise a customer a date.

Say what Mock mode does not cover: signing in with xaa.dev's free IdP, the SAML option and the interop panel need real servers, so they are Live only and are greyed out or explain why.

## Step 12: The gateway redeems the ID-JAG (a Ping release claim, mock only)

Choose **Gateway redeems the ID-JAG (mock only)**. Point at the banner: "Ping release claim (2026-11-02), UNVERIFIED on our tenant". Say: "This is a feature of Ping's 2026-11-02 Privilege release. Our tenant does not have it, so I have not measured it. What you see is a mock inside this app that shows the shape of the claim." Point at the **Live** button in the header and read its note: gateway redeem has no Live mode, because the release is not on our tenant.

Click **Run both legs**. Say: "The agent calls the gateway with a caller token. The gateway, configured with an On-Behalf-Of spec, exchanges that token at the exchange issuer (leg 1, RFC 8693). The result is an ID-JAG addressed to the target app's own issuer, naming the user and, in `act`, the calling client. Because a Redeem spec with a TokenURL is set, the gateway then redeems the ID-JAG at the target app's own issuer (leg 2, RFC 7523). The target app's API sees the user, and nobody shared a credential." Open the decoded ID-JAG and the decoded access token. Point at `aud` and `sub` in each; they come from this run.

Scroll to the controls table. Say: "The API refused the caller's original token and the raw ID-JAG, and it names the check that failed. Neither was ever the API's to accept."

Untick **send the second leg**, press **Save the spec** and run again. Say: "With no Redeem TokenURL there is no leg 2. The exchange result is not redeemed, it goes to the API as it is, and the API refuses it because an ID-JAG is a grant and not an access token." Press **Reset the spec**.

Point at the field names and their tags. Say: "Every field name here is tagged: a console swagger name from 2026-10-31 (schema only, nothing was called), the lab's own reading, or something we made up. Open **Where every claim on this page comes from** for the full list." Say: "`ClientSecret` and `PrivateKeyPEM` are write-only. Type a value, save, and the server never shows it again, in any answer or trace."

Click **Run all ten**. Walk the refusals: an assertion from an issuer the target does not trust, one addressed to another audience, an expired one, a replayed one, a tampered signature, a token URL on a host that is not allow-listed, a token URL that redirects, and the wrong client authentication method. Say: "Each one stops at a named stage for a named check, and no token is issued."

## Step 13: Why it matters (DRAFT, not Ping wording)

Say: "Ping's deck has a value panel for each feature, but the copy this lab was given has none for the gateway redeeming the ID-JAG. These three lines are a draft written for this lab from the field names and the feature description, then checked against the IETF draft and how other vendors describe the problem. They are not Ping's words, and nothing here is verified on our tenant."

Challenge: "Agents often reach other apps through a separate consent screen for each app, which the company's identity provider does not see, or through a static API key that carries no user context. Either way, it is hard to tie the agent's access to a specific user."

Technical: "The gateway trades the caller's token for an ID-JAG (Identity Assertion JWT Authorization Grant), a signed statement that this user may access the other app. When a Redeem setting with a token URL is configured, the gateway presents it to that app's own authorization server to get an access token for the user; without Redeem, it is not presented."

Business: "The app receives a token issued for the individual user, not for an identity shared by every user, so it can tie its access to that user, and it still applies its own policy at its own authorization server. ID-JAG is still an IETF draft and may change."

## Step 14: Make it the customer's story

Open the story panel under the mode picker. Pick another vertical in the picker (Airline, Super Banking, CareConnect, Great Buy or Generic) and read the goal and the first step aloud. Say: "The cast and the nouns come from data. The stories hold tokens like the cast member's name, not names. A `customer.config.json` can rename the cast, so the same demo tells the customer's story with their vocabulary."

## Step 15: Close and reset

Say: "Everything you saw ran offline in Mock mode. To clear this demo for the next visitor, press **Start over** to clear the results and keep the sign-in, or run `npm run reset` to clear the run state. Your saved settings stay."
