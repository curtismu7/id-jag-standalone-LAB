import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import InteropPanel from "../InteropPanel";

const TARGETS = [
  { id: "xaa-dev", name: "xaa.dev hosted resource AS", audience: "https://auth.resource.xaa.dev", recorded: { result: "refuses", note: "signature invalid" }, missing: [] },
  { id: "xaa-dev-kid", method: "kid", name: "xaa.dev hosted resource AS", audience: "https://auth.resource.xaa.dev", recorded: { result: "accepts", note: "HTTP 200" }, missing: [] },
  { id: "motd", name: "motd.xaa.rocks", audience: "https://motd.xaa.rocks/", recorded: { result: "refuses", note: "missing kid" }, missing: ["INTEROP_X_CLIENT_ID"] },
];
const client = (post = vi.fn()) => ({ get: vi.fn().mockResolvedValue({ data: { targets: TARGETS } }), post });

describe("InteropPanel", () => {
  it("shows the recorded result per target and disables Run where the server lacks a client", async () => {
    render(<InteropPanel client={client()} base="/api/x" />);
    expect((await screen.findAllByText("xaa.dev hosted resource AS")).length).toBe(2);
    const [xaa, , motd] = screen.getAllByRole("button", { name: "Run" });
    expect(xaa).toBeEnabled();
    expect(motd).toBeDisabled();
    expect(screen.getByText(/Workaround: token exchange answered by a JWT access token manager/)).toBeInTheDocument();
    expect(screen.getAllByText(/Native ID-JAG from PingFederate/).length).toBeGreaterThan(0);
  });

  it("runs a target and shows accepted/refused with the header facts, never a token", async () => {
    const post = vi.fn().mockResolvedValue({ data: { target: "xaa-dev", mint: { status: 200, header: { kid: false, x5t: true } },
      redeem: { status: 400, accepted: false, error: "invalid_grant", error_description: "JWT signature is invalid" } } });
    render(<InteropPanel client={client(post)} base="/api/x" />);
    await screen.findAllByText("xaa.dev hosted resource AS");
    fireEvent.click(screen.getAllByRole("button", { name: "Run" })[0]);
    expect(await screen.findByText(/header kid: no, x5t: yes/)).toBeInTheDocument();
    expect(screen.getByText("refused")).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith("/api/x/interop/xaa-dev/run");
  });

  it("explains a PingFederate refusal when the target's connection is missing", async () => {
    const post = vi.fn().mockResolvedValue({ data: { target: "xaa-dev", mint: { status: 400, error: "invalid_target", hint: "Is the target's SP connection there?" } } });
    render(<InteropPanel client={client(post)} base="/api/x" />);
    await screen.findAllByText("xaa.dev hosted resource AS");
    fireEvent.click(screen.getAllByRole("button", { name: "Run" })[0]);
    await waitFor(() => expect(screen.getByText(/PingFederate refused the exchange: invalid_target/)).toBeInTheDocument());
  });

  it("renders nothing when the server lists no targets", async () => {
    const c = { get: vi.fn().mockResolvedValue({ data: [] }), post: vi.fn() };
    const { container } = render(<InteropPanel client={c} base="/api/x" />);
    await waitFor(() => expect(c.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
