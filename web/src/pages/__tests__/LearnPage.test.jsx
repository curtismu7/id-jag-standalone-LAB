import { fireEvent, render, screen, within } from "@testing-library/react";
import LearnPage from "../LearnPage";
import sources from "../../data/sources.json";

const open = (url) => {
  window.history.pushState({}, "", url);
  return render(<LearnPage />);
};
afterEach(() => window.history.pushState({}, "", "/"));
const selected = () => screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true").textContent;

describe("Learn page", () => {
  it("points to the Inspector", () => {
    open("/learn");
    expect(screen.getByRole("link", { name: "Inspector" })).toHaveAttribute("href", "/inspect");
  });

  it("searches the glossary", () => {
    open("/learn#glossary");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search terms" }), { target: { value: "jti" } });
    expect(screen.getByText("jti replay protection")).toBeInTheDocument();
    expect(screen.queryByText("CIMD")).not.toBeInTheDocument();
  });

  it("filters the library by kind", () => {
    open("/learn#library");
    fireEvent.click(screen.getByRole("button", { name: "Client" }));
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(sources.filter((s) => s.kind === "Client").length);
    expect(screen.getByRole("link", { name: "apify/mcpc" })).toHaveAttribute("target", "_blank");
  });

  it("opens the glossary at a term from the hash", () => {
    open("/learn#term-dpop");
    expect(selected()).toBe("Glossary");
    expect(document.getElementById("term-dpop")).not.toBeNull();
  });

  it("survives an unknown term in the hash", () => {
    open("/learn#term-nope");
    expect(selected()).toBe("Glossary");
    expect(screen.getByText("ID-JAG")).toBeInTheDocument();
  });

  it("indexes the in-app docs", () => {
    open("/learn");
    expect(selected()).toBe("Docs");
    expect(screen.getByRole("link", { name: "Use mcpc or VS Code as the client" })).toHaveAttribute("href", "/guides#desktop");
    expect(screen.getByRole("link", { name: "PingFederate → resource AS diagram" })).toHaveAttribute("href", "/diagram/pf-as");
  });
});
