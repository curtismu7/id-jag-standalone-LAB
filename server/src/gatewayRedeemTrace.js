// "What Privilege did" for the gateway-redeem mode: one trace record for the agent's call to the SIMULATED gateway (Rule 25).
// Mock only: this lab has no real gateway hop (live answers 409), so every decision here is 'checked' and the source is 'mock'.
//
// Every decision is read from evidence the simulation stored while it ran (gatewayCall's result and the hops it traced):
//   caller      jose.jwtVerify in gatewayCall                          (out.callerOk, out.refusal at stage 'caller')
//   per leg     clientAuth (config), then the outgoing rules in post() (allow-list, no redirect, 64 KB), then the issuer's own answer
//               (out.refusal with kind 'config' | 'ssrf' | 'redirect' | 'size' | 'oauth'; the issuer names the check that failed)
//   target      the target API's own verified[] list (every check it evaluated, in order)
// Nothing is invented: a check the code did not evaluate is 'skipped' with the reason, never passed. The caller token is shown
// shortened (bearerForDisplay); ClientSecret and PrivateKeyPEM never reach a hop (see showForm), so they cannot reach a decision.

import { bearerForDisplay, mockTrace } from './gatewayTrace.js';

const d = (id, label, outcome, evidence) => ({ id, label, outcome, evidence });
const clip = (s, n = 280) => String(s ?? '').slice(0, n);

const oauthText = (r) => `HTTP ${r.status}: ${r.error}${r.check ? `, check: ${r.check}` : ''}. ${clip(r.description)}`.trim();

const skippedLeg = (n, who, why) => [d(`leg${n}-auth`, `Leg ${n}: client authentication`, 'skipped', why),
  d(`leg${n}-rules`, `Leg ${n}: the gateway's rules for the outgoing call`, 'skipped', why), d(`leg${n}-answer`, `Leg ${n}: the ${who}'s answer`, 'skipped', why)];

/** The three decisions of one leg (client authentication, the gateway's outgoing rules, the issuer's answer). */
function legDecisions({ n, stage, who, hop, refusal, ok }) {
  const r = refusal?.stage === stage ? refusal : null;
  const out = [];
  const authId = `leg${n}-auth`;
  const rulesId = `leg${n}-rules`;
  const answerId = `leg${n}-answer`;
  const authLabel = `Leg ${n}: client authentication`;
  const rulesLabel = `Leg ${n}: the gateway's rules for the outgoing call`;
  const answerLabel = `Leg ${n}: the ${who}'s answer`;

  if (!r && !hop) return skippedLeg(n, who, 'not reached');
  if (r?.kind === 'config') {
    return [d(authId, authLabel, 'fail', clip(r.description)),
      d(rulesId, rulesLabel, 'skipped', 'not reached: no request was built'), d(answerId, answerLabel, 'skipped', 'not reached: no request was built')];
  }
  out.push(d(authId, authLabel, 'pass', `the gateway built the client authentication for this leg: ${hop?.request?.authentication ?? 'none'}`));
  if (r && ['ssrf', 'redirect', 'size'].includes(r.kind)) {
    out.push(d(rulesId, rulesLabel, 'fail', `${r.kind}: ${clip(r.description)}`));
    out.push(d(answerId, answerLabel, 'skipped', r.kind === 'ssrf' ? 'not reached: nothing was sent' : 'not used: the gateway refused the answer'));
    return out;
  }
  out.push(d(rulesId, rulesLabel, 'pass', 'the destination is an allow-listed https host, the answer was not a redirect and fit in 64 KB'));
  if (r) out.push(d(answerId, answerLabel, 'fail', oauthText(r)));
  else out.push(d(answerId, answerLabel, 'pass', ok));
  return out;
}

/** The decisions of one gateway call, in the order gatewayCall evaluates them. */
export function gatewayDecisions({ result, hops, redeemSet }) {
  const { refusal } = result;
  const leg1Hop = hops.find((h) => h.label.startsWith('Leg 1'));
  const leg2Hop = hops.find((h) => h.label.startsWith('Leg 2'));
  const decisions = [];

  // 1. The caller's token (jose.jwtVerify).
  if (result.callerOk) {
    decisions.push(d('caller', 'Caller token', 'pass', 'the gateway verified the caller token: ES256 signature, issuer, audience, type at+jwt and expiry. HTTP 200 on this call means the caller was accepted; the simulation sends no JSON-RPC reply, so what happened next is in the decisions below.'));
  } else {
    decisions.push(d('caller', 'Caller token', 'fail', clip(refusal?.description)));
    const why = 'not reached: the caller was not accepted';
    decisions.push(...skippedLeg(1, 'exchange issuer', why), d('leg2', 'Leg 2: redeem at the target issuer', 'skipped', why), d('target', 'Target API', 'skipped', why));
    return decisions;
  }

  // 2. Leg 1: RFC 8693 exchange.
  decisions.push(...legDecisions({ n: 1, stage: 'leg1', who: 'exchange issuer', hop: leg1Hop, refusal,
    ok: `the exchange issuer answered 200 and issued a token of type ${result.leg1?.issuedTokenType ?? 'unknown'}` }));
  if (refusal?.stage === 'leg1') {
    decisions.push(d('leg2', 'Leg 2: redeem at the target issuer', 'skipped', 'not reached: leg 1 was refused'));
    decisions.push(d('target', 'Target API', 'skipped', 'not reached: leg 1 was refused'));
    return decisions;
  }

  // 3. Leg 2: RFC 7523 redeem, only when Redeem.TokenURL is set.
  if (!redeemSet) {
    decisions.push(d('leg2', 'Leg 2: redeem at the target issuer', 'skipped', 'Redeem.TokenURL is not set, so the gateway sent no second leg and passed the exchange result to the target API as it was'));
  } else {
    decisions.push(...legDecisions({ n: 2, stage: 'leg2', who: 'target issuer', hop: leg2Hop, refusal, ok: 'the target issuer answered 200 and minted an access token' }));
    if (refusal?.stage === 'leg2') {
      decisions.push(d('target', 'Target API', 'skipped', 'not reached: leg 2 was refused'));
      return decisions;
    }
  }

  // 4. The target API, which lists every check it evaluated.
  const t = result.target;
  if (!t) {
    decisions.push(d('target', 'Target API', 'skipped', 'not reached'));
  } else if (refusal?.stage === 'target') {
    const failed = (t.body?.verified ?? []).find((v) => !v.ok);
    decisions.push(d('target', 'Target API', 'fail', `HTTP ${t.status}: ${clip(t.body?.error)}${failed ? `, check: ${failed.check}. ${clip(failed.detail)}` : ''}`));
  } else {
    const names = (t.body?.verified ?? []).map((v) => v.check);
    decisions.push(d('target', 'Target API', 'pass', `the target API answered ${t.status}${names.length ? ` after it verified: ${names.join(', ')}` : ''}${t.body?.principal?.sub ? `, and it sees ${t.body.principal.sub}` : ''}`));
  }
  return decisions;
}

/**
 * The trace of one run: the agent's request to the gateway, the status the simulation gives that call, and the decisions.
 * `hops` is the hop list as it stood when gatewayCall returned (hop 1 is the agent's call).
 */
export function gatewayRunTrace({ callerToken, result, hops, redeemSet }) {
  const first = hops[0];
  return mockTrace({
    url: first.url,
    authorization: bearerForDisplay(`${callerToken}`),
    rpc: first.request?.body ?? null,
    status: result.callerOk ? 200 : 401,
    headers: {},
    body: null,
    decisions: gatewayDecisions({ result, hops, redeemSet }),
  });
}
