import { render, screen } from "@testing-library/react";
import GuidesPage from "../GuidesPage";

describe("Setup guides page", () => {
  it("has the five guides, each linked from the contents", () => {
    render(<GuidesPage />);
    for (const [name, id] of [
      ["PingFederate as the ID-JAG issuer", "pf-issuer"],
      ["PingFederate as the redeemer", "pf-redeemer"],
      ["Okta Cross App Access", "okta"],
      ["Any other IdP: the ID-JAG checklist", "generic"],
      ["Use xaa.dev (IdenX) as a free outside IdP", "xaa"],
    ]) {
      expect(screen.getByRole("heading", { level: 2, name })).toHaveAttribute("id", id);
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", `#${id}`);
    }
    expect(screen.getByText(/Publish Keys to the PingFederate JWKS Endpoint/)).toBeInTheDocument();
    expect(screen.getAllByText(/oauth-id-jag\+jwt/).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "https://xaa.dev/developer/test-resource" })).toHaveAttribute("target", "_blank");
  });
});
