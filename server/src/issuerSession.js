// The one place the playground reads a signed-in user's issuer token from the session: the
// refresh token it exchanges (RFC 8693) for an ID-JAG. Today the pi.flow sign-in at /api/id-jag-playground/issuer/pi-flow
// (code + PKCE at the mode's issuer PingFederate) stores it as session.idJagIssuer = { mode, refreshToken }.
// Phase 3B's app sign-in at PF_URL can fill that slot with mode 'pf-as', or change only this function.
// null = not signed in at this mode's issuer: callers answer 409 sign_in_required.
export function getIssuerSubjectToken(req, mode) {
  const s = req.session?.idJagIssuer;
  return s?.mode === mode && s.refreshToken ? s.refreshToken : null;
}
