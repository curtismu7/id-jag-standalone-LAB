import { render, screen, waitFor, within } from "@testing-library/react";

const { get, post, put, del } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock("../../services/api", () => ({ default: { get, post, put, delete: del } }));

import IdJagPlaygroundPage from "../../pages/IdJagPlaygroundPage";

const config = {
  mode: "pf-as", signedIn: true,
  idp: { name: "PingFederate (issuer)", issuer: "https://pf.test", tokenEndpoint: "https://pf.test/t", jwksUrl: "https://pf.test/j", exchangeClientId: "x" },
  resourceAs: { name: "Resource AS", issuer: "https://as.test", tokenEndpoint: "https://as.test/token", clientId: "c" },
  request: { resource: "https://as.test/mcp", scope: "mcp:invoke" },
};

it("tags the Report group, backends Re-check, interop panel and real-clients panel as admin-only", async () => {
  localStorage.clear();
  localStorage.setItem("idjag.playground.mode", "pf-as");
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network"))));
  get.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/config") ? config : url.endsWith("/interop") ? { targets: [{ id: "t", name: "Target", audience: "a", recorded: { result: "accepts", note: "n" }, missing: [] }] } : url.includes("/preflight?") ? { ok: true, checks: [] } : [] }));
  render(<IdJagPlaygroundPage />);
  const strip = await screen.findByTestId("ijp-backends");
  await waitFor(() => expect(within(strip).getByRole("button", { name: "Re-check" })).toHaveAttribute("data-admin-only"));
  expect(screen.getByText("Report").closest(".ijp-toolbar__group")).toHaveAttribute("data-admin-only");
  expect(await screen.findByTestId("ijp-interop")).toHaveAttribute("data-admin-only");
  expect(screen.getByText(/Run this flow from a real client/).closest("details")).toHaveAttribute("data-admin-only");
  expect(screen.getByRole("button", { name: "Start over" }).closest("[data-admin-only]")).toBeNull();
  vi.unstubAllGlobals();
});
