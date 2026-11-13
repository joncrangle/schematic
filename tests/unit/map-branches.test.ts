import { expect, it } from "vitest";
import { sequenceBetween } from "~/domain/map/stationSequence";
import { polylineSpanPoints } from "~/domain/map/MapGeometry";

it("finds the station path through a junction without visiting a different terminus", () => {
  expect(sequenceBetween([["central", "junction", "south"], ["junction", "east", "airport"]], "central", "airport"))
    .toEqual(["central", "junction", "east", "airport"]);
});

it("takes the shortest coherent geometry when a drawn branch retraces its junction", () => {
  const junction = { x: 0, y: 0 };
  const south = { x: 0, y: 100 };
  const east = { x: 100, y: 0 };
  expect(polylineSpanPoints([junction, south, junction, east], [junction, east], true))
    .toEqual([junction, east]);
});

it("does not visit the other terminus when a span starts before the branch junction", () => {
  const origin = { x: -100, y: 0 };
  const junction = { x: 0, y: 0 };
  const otherTerminus = { x: 0, y: 100 };
  const branchTerminus = { x: 100, y: 0 };
  expect(polylineSpanPoints([origin, junction, otherTerminus, junction, branchTerminus], [origin, junction, branchTerminus], true))
    .toEqual([origin, junction, branchTerminus]);
});

it("preserves traversal direction through an ordinary circuit", () => {
  const origin = { x: 0, y: 0 };
  const first = { x: 10, y: 0 };
  const outbound = { x: 20, y: 20 };
  const farCorner = { x: 20, y: 30 };
  const last = { x: 0, y: 10 };
  expect(polylineSpanPoints([origin, first, outbound, farCorner, last, origin], [origin, first, last]))
    .toEqual([origin, first, outbound, farCorner, last]);
});

it("uses declared station order instead of crossing a circuit's closing edge", () => {
  expect(sequenceBetween([["origin", "first", "corner", "last", "origin"]], "first", "last"))
    .toEqual(["first", "corner", "last"]);
});
