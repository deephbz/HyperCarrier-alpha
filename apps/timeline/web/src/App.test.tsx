import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";

afterEach(cleanup);

describe("dashboard controls", () => {
  it("renders the demo fleet and composes alive, field, and value filters", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole("heading", { name: "Pi session timeline" })).toBeTruthy();
    expect(screen.getByText("60 visible")).toBeTruthy();

    await user.click(screen.getByRole("checkbox", { name: "Alive only" }));
    expect(screen.getByText("10 visible")).toBeTruthy();

    await user.selectOptions(screen.getByRole("combobox", { name: "Filter sessions by" }), "state");
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter value" }), "Thinking");
    expect(screen.getByText("2 visible")).toBeTruthy();
  });

  it("opens coherent session details from an alias-first lane", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /timeline-lead, session demo-0/ }));
    expect(screen.getByRole("heading", { name: "timeline-lead" })).toBeTruthy();
    expect(screen.getByText("Session ID")).toBeTruthy();
    expect(screen.getAllByText("demo-0").length).toBeGreaterThan(0);
  });
});
