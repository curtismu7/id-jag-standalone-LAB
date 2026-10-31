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
          : path.startsWith("/register") ? RegisterPage
            : path.startsWith("/account-requests") ? AccountRequestsPage
              : IdJagPlaygroundPage;

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <AppShell><Page /></AppShell>
  </StrictMode>,
);
