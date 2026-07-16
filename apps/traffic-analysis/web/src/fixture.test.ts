import { describe, expect, it } from "vitest";
import { fixtureInspector, matrixFixture, ordinalFixture } from "./fixture";

describe("retained matrix fixture", () => {
  it("retains deterministic projection and uses live-equivalent snapshot/event scope", () => {
    const mark = matrixFixture.marks[0]!;
    expect(matrixFixture.snapshot.inspectorAvailability).toEqual({
      scope: "retained_checked_in_fixture",
      staleReason: null,
    });
    expect(
      fixtureInspector(matrixFixture.snapshot.id, mark.eventRef),
    ).toMatchObject({
      snapshotId: matrixFixture.snapshot.id,
      eventRef: mark.eventRef,
      preparedDerivationId: matrixFixture.snapshot.preparedDerivationId,
    });
    expect(fixtureInspector("another-snapshot", mark.eventRef)).toBeNull();
    expect(fixtureInspector(matrixFixture.snapshot.id, "missing")).toBeNull();
  });
});

it("keeps the retained ordinal fixture as a skeleton without time or disclosure bodies", () => {
  expect(ordinalFixture.schemaVersion).toBe("traffic-ordinal-v2");
  expect(ordinalFixture.rows.every((row) => row.cells.length === 1)).toBe(true);
  expect(JSON.stringify(ordinalFixture)).not.toMatch(
    /startMs|endMs|disclosure":/,
  );
});
