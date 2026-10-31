import { fireEvent, render, screen, within } from "@testing-library/react";
import StoryPanel from "../StoryPanel";

beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });

describe("StoryPanel", () => {
  it("renders nothing for a mode with no story", () => {
    const { container } = render(<StoryPanel mode="nope" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the generic story with the first step open and the proof", () => {
    render(<StoryPanel mode="byo" />);
    expect(screen.getByRole("heading", { name: /Lena reads shared data from Acme/ })).toBeInTheDocument();
    expect(screen.getByText(/Bring in the partner's ID-JAG/)).toBeInTheDocument();
    expect(screen.getByText(/The partner vouches for Lena/)).toBeInTheDocument();
    expect(screen.getByText(/The decoded access token/)).toBeInTheDocument();
    expect(screen.queryByText(/⟨missing/)).toBeNull();
  });

  it("re-skins names and nouns when a vertical is picked, and remembers it", () => {
    const { unmount } = render(<StoryPanel mode="byo" />);
    fireEvent.change(screen.getByLabelText("Vertical"), { target: { value: "healthcare" } });
    expect(screen.getByRole("heading", { name: /Lena reads shared data from the partner clinic/ })).toBeInTheDocument();
    expect(screen.getByText("Story S11 · CareConnect")).toBeInTheDocument();
    expect(screen.getByText(/the shared referral records/)).toBeInTheDocument();
    unmount();
    render(<StoryPanel mode="byo" />);
    expect(screen.getByLabelText("Vertical")).toHaveValue("healthcare");
  });

  it("switches to the blocked wording only on steps that have it", () => {
    render(<StoryPanel mode="byo" />);
    fireEvent.click(screen.getByRole("button", { name: "Blocked" }));
    expect(screen.getByRole("button", { name: "Blocked" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /Redeem it at our authorization server/ }));
    expect(screen.getByText(/not on the Trusted IdPs list, or not yet approved/)).toBeInTheDocument();
    expect(screen.getByText(/The refusal: an OAuth error/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Prove the refusals/ }));
    expect(screen.getByText(/Live negative tests break the assertion/)).toBeInTheDocument();
  });

  it("marks the steps that have a blocked variant", () => {
    render(<StoryPanel mode="byo" />);
    fireEvent.click(screen.getByRole("button", { name: "Blocked" }));
    const tagged = screen.getAllByText("blocked").length;
    expect(tagged).toBe(3);
  });

  it("scrolls to the playground step when a step is picked", () => {
    const target = document.createElement("section");
    target.id = "ijp-step-3";
    target.scrollIntoView = vi.fn();
    document.body.append(target);
    render(<StoryPanel mode="byo" />);
    fireEvent.click(screen.getByRole("button", { name: /Redeem it at our authorization server/ }));
    expect(target.scrollIntoView).toHaveBeenCalled();
    target.remove();
  });

  it("collapses and remembers it", () => {
    const { unmount } = render(<StoryPanel mode="byo" />);
    fireEvent.click(screen.getByRole("button", { name: "Hide talk track" }));
    expect(screen.queryByRole("group", { name: "Story path" })).toBeNull();
    unmount();
    render(<StoryPanel mode="byo" />);
    expect(within(screen.getByTestId("story-panel")).getByRole("button", { name: "Show talk track" })).toHaveAttribute("aria-expanded", "false");
  });
});
