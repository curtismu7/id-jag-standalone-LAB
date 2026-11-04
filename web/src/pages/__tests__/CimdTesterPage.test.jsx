import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("../../services/api", () => ({ default: { get: vi.fn(), post } }));

import CimdTesterPage from "../CimdTesterPage";

const SERVER = {
  issuer: "https://pf.mock.invalid",
  checks: [
    { name: "client_id_metadata_document_supported", ok: true, value: true },
    { name: "code_challenge_methods_supported includes S256", ok: true, value: ["S256"] },
  ],
};
const CLIENT = { source: "pasted", valid: false, errors: [{ path: "client_id", message: "client_id must be an HTTPS URL" }], warnings: [] };
const PROBE = {
  results: [
    { id: "valid", title: "This app's document, its own redirect URI", expect: "accept", accepted: true, pfSays: "Sign-in flow started: client accepted", asExpected: true, trace: {} },
    { id: "shared-secret", title: "Document asks for a shared client secret", expect: "refuse", accepted: false, pfSays: "400 - Invalid client_id", asExpected: true, trace: {} },
  ],
};

beforeEach(() => {
  post.mockReset();
});

describe("CIMD tester page", () => {
  it("checks discovery and renders each check with Pass/Fail", async () => {
    post.mockResolvedValue({ status: 200, data: SERVER });
    render(<CimdTesterPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Test PingFederate (server)" }));
    fireEvent.click(screen.getByRole("button", { name: "Check PingFederate discovery" }));
    await waitFor(() => expect(screen.getByTestId("cimd-tester-server")).toBeInTheDocument());
    expect(screen.getAllByText(/Pass/).length).toBe(2);
    expect(screen.getByText(/pf\.mock\.invalid/)).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith("/api/cimd/tester/server");
  });

  it("sends a pasted document as { document } and renders the findings", async () => {
    post.mockResolvedValue({ status: 200, data: CLIENT });
    render(<CimdTesterPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Test a document (client)" }));
    fireEvent.change(screen.getByLabelText(/paste a document/i), { target: { value: '{"client_id": "x"}' } });
    fireEvent.click(screen.getByRole("button", { name: "Check the pasted document" }));
    await waitFor(() => expect(screen.getByTestId("cimd-tester-findings")).toBeInTheDocument());
    expect(screen.getByText(/Not a valid/)).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith("/api/cimd/tester/client");
  });

  it("renders the probe verdict table with as-expected columns", async () => {
    post.mockResolvedValue({ status: 200, data: PROBE });
    render(<CimdTesterPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Test a document (client)" }));
    fireEvent.click(screen.getByRole("button", { name: /Ask PingFederate/ }));
    await waitFor(() => expect(screen.getByTestId("cimd-tester-probe")).toBeInTheDocument());
    expect(screen.getByText("Sign-in flow started: client accepted")).toBeInTheDocument();
    expect(screen.getByText("400 - Invalid client_id")).toBeInTheDocument();
  });

  it("credits client.dev and shows the tester error shape when the API refuses", async () => {
    post.mockRejectedValue(Object.assign(new Error("HTTP 409"), { response: { status: 409, data: { error: "live_unavailable", message: "Mock mode only." } } }));
    render(<CimdTesterPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Test a document (client)" }));
    fireEvent.click(screen.getByRole("button", { name: /Ask PingFederate/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText(/live_unavailable/)).toBeInTheDocument();
    const credit = screen.getByRole("link", { name: "client.dev" });
    expect(credit).toHaveAttribute("href", "https://client.dev");
  });
});
