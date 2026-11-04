// Fonts are bundled with the app, so the page loads nothing from outside it (Mock mode makes no outbound calls):
// Montserrat for text, IBM Plex Mono for code.
import "@fontsource/montserrat/400.css";
import "@fontsource/montserrat/500.css";
import "@fontsource/montserrat/600.css";
import "@fontsource/montserrat/700.css";
import "@fontsource/montserrat/800.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./standalone-ui.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import AppShell from "./AppShell";
import IdJagPlaygroundPage from "./pages/IdJagPlaygroundPage";
import IdJagPlaygroundDiagramPage from "./pages/IdJagPlaygroundDiagramPage";
import TrustedIdpsPage from "./pages/TrustedIdpsPage";
import GuidesPage from "./pages/GuidesPage";
import LearnPage from "./pages/LearnPage";
import InspectPage from "./pages/InspectPage";
import CimdTesterPage from "./pages/CimdTesterPage";
import RegisterPage from "./pages/RegisterPage";
import AccountRequestsPage from "./pages/AccountRequestsPage";

// No router: the page is picked by path (the server answers every path with index.html).
// /diagram/:mode is the per-mode diagram (opened in a new tab); anything unknown is the playground.
const path = window.location.pathname;
const Page = path.startsWith("/diagram/") ? IdJagPlaygroundDiagramPage
  : path.startsWith("/trusted-idps") ? TrustedIdpsPage
    : path.startsWith("/guides") ? GuidesPage
      : path.startsWith("/learn") ? LearnPage
        : path.startsWith("/inspect") ? InspectPage
          : path.startsWith("/cimd") ? CimdTesterPage
            : path.startsWith("/register") ? RegisterPage
            : path.startsWith("/account-requests") ? AccountRequestsPage
              : IdJagPlaygroundPage;

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <AppShell><Page /></AppShell>
  </StrictMode>,
);
