import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { App } from "./App";

afterEach(cleanup);
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
  );
});

/**
 * Consumer acceptance gate for the immutable first-round report contract.
 * A matrix can be the default Wall-clock renderer, but it cannot replace the
 * ordinal, aggregate, provenance, or live-invalidation consumer surfaces.
 */
it("retains original report projections and live revision invalidation", () => {
  render(<App initialSource="fixture" />);

  expect(screen.getByRole("heading", { name: "Agent-turns viz" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Wall-clock plot" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Ordinal events" })).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Aggregational stats" }),
  ).toBeTruthy();
  expect(screen.getByText("Exact usage")).toBeTruthy();
  expect(screen.getByText("Tool activity")).toBeTruthy();
  expect(screen.getByText("Event inventory")).toBeTruthy();
  expect(screen.getByText(/Cumulative input tokens/i)).toBeTruthy();
  expect(screen.getByText(/Cumulative estimated dollars/i)).toBeTruthy();
  expect(screen.getByText(/Concurrency rail/i)).toBeTruthy();
});

it("subscribes to server revision invalidation for the live source", () => {
  const EventSourceMock = vi.fn(function () {
    return { addEventListener: vi.fn(), close: vi.fn() };
  });
  vi.stubGlobal("EventSource", EventSourceMock);
  render(<App initialSource="live" />);
  expect(EventSourceMock).toHaveBeenCalledWith("/api/events");
});

it("does not briefly subscribe to unscoped revisions while resolving a Team", () => {
  window.history.replaceState({}, "", "/?team=piteams%3Ateam-a");
  const EventSourceMock = vi.fn(function () {
    return { addEventListener: vi.fn(), close: vi.fn() };
  });
  vi.stubGlobal("EventSource", EventSourceMock);
  render(<App initialSource="live" />);
  expect(EventSourceMock).not.toHaveBeenCalled();
});
