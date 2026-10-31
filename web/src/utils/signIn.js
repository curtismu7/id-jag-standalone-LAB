// Sign-in: SignInModal (mounted in AppShell) answers the event and drives PingFederate's pi.flow in a dialog.
// There is no redirect login: with no modal mounted the event is only logged.
function request(kind, returnTo) {
  const detail = { kind, returnTo, handled: false };
  window.dispatchEvent(new CustomEvent("idjag:signin", { detail }));
  if (!detail.handled) console.error("idjag:signin was not handled: no SignInModal is mounted");
}

export const signIn = (returnTo = window.location.pathname) => request("app", returnTo);
export const signInIssuer = (returnTo = window.location.pathname) => request("issuer", returnTo);
