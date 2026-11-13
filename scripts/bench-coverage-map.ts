#!/usr/bin/env bun
/**
 * Measure coverage map frame cost on a phone-sized viewport.
 *
 * Builds the production overlay with the full agency catalog, then drives
 * scripted touch pans and pinches with service areas on and off:
 *
 * - Chromium, 4x CPU throttle, software raster: an Android proxy. Read main
 *   thread task/style/paint and raster milliseconds per gesture.
 * - WebKit: an iPhone proxy. Read the average frame and frames over 40 ms.
 *   Raise `--dpr` (for example 5) to expose paint costs at 60 fps.
 *
 * Compare runs on the base branch and the change; absolute numbers depend on
 * the machine.
 *
 * Usage:
 *   bunx playwright-core install chromium webkit   # once
 *   bun run bench:coverage [--runs=3] [--dpr=3] [--engines=chromium,webkit]
 */
import { resolve } from "node:path";
import { build, preview } from "vite";
import { chromium, webkit, type Browser, type BrowserContext, type Page } from "playwright-core";
import {
  COVERAGE_BOUNDARIES,
  COVERAGE_GEOGRAPHY,
} from "../src/components/network-coverage/coverageModel";
import type { CoverageGeography } from "../src/components/network-coverage/generated/geography";

type Engine = "chromium" | "webkit";
type Gesture = "pan" | "pinchIn" | "panZoomed" | "pinchOut";
type Metrics = Readonly<Record<string, number>>;

const GESTURES: readonly Gesture[] = ["pan", "pinchIn", "panZoomed", "pinchOut"];
const VIEWPORT = { width: 390, height: 844 };
const CENTER = { x: 195, y: 450 };
const configFile = resolve(import.meta.dirname, "coverage-bench/vite.config.ts");

function option(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const runs = Number(option("runs", "3"));
const dpr = Number(option("dpr", "3"));
const engines = option("engines", "chromium,webkit").split(",") as Engine[];

/** Touch points for one gesture at progress `t` in [0, 1]. */
function touchPoints(gesture: Gesture, t: number): { x: number; y: number }[] {
  const { x, y } = CENTER;
  switch (gesture) {
    case "pan":
      return [{ x: x - 120 * Math.sin(t * Math.PI * 2), y: y + 80 * t }];
    case "panZoomed":
      return [{ x: x + 120 * Math.sin(t * Math.PI * 2), y: y - 80 * t }];
    case "pinchIn":
      return [
        { x: x - 40 - 50 * t, y: y - 40 - 50 * t },
        { x: x + 40 + 50 * t, y: y + 40 + 50 * t },
      ];
    case "pinchOut":
      return [
        { x: x - 90 + 50 * t, y: y - 90 + 50 * t },
        { x: x + 90 - 50 * t, y: y + 90 - 50 * t },
      ];
  }
}

async function openMap(
  browser: Browser,
  url: string,
  showCoverage: boolean,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: dpr,
    isMobile: browser.browserType().name() === "chromium",
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(
    () => window.coverageBenchReady && document.querySelector('button[role="switch"]'),
  );
  await page.waitForTimeout(800);
  if (!showCoverage) {
    await page.evaluate(() =>
      document.querySelector<HTMLButtonElement>('button[role="switch"]')?.click(),
    );
  }
  await page.waitForTimeout(300);
  return { context, page };
}

/** Real touch input through CDP; frame timing, main-thread metrics, and raster from a trace. */
async function measureChromium(browser: Browser, url: string, showCoverage: boolean) {
  const { context, page } = await openMap(browser, url, showCoverage);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const readMetrics = async () =>
    Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map((metric) => [
        metric.name,
        metric.value,
      ]),
    );
  const results: Partial<Record<Gesture, Metrics>> = {};
  for (const gesture of GESTURES) {
    await browser.startTracing(page, {
      categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "cc"],
    });
    await page.evaluate(() => {
      const state = window as Window & { benchFrames?: number[]; benchMeasuring?: boolean };
      state.benchFrames = [];
      state.benchMeasuring = true;
      let last = 0;
      const loop = (time: number) => {
        if (last) state.benchFrames?.push(time - last);
        last = time;
        if (state.benchMeasuring) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    const before = await readMetrics();
    const point = (t: number) =>
      touchPoints(gesture, t).map((touch, index) => ({ ...touch, id: index + 1 }));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(0) });
    for (let step = 1; step <= 40; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: point(step / 40),
      });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(250);
    const after = await readMetrics();
    const frames = await page.evaluate(() => {
      const state = window as Window & { benchFrames?: number[]; benchMeasuring?: boolean };
      state.benchMeasuring = false;
      return state.benchFrames ?? [];
    });
    const trace = JSON.parse((await browser.stopTracing()).toString()) as {
      traceEvents: { name: string; ph: string; dur?: number }[];
    };
    const traced = (name: string) =>
      trace.traceEvents
        .filter((event) => event.name === name && event.ph === "X")
        .reduce((total, event) => total + (event.dur ?? 0), 0) / 1000;
    const delta = (name: string) => (after[name] - before[name]) * 1000;
    results[gesture] = {
      fps: frames.length / (frames.reduce((total, frame) => total + frame, 0) / 1000),
      taskMs: delta("TaskDuration"),
      scriptMs: delta("ScriptDuration"),
      styleMs: delta("RecalcStyleDuration"),
      paintMs: traced("Paint"),
      rasterMs: traced("RasterTask"),
    };
  }
  await context.close();
  return results as Record<Gesture, Metrics>;
}

