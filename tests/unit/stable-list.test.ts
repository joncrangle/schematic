import { describe, expect, it } from "vitest";
import { stableList } from "~/lib/stableList";
import { keyListById } from "~/lib/keyedList";

interface Row {
  id: string;
  meters: number;
}

const options = {
  getKey: (r: Row) => r.id,
  isEqual: (a: Row, b: Row) => a.meters === b.meters,
};

describe("stableList (identity-preserving reconciler for <For>)", () => {
  it("keeps the previous object for equal items and adopts the fresh payload for changed ones", () => {
    const tickA: Row[] = [
      { id: "52", meters: 120 },
      { id: "300", meters: 1400 },
    ];
    const first = stableList(tickA, new Map(), options);

    const tickB: Row[] = [
      { id: "52", meters: 120 },
      { id: "300", meters: 1450 },
    ];
    const second = stableList(tickB, first.byKey, options);

    expect(second.items[0]).toBe(first.items[0]);
    expect(second.items[1]).not.toBe(first.items[1]);
    expect(second.items[1]).toBe(tickB[1]);
  });

  it("evicts keys that disappeared from the current list", () => {
    const first = stableList<Row>(
      [
        { id: "52", meters: 120 },
        { id: "300", meters: 1400 },
      ],
      new Map(),
      options,
    );
    expect(first.byKey.has("300")).toBe(true);

    const second = stableList([{ id: "52", meters: 125 }], first.byKey, options);

    expect(second.byKey.has("300")).toBe(false);
    expect(second.byKey.get("52")).toBe(second.items[0]);
  });

  it("yields an empty byKey for empty input", () => {
    const previous = stableList<Row>([{ id: "52", meters: 120 }], new Map(), options).byKey;

    const emptied = stableList([], previous, options);

    expect(emptied.items).toEqual([]);
    expect(emptied.byKey.size).toBe(0);
  });

  it("stabilizes every duplicate occurrence against the same previous entry while byKey keeps the last", () => {
    const previousEntry: Row = { id: "x", meters: 1 };
    const duplicated: Row[] = [
      { id: "x", meters: 1 },
      { id: "x", meters: 2 },
    ];

    const result = stableList(duplicated, new Map([["x", previousEntry]]), options);

    expect(result.items[0]).toBe(previousEntry);
    expect(result.items[1]).toBe(duplicated[1]);
    expect(result.byKey.get("x")).toBe(duplicated[1]);
  });

  it("preserves input order regardless of stabilization outcomes", () => {
    const previous = stableList<Row>(
      [
        { id: "a", meters: 3 },
        { id: "b", meters: 1 },
        { id: "c", meters: 2 },
      ],
      new Map(),
      options,
    ).byKey;

    const renewed: Row[] = [
      { id: "c", meters: 9 },
      { id: "a", meters: 3 },
      { id: "b", meters: 1 },
    ];
    const result = stableList(renewed, previous, options);

    expect(result.items.map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(result.items[1]).toBe(previous.get("a"));
    expect(result.items[2]).toBe(previous.get("b"));
  });
});

describe("keyListById (stable-identity keying for <For> patching)", () => {
  it("extracts keys in first-appearance order", () => {
    const vehicles = [
      { vehicleId: "4412", lat: 1 },
      { vehicleId: "4408", lat: 2 },
      { vehicleId: "4415", lat: 3 },
    ];

    const keyed = keyListById(vehicles, (v) => v.vehicleId);

    expect(keyed.ids).toEqual(["4412", "4408", "4415"]);
    expect(keyed.byId.get("4408")).toBe(vehicles[1]);
  });

  it("keeps the LAST occurrence for duplicate keys (feed resend supersedes)", () => {
    const vehicles = [
      { vehicleId: "4412", lat: 1 },
      { vehicleId: "4412", lat: 99 },
      { vehicleId: "4408", lat: 2 },
    ];

    const keyed = keyListById(vehicles, (v) => v.vehicleId);

    expect(keyed.ids).toEqual(["4412", "4408"]);
    expect(keyed.byId.get("4412")).toEqual({ vehicleId: "4412", lat: 99 });
    expect(keyed.byId.size).toBe(2);
  });

  it("handles empty lists", () => {
    const keyed = keyListById([], (v: { id: string }) => v.id);
    expect(keyed.ids).toEqual([]);
    expect(keyed.byId.size).toBe(0);
  });

  it("produces primitive ids so unchanged entries stay referentially stable across renewals", () => {
    const tickA = [
      { vehicleId: "4412", lat: 1 },
      { vehicleId: "4408", lat: 2 },
    ];
    const tickB = [
      { vehicleId: "4412", lat: 1.5 },
      { vehicleId: "4408", lat: 2.5 },
      { vehicleId: "4420", lat: 3 },
    ];

    const idsA = keyListById(tickA, (v) => v.vehicleId).ids;
    const keyedB = keyListById(tickB, (v) => v.vehicleId).ids;

    expect(idsA[0] === keyedB[0]).toBe(true);
    expect(idsA[1] === keyedB[1]).toBe(true);
    expect(keyedB).toEqual(["4412", "4408", "4420"]);
  });
});
