// Who may sign in, decided on the validated ID token claims. Enforced here even though the IdP
// (PingFederate -> PingOne) is configured the same way: never trust the IdP config alone.

const DEFAULT_DOMAINS = 'pingidentity.com,pingone.com';
import { runtimeEnv } from '../mode.js';

export const allowedDomains = (env = runtimeEnv()) =>
  String(env.ALLOWED_EMAIL_DOMAINS || DEFAULT_DOMAINS).split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

const refuse = (rule, message) => ({ rule, message });

/** null when the claims may sign in, else { rule, message } naming the rule that failed. */
export function checkEmail(claims, domains) {
  const email = claims?.email;
  if (typeof email !== 'string' || !email) return refuse('missing', 'Your account did not share an email address.');
  const m = /^([^@\s]+)@([^@\s]+)$/.exec(email);
  if (!m) return refuse('format', 'Your email address is not a plain name@domain address.');
  // Exact match only: no subdomains, no suffix tricks.
  if (!domains.includes(m[2].toLowerCase())) {
    return refuse('domain', `Only ${domains.join(', ')} email addresses may sign in.`);
  }
  if (m[1].includes('+')) return refuse('plus', 'Plus-addressed emails (name+tag@...) may not sign in. Use your primary address.');
  if (claims.email_verified !== true) return refuse('unverified', 'Your email address is not verified at your identity provider.');
  return null;
}