/** Synthetic touch pointer events, one per animation frame, timed in the page. */
async function measureWebKit(browser: Browser, url: string, showCoverage: boolean) {
  const { context, page } = await openMap(browser, url, showCoverage);
  const results: Partial<Record<Gesture, Metrics>> = {};
  for (const gesture of GESTURES) {
    const steps = Array.from({ length: 61 }, (_, step) => touchPoints(gesture, step / 60));
    results[gesture] = await page.evaluate(async (steps) => {
      const target = document.querySelector("svg[viewBox]")!.parentElement!;
      const frame = () => new Promise<number>((done) => requestAnimationFrame(done));
      const fire = (type: string, points: { x: number; y: number }[]) => {
        points.forEach((point, index) =>
          target.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerId: index + 1,
              pointerType: "touch",
              isPrimary: index === 0,
              clientX: point.x,
              clientY: point.y,
              buttons: type === "pointerup" ? 0 : 1,
            }),
          ),
        );
      };
      await frame();
      fire("pointerdown", steps[0]);
      const intervals: number[] = [];
      let last = await frame();
      for (const points of steps.slice(1)) {
        fire("pointermove", points);
        const now = await frame();
        intervals.push(now - last);
        last = now;
      }
      fire("pointerup", steps[steps.length - 1]);
      await frame();
      return {
        avgFrameMs: intervals.reduce((total, interval) => total + interval, 0) / intervals.length,
        framesOver40Ms: intervals.filter((interval) => interval > 40).length,
      };
    }, steps);
  }
  await context.close();
  return results as Record<Gesture, Metrics>;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function pointCount(geography: CoverageGeography): number {
  return geography.polygons.reduce(
    (total, polygon) =>
      total +
      polygon.outer.length +
      (polygon.holes ?? []).reduce((sum, hole) => sum + hole.length, 0),
    0,
  );
}

console.log(
  `Geometry: land ${COVERAGE_GEOGRAPHY.polygons.length} polygons / ${pointCount(COVERAGE_GEOGRAPHY)} points; ` +
    `borders ${COVERAGE_BOUNDARIES.length} regions / ${COVERAGE_BOUNDARIES.reduce((total, region) => total + pointCount(region), 0)} points`,
);
await build({ configFile });
const server = await preview({ configFile, preview: { port: 0, host: "127.0.0.1" } });
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error("Coverage benchmark preview server did not start.");

try {
  for (const engine of engines) {
    const browser =
      engine === "chromium"
        ? await chromium.launch({ args: ["--disable-gpu", "--disable-gpu-rasterization"] })
        : await webkit.launch();
    const measure = engine === "chromium" ? measureChromium : measureWebKit;
    for (const showCoverage of [true, false]) {
      const samples: Record<Gesture, Metrics>[] = [];
      for (let run = 0; run < runs; run += 1)
        samples.push(await measure(browser, url, showCoverage));
      console.log(
        `\n${engine} @${dpr}x, service areas ${showCoverage ? "on" : "off"} (median of ${runs})`,
      );
      for (const gesture of GESTURES) {
        const names = Object.keys(samples[0][gesture]);
        const cells = names.map(
          (name) => `${name} ${median(samples.map((sample) => sample[gesture][name])).toFixed(1)}`,
        );
        console.log(`  ${gesture.padEnd(10)} ${cells.join("  ")}`);
      }
    }
    await browser.close();
  }
} finally {
  await new Promise<void>((done) => server.httpServer.close(() => done()));
}
