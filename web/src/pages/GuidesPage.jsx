import "./console.css";
import { mcpcCommand, vscodeMcpJson, vscodeSettings } from "../utils/realClients";

// Setup guides. docs/setup-guides.md carries the same content for readers outside the app.

export const GUIDES = [
  ["pf-issuer", "PingFederate as the ID-JAG issuer"],
  ["pf-redeemer", "PingFederate as the redeemer"],
  ["okta", "Okta Cross App Access"],
  ["generic", "Any other IdP: the ID-JAG checklist"],
  ["xaa", "Use xaa.dev (IdenX) as a free outside IdP"],
  ["desktop", "Use mcpc or VS Code as the client"],
];
const KIT = { pfUrl: "https://pf.example.invalid", mcpUrl: "http://localhost:4722/mcp" };
const MCPC = mcpcCommand(KIT);
const VSCODE_SETTINGS = vscodeSettings(KIT);
const VSCODE_MCP = vscodeMcpJson(KIT);
const T = ({ children }) => <span className="kc-term">{children}</span>;
const Ext = ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;

export default function GuidesPage() {
  return (
    <main className="kc">
      <header className="kc-hero">
        <p className="kc-eyebrow">Setup guides</p>
        <h1>Connect an IdP to the ID-JAG kit</h1>
        <p className="kc-lede">
          An ID-JAG is a short-lived JWT your IdP issues (RFC 8693 token exchange) and a resource authorization server redeems
          (RFC 7523 JWT bearer). These guides set up each side, then you register the IdP on the <a href="/trusted-idps">Trusted IdPs</a> page.
        </p>
      </header>
      <nav aria-label="Guides">
        <ul className="kc-toc">{GUIDES.map(([id, title]) => <li key={id}><a href={`#${id}`}>{title}</a></li>)}</ul>
      </nav>

      <section className="kc-guide" aria-labelledby="pf-issuer">
        <h2 id="pf-issuer">PingFederate as the ID-JAG issuer</h2>
        <p>PingFederate 13.1 issues ID-JAGs through token exchange. The user signs in to an OAuth client; that client exchanges the user's refresh token (or ID token) for an ID-JAG addressed to our resource AS.</p>
        <h3>1. Signing key, published</h3>
        <ol>
          <li>Pick (or create) the RSA signing certificate PingFederate will sign ID-JAGs with.</li>
          <li>Create a JWT access token manager that signs with that certificate and turn on <strong>Publish Keys to the PingFederate JWKS Endpoint</strong>. Without it the key never appears in <T>/pf/JWKS</T> and no redeemer can verify the ID-JAG.</li>
          <li>Keep the JWKS to a <strong>single static key</strong>. PingFederate ID-JAGs carry <T>x5t</T> and no <T>kid</T>, and a PingFederate redeemer cannot pick a key by <T>x5t</T>. Test this IdP warns when more than one distinct RSA key is published.</li>
        </ol>
        <h3>2. Token processor and policy</h3>
        <ol>
          <li>Create a token exchange processor policy for the subject token type your client sends (refresh token or ID token) and map its subject (the user) into the policy contract.</li>
          <li>Give the exchange client the token exchange grant, plus authorization code and refresh token for the user's sign-in.</li>
        </ol>
        <h3>3. ID-JAG SP connection</h3>
        <ol>
          <li>Create an SP connection of type OAuth token exchange with ID-JAG enabled. Its partner is our resource AS: the audience is our resource AS issuer, exactly.</li>
          <li>Map <T>client_id</T> to the client id you register on Trusted IdPs as "client_id your IdP writes in the ID-JAG" (simplest: the <T>idp-&lt;id&gt;</T> client we issue you).</li>
          <li>Map <T>scope</T> to the MCP scopes the user may use (for the sample MCP server, <T>read mcp:invoke</T>).</li>
          <li>Set the ID-JAG lifetime to <strong>5 minutes</strong> (300 s).</li>
        </ol>
        <h3>4. Register it here</h3>
        <ul>
          <li>Product PingFederate; issuer = the base URL exactly as in <T>iss</T>; JWKS = <T>https://&lt;your PingFederate&gt;/pf/JWKS</T>.</li>
          <li>Run Test this IdP: expect one distinct RSA key carrying <T>x5t</T>.</li>
          <li>After approval, fetch your client secret once from My IdPs and give it to the agent that redeems.</li>
        </ul>
      </section>

      <section className="kc-guide" aria-labelledby="pf-redeemer">
        <h2 id="pf-redeemer">PingFederate as the redeemer</h2>
        <p>Our PingFederate can redeem ID-JAGs another IdP issued (the "Our PingFederate" target). An IdP must not redeem its own ID-JAGs, so the issuer is always a different server.</p>
        <ol>
          <li><strong>IdP connection</strong> per trusted issuer, with the issuer as entity id and its JWKS URL. <T>pingfederate/sync-id-jag-trusted-idps.js</T> creates these from the approved registry entries.</li>
          <li><strong>OAuth client</strong> for the redeeming agent (the "Our client at PingFederate" value) with the <strong>EXTENSION</strong> grant type for the JWT bearer grant, and client authentication.</li>
          <li><strong>Access token manager resource URIs</strong>: list the MCP resource the agent sends as <T>resource</T> in an access token manager's selection settings, or PingFederate answers <T>invalid_target</T>.</li>
          <li><strong>JWKS cache</strong>: PingFederate caches the issuer's JWKS and never refetches it for an ID-JAG without a <T>kid</T>. After the issuer changes keys, restart PingFederate.</li>
          <li><strong>Single-key JWKS</strong> at the issuer, for the <T>x5t</T> reason above.</li>
        </ol>
      </section>

      <section className="kc-guide" aria-labelledby="okta">
        <h2 id="okta">Okta Cross App Access</h2>
        <ol>
          <li>Issuer = your Okta <strong>org authorization server</strong>, <T>https://&lt;org&gt;.okta.com</T> (not a custom authorization server). Discovery finds its JWKS.</li>
          <li>In Okta, set up Cross App Access: the requesting app (your agent) and a resource app connection for our resource AS, whose audience is our resource AS issuer.</li>
          <li>The requesting app authenticates to Okta with <strong>private_key_jwt</strong> and exchanges the user's ID token or refresh token at <T>/oauth2/v1/token</T>.</li>
          <li><T>resource</T> must match what Okta has configured exactly, or Okta answers <T>invalid_target</T>.</li>
          <li>Okta ID-JAGs live <strong>300 s</strong>. Register the requesting app's client id as "client_id your IdP writes in the ID-JAG".</li>
        </ol>
      </section>

      <section className="kc-guide" aria-labelledby="generic">
        <h2 id="generic">Any other IdP: the ID-JAG checklist</h2>
        <p>Our resource AS checks every item; one miss and it refuses with <T>invalid_grant</T>, <T>invalid_scope</T> or <T>invalid_target</T>.</p>
        <ul>
          <li>Header <T>typ</T> = <T>oauth-id-jag+jwt</T>; asymmetric <T>alg</T> (RS256); a <T>kid</T> or <T>x5t</T> that matches one key in your JWKS.</li>
          <li><T>iss</T> = your issuer, byte for byte as registered.</li>
          <li><T>sub</T> = the user.</li>
          <li><T>aud</T> = our resource AS issuer, a <strong>single</strong> value.</li>
          <li><T>client_id</T> = exactly the value you registered as "client_id your IdP writes in the ID-JAG" (simplest: the id we issued you, <T>idp-&lt;id&gt;</T>). Binding is strict: any other value is refused, even our own client id.</li>
          <li><T>jti</T> unique per ID-JAG (each one redeems once); <T>iat</T> = now; <T>exp</T> no more than 300 s later.</li>
          <li><T>resource</T> = the MCP server URL; <T>scope</T> = the MCP scopes granted (for example <T>read mcp:invoke</T>).</li>
        </ul>
        <p>Redeem: <T>POST &lt;resource AS&gt;/token</T> with <T>grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer</T> and <T>assertion=&lt;the ID-JAG&gt;</T>, authenticating as <T>idp-&lt;id&gt;</T> with the secret from My IdPs (HTTP Basic or client_secret_post).</p>
      </section>

      <section className="kc-guide" aria-labelledby="xaa">
        <h2 id="xaa">Use xaa.dev (IdenX) as a free outside IdP</h2>
        <p><Ext href="https://xaa.dev">xaa.dev</Ext> is Okta's free Cross App Access playground. Its IdP, IdenX (<T>https://idp.xaa.dev</T>), issues real ID-JAGs, so the "Your IdP" mode can run end to end with an IdP that shares nothing with ours. In that mode, <strong>Get an ID-JAG from xaa.dev</strong> signs you in at IdenX, exchanges for an ID-JAG addressed to resource-as (scope <T>read</T>) and loads it like a pasted one.</p>
        <p>xaa.dev addresses ID-JAGs to a <strong>public https issuer registered at xaa.dev</strong>, so a local run (<T>http://localhost</T>) cannot use it: the button stays disabled and says why. Host this app (Phase 4) first.</p>
        <h3>1. Trusted IdPs: add IdenX</h3>
        <ol>
          <li>Register issuer <T>https://idp.xaa.dev</T>, JWKS <T>https://idp.xaa.dev/jwks</T>, target <strong>Resource AS</strong>, scope cap <T>read</T>, and as "client_id your IdP writes in the ID-JAG" the client we issue it, <T>idp-&lt;id&gt;</T> (for id <T>xaa-dev</T>: <T>idp-xaa-dev</T>). An admin approves it.</li>
          <li>IdenX lets <strong>anyone sign in as any email</strong>, so keep the cap at <T>read</T>. This app's own sign-in rules (Ping email domains, no <T>+</T>) do not apply to an outside IdP's users: trust is the IdP approval, and that is the admin's decision.</li>
          <li>As the entry's owner, fetch its client secret once (My IdPs). Set <T>XAA_DEV_RESOURCE_AS_CLIENT_ID=idp-xaa-dev</T> and <T>XAA_DEV_RESOURCE_AS_CLIENT_SECRET</T> to it.</li>
        </ol>
        <p>xaa.dev asks for an email first. It is only a namespace (no verification), and anyone who types the same address sees your registered clients and their secrets: use a non-personal, hard-to-guess address (for example <T>your-team-idjag-&lt;random&gt;@example.com</T>).</p>
        <h3>2. xaa.dev: register our resource</h3>
        <p>At <Ext href="https://xaa.dev/developer/test-resource">https://xaa.dev/developer/test-resource</Ext>, <strong>Register Resource</strong> (a 4-step wizard):</p>
        <ol>
          <li><strong>Basic Info.</strong> Type REST API. Resource Identifier URL = <T>ID_JAG_RESOURCE</T> (the ID-JAG's <T>resource</T>; xaa.dev adds a trailing slash, which resource-as accepts).</li>
          <li><strong>Auth Server.</strong> Use My Own Auth Server. Token Endpoint = resource-as's public token endpoint. Discovery from the browser usually fails on CORS; then type <strong>Auth Server URL</strong> = <T>RESOURCE_AS_ISSUER</T>, exactly (it becomes the ID-JAG <T>aud</T>). Target Client ID = the entry's <T>idp-&lt;id&gt;</T> from step 1; Target Client Secret = its secret (sent with <T>client_secret_post</T>).</li>
          <li><strong>Scopes &amp; Config.</strong> Add scope <T>read</T>. Health check and endpoint paths are joined onto the Resource Identifier URL; only xaa.dev's own tester uses them.</li>
          <li><strong>Review</strong>, then Register Resource.</li>
        </ol>
        <h3>3. xaa.dev: register this app</h3>
        <p>At <Ext href="https://xaa.dev/developer/register">https://xaa.dev/developer/register</Ext>, Register New App (after step 2): redirect URI <T>{"${APP_ORIGIN}"}/api/id-jag-playground/xaa/callback</T>, and Connect to Resource = the resource from step 2. The credentials appear once: use the <strong>main</strong> <T>client_id</T>/<T>client_secret</T> for <T>XAA_DEV_IDP_CLIENT_ID</T>/<T>XAA_DEV_IDP_CLIENT_SECRET</T> (the <T>…-at-…</T> resource client is for xaa.dev's own auth server). Restart the server.</p>
        <h3>4. Run it</h3>
        <ul>
          <li>The button's pre-flight checks that IdenX answers, that its entry is approved for the resource AS, and that our redeeming client is configured.</li>
          <li>xaa.dev's own tester fails at its step 4 inside xaa.dev's proxy: use this app's step 4 instead.</li>
          <li>CORS for <T>https://xaa.dev</T> is only needed if you run xaa.dev's in-browser tester against this app.</li>
        </ul>
      </section>

      <section className="kc-guide" aria-labelledby="desktop">
        <h2 id="desktop">Use mcpc or VS Code as the client</h2>
        <p>Two real MCP clients run the whole flow themselves: sign in at PingFederate, trade the <strong>ID token</strong> for an ID-JAG addressed to our resource AS, redeem it, then call the sample MCP server. Both are free: <Ext href="https://github.com/apify/mcpc">mcpc</Ext> (Apache-2.0) and VS Code 1.123 or later (enterprise-managed MCP authentication, preview).</p>
        <h3>1. Set up once</h3>
        <ol>
          <li>After <T>pingfederate/configure-signin.js</T>, run <T>node pingfederate/configure-desktop-clients.js --ns=&lt;namespace&gt;</T>. It adds the ID-token subject at PingFederate, an SP connection for this resource AS, the clients <T>id-jag-mcpc</T> and <T>id-jag-vscode</T>, and the resource AS's trust and client files under <T>deploy/local/</T>. Secrets go to <T>.env</T> only.</li>
          <li>Start with the overlay: <T>docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.desktop-clients.yml up --build -d</T>.</li>
          <li>Users sign in through this kit's PingOne environment, so register there first.</li>
        </ol>
        <h3>2. mcpc</h3>
        <p>With the two secrets from <T>.env</T> in your shell:</p>
        <pre className="kc-code">{MCPC}</pre>
        <p>The login opens your browser once. <T>whoami</T> answers with your subject, the client <T>id-jag-desktop</T> and scope <T>read mcp:invoke</T>.</p>
        <h3>3. VS Code</h3>
        <ol>
          <li>User <T>settings.json</T> (for local testing; in production an admin pushes this setting by policy):<pre className="kc-code">{VSCODE_SETTINGS}</pre></li>
          <li>User <T>mcp.json</T>:<pre className="kc-code">{VSCODE_MCP}</pre>Use the <strong>Set Client Secret</strong> code lens above <T>clientId</T> for <T>DESKTOP_RESOURCE_CLIENT_SECRET</T>; VS Code keeps it in the OS secret store.</li>
          <li>Start the server and sign in once in the browser. Later enterprise-managed servers connect silently.</li>
        </ol>
        <h3>Why it is set up this way</h3>
        <ul>
          <li>Both clients send the ID token as the subject, so PingFederate needs an exchange policy for <T>id_token</T> next to the refresh-token one.</li>
          <li>PingFederate refuses ID-JAGs to public clients, so the IdP clients are confidential, even for a desktop app.</li>
          <li>MCP SDK clients require <T>authorization_endpoint</T> and <T>response_types_supported</T> in the resource AS metadata. Ours advertises none, and its <T>/authorize</T> answers <T>unsupported_response_type</T>.</li>
          <li>The MCP server must answer 401 with <T>WWW-Authenticate: Bearer resource_metadata=…</T>: VS Code only starts sign-in after a 401.</li>
        </ul>
      </section>
    </main>
  );
}
