import ShelfLink from "./components/ShelfLink.jsx";
// Opened from Customer Agent LAB (UC-LEARN8, UC-LEARN9, UC25 and UC40 route here): strip + header Back only. Those use cases are
// the whole playground, not one of its settings, so nothing is preselected.
import ReturnLink from "./return-link/ReturnLink.jsx";
import { useEffect, useState } from "react";
import { useMe } from "./auth/useMe";
import { signIn } from "./utils/signIn";
import { CustomerProvider, useCustomer } from "./customer/CustomerConfig";
import SignInModal from "./components/SignInModal";
import { ModeProvider, useAppMode } from "./mode/ModeContext";
import { ClaimBanner, ModeBanner } from "./mode/ModeToggle";
import { PresentBar, PresentProvider, usePresent } from "./present/PresentMode";
import TopMenu from "./top-menu/TopMenu";
import "./AppShell.css";

const THEME_KEY = "idjag.theme";
const THEMES = [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]];
const SPEC_URL = "https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/";
// Third item: admin/setup pages, hidden in presenter mode.
const PAGES = [["/", "Playground"], ["/trusted-idps", "Trusted IdPs", true], ["/guides", "Setup guides", true], ["/inspect", "Inspector"], ["/cimd", "CIMD tester"], ["/learn", "Learn"]];
const currentPage = () => {
  const p = window.location.pathname;
  return PAGES.slice(1).find(([href]) => p.startsWith(href))?.[0] || "/";
};

function initialTheme() {
  try { const t = localStorage.getItem(THEME_KEY); if (t === "light" || t === "dark") return t; } catch { /* storage blocked */ }
  return "auto";
}

/** Brand frame: Core Dark bar, Ping Red rule, page nav, signed-in user, theme switch. */
function Shell({ children }) {
  const [theme, setTheme] = useState(initialTheme);
  const me = useMe();
  const customer = useCustomer();
  const mode = useAppMode();
  const present = usePresent();
  const here = currentPage();
  useEffect(() => { if (theme === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme; }, [theme]);
  const pickTheme = (next) => {
    try { if (next === "auto") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, next); } catch { /* not remembered */ }
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
        <span className="shell-right">
          <TopMenu
            mode={mode?.status === "ready" ? {
              // the lab's mode id is "live"; TopMenu's select speaks "mock"/"real"
              value: mode.mode === "live" ? "real" : "mock",
              onChange: (v) => mode.choose(v === "real" ? "live" : "mock"),
              realAvailable: mode.live?.ready,
              realHint: mode.live?.ready ? undefined : `Live needs: ${(mode.live?.missing || []).join(", ")}`,
            } : undefined}
            theme={{ value: theme, onChange: pickTheme }}
            present={{ active: present?.present, onToggle: () => present?.set(!present?.present), label: "Present" }}
            help={{ href: "https://github.com/curtismu7/id-jag-standalone-LAB#readme" }}
            version={mode?.version || null}
            extra={<ReturnLink app="id-jag-standalone" variant="header" />}
          >
            <ShelfLink />
          </TopMenu>
        </span>
        {me === null && <button type="button" className="shell-theme shell-signin" onClick={() => signIn()}>Sign in</button>}
      </header>
      <ModeBanner />
      <ReturnLink app="id-jag-standalone" />
      <ClaimBanner />
      <PresentBar />
      {children}
      <SignInModal />
    </div>
  );
}

export default function AppShell({ children }) {
  return <CustomerProvider><ModeProvider><PresentProvider><Shell>{children}</Shell></PresentProvider></ModeProvider></CustomerProvider>;
}
