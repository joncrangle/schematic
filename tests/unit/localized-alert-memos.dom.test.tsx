// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createMemo, createSignal } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { toServiceAlerts, toUpcomingClosures } from "~/domain/serviceAlerts";
import { areServiceAlertsEqual, areUpcomingClosuresEqual } from "~/lib/routeMemoComparators";
import { makeAlert } from "../helpers/fixtures";

afterEach(cleanup);

it("updates memoized alert copy and dates when a dictionary arrives after the feed", async () => {
  const updatedAt = Date.UTC(2026, 0, 2, 15, 30);
  const alert = makeAlert({ id: "incident", title: "Operator advisory", updatedAt });
  const planned = makeAlert({
    ...alert,
    id: "planned",
    lifecycle: "upcoming",
    startsAt: updatedAt,
  });
  function Harness() {
    const [french, setFrench] = createSignal(false);
    const presentation = () => ({
      locale: french() ? "fr-CA" : "en-CA",
      systemwide: french() ? "Tout le réseau" : "Systemwide",
      plannedWork: french() ? "Travaux prévus" : "Planned Work",
    });
    const alerts = createMemo(() => toServiceAlerts([alert], undefined, presentation()), {
      equals: areServiceAlertsEqual,
    });
    const closures = createMemo(() => toUpcomingClosures([planned], undefined, presentation()), {
      equals: areUpcomingClosuresEqual,
    });
    return (
      <>
        <button onClick={() => setFrench(true)}>Load French dictionary</button>
        <output>{alerts()[0]?.lineName}</output>
        <output>{closures()[0]?.lineName}</output>
        <output data-testid="alert-time">{alerts()[0]?.updatedAtLabel}</output>
        <output data-testid="planned-date">{closures()[0]?.dateRange}</output>
      </>
    );
  }
  render(() => <Harness />);
  expect(screen.getByText("Systemwide")).toBeDefined();
  const englishDate = screen.getByTestId("planned-date").textContent;
  await fireEvent.click(screen.getByRole("button", { name: "Load French dictionary" }));
  await waitFor(() => expect(screen.getByText("Tout le réseau")).toBeDefined());
  expect(screen.getByText("Travaux prévus")).toBeDefined();
  expect(screen.getByTestId("alert-time").textContent).toBe(
    new Intl.DateTimeFormat("fr-CA", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(updatedAt),
  );
  expect(screen.getByTestId("planned-date").textContent).not.toBe(englishDate);
});
