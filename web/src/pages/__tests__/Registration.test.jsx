import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../services/api", () => ({ default: { get, post } }));

import RegisterPage from "../RegisterPage";
import AccountRequestsPage from "../AccountRequestsPage";

const ADMIN = { email: "ada@pingidentity.com", name: "Ada", isAdmin: true };
const USER = { email: "olivia@pingidentity.com", name: "Olivia", isAdmin: false };
const ROW = { id: "r1", email: "new.user@pingidentity.com", status: "pending", createdAt: "2026-10-20T10:00:00Z", decidedAt: null, decidedBy: null, reason: null };

beforeEach(() => { get.mockReset(); post.mockReset(); });

const fill = (email, pass, again = pass) => {
  fireEvent.change(screen.getByLabelText("Work email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: pass } });
  fireEvent.change(screen.getByLabelText("Repeat the password"), { target: { value: again } });
  fireEvent.click(screen.getByRole("button", { name: "Request account" }));
};

describe("Register page", () => {
  it("posts the request and then shows that an admin must approve it", async () => {
    post.mockResolvedValue({ status: 201, data: { id: "r1", status: "pending" } });
    render(<RegisterPage />);
    fill("new.user@pingidentity.com", "a-long-enough-password");
    expect(await screen.findByText("Request sent")).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith("/api/register", { email: "new.user@pingidentity.com", password: "a-long-enough-password" });
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("refuses a short password and a mismatch without calling the server", async () => {
    render(<RegisterPage />);
    fill("a@pingidentity.com", "short");
    expect(await screen.findByRole("alert")).toHaveTextContent("at least 12");
    fill("a@pingidentity.com", "a-long-enough-password", "a-different-long-password");
    expect(await screen.findByText("The two passwords do not match.")).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("shows the server's reason, such as a refused domain", async () => {
    post.mockRejectedValue(Object.assign(new Error("HTTP 400"), { response: { data: { message: "Only pingidentity.com, pingone.com email addresses may sign in." } } }));
    render(<RegisterPage />);
    fill("x@gmail.com", "a-long-enough-password");
    expect(await screen.findByRole("alert")).toHaveTextContent("Only pingidentity.com");
  });
});

describe("Account requests page", () => {
  const mount = (me, rows = [ROW]) => {
    get.mockImplementation((url) => Promise.resolve(url === "/api/me"
      ? (me ? { status: 200, data: me } : { status: 401, data: {} })
      : { status: 200, data: { registrations: rows } }));
    return render(<AccountRequestsPage />);
  };

  it("shows a non-admin nothing to review and never fetches the queue", async () => {
    mount(USER);
    expect(await screen.findByText("Only admins can review account requests.")).toBeInTheDocument();
    expect(get).not.toHaveBeenCalledWith("/api/registrations");
  });

  it("approves a pending request and reloads", async () => {
    post.mockResolvedValue({ status: 200, data: { ...ROW, status: "approved" } });
    mount(ADMIN);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/registrations/r1/approve", {}));
    await waitFor(() => expect(get.mock.calls.filter(([u]) => u === "/api/registrations").length).toBe(2));
  });

  it("rejects with a reason", async () => {
    post.mockResolvedValue({ status: 200, data: {} });
    mount(ADMIN);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "not a Ping employee" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm reject" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/registrations/r1/reject", { reason: "not a Ping employee" }));
  });

  it("shows the PingFederate error when approval fails, and keeps the row pending", async () => {
    post.mockRejectedValue(Object.assign(new Error("HTTP 502"), { response: { data: { message: "PingFederate admin API unreachable: timed out" } } }));
    mount(ADMIN);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("unreachable");
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });
});
