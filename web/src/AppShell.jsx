import { useEffect, useState } from "react";
import { useMe } from "./auth/useMe";
import { signIn } from "./utils/signIn";
import { CustomerProvider, useCustomer } from "./customer/CustomerConfig";
import SignInModal from "./components/SignInModal";
import { ModeProvider } from "./mode/ModeContext";
import { ModeBanner, ModeToggle } from "./mode/ModeToggle";
import { PresentBar, PresentProvider, PresentToggle } from "./present/PresentMode";
import "./AppShell.css";

const THEME_KEY = "idjag.theme";
const SPEC_URL = "https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/";
// Third item: admin/setup pages, hidden in presenter mode.
const PAGES = [["/", "Playground"], ["/trusted-idps", "Trusted IdPs", true], ["/guides", "Setup guides", true], ["/inspect", "Inspector"], ["/learn", "Learn"]];
const currentPage = () => {
  const p = window.location.pathname;
  return PAGES.slice(1).find(([href]) => p.startsWith(href))?.[0] || "/";
};

function initialTheme() {
  try { const t = localStorage.getItem(THEME_KEY); if (t === "light" || t === "dark") return t; } catch { /* storage blocked */ }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Brand frame: Core Dark bar, Ping Red rule, page nav, signed-in user, theme switch. */
function Shell({ children }) {
  const [theme, setTheme] = useState(initialTheme);
  const me = useMe();
  const customer = useCustomer();
  const here = currentPage();
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, next); } catch { /* not remembered */ }
    setTheme(next);
  };

  return (
    <div className="shell">
      <header className="shell-bar">
        <a className="shell-brand" href="/">
          <img src="/branding/ping-logo.png" alt="Ping Identity" />
          {customer.brand?.logoUrl && <img src={customer.brand.logoUrl} alt="" />}
          <span>{customer.name || "ID-JAG Kit"}</span>
        </a>
        <nav aria-label="Site" className="shell-nav">
          {PAGES.map(([href, label, admin]) => <a key={href} href={href} data-admin-only={admin ? "" : undefined} aria-current={href === here ? "page" : undefined}>{label}</a>)}
          {me?.isAdmin && <a href="/account-requests" data-admin-only="" aria-current={window.location.pathname.startsWith("/account-requests") ? "page" : undefined}>Account requests</a>}
          <a href={SPEC_URL} target="_blank" rel="noopener noreferrer">IETF draft</a>
        </nav>
        {me && (
          <form className="shell-user" method="post" action="/auth/logout">
            <span title={me.email}>{me.name || me.email}</span>
            {me.isAdmin && <span className="shell-badge" data-admin-only="">Admin</span>}
            <button type="submit" className="shell-theme">Sign out</button>
          </form>
        )}
        {me === null && <button type="button" className="shell-theme" onClick={() => signIn()}>Sign in</button>}
        <ModeToggle />
        <PresentToggle />
        <button type="button" className="shell-theme" onClick={flip} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
          {theme === "dark" ? "Light" : "Dark"}
        </button>
      </header>
      <ModeBanner />
      <PresentBar />
      {children}
      <SignInModal />
    </div>
  );
}

export default function AppShell({ children }) {
  return <CustomerProvider><ModeProvider><PresentProvider><Shell>{children}</Shell></PresentProvider></ModeProvider></CustomerProvider>;
}
