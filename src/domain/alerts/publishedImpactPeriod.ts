import type { GenericAlert } from "~/infrastructure/realtime/gtfsRealtimeDecoder";
import type { AlertPeriod } from "./periods";

const DAY = 86_400_000;

/** Publication age cannot bound explicitly stated service impacts. */
export function publishedImpactPeriod(
  alert: GenericAlert,
  timeZone: string,
): Required<AlertPeriod> | undefined {
  if (alert.impactPeriods?.length) return undefined;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(alert.updatedAt);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const reference = Date.UTC(part("year"), part("month") - 1, part("day"));
  const publishedParts = formatter.formatToParts(alert.startsAt ?? alert.updatedAt);
  const publishedPart = (type: Intl.DateTimeFormatPartTypes) =>
    Number(publishedParts.find((p) => p.type === type)?.value);
  const publicationReference = Date.UTC(
    publishedPart("year"),
    publishedPart("month") - 1,
    publishedPart("day"),
  );
  const titles = [
    alert.title,
    ...(alert.sourceTranslations ?? [])
      .filter((item) => item.field === "title")
      .map((item) => item.text),
  ];
  for (const title of titles) {
    const datedCancellation =
      /^((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+[A-Za-z]+\.?\s+\d{1,2}(?:,?\s+\d{4})?),\s+(?:there will be )?no (?:transit(?:\s+service)?|(?:(?:bus|train|rail)\s+)?service)\b/iu.exec(
        title,
      )?.[1];
    const cancellationPeriod = datedCancellation
      ? calendarCaption(datedCancellation, reference)
      : undefined;
    if (cancellationPeriod) return zonedPeriod(cancellationPeriod, timeZone);

    const prefix = title.includes(":") ? title.slice(0, title.indexOf(":")).trim() : undefined;
    const prefixPeriod =
      prefix && /\d\s*[-–—]\s*[A-Za-z]/u.test(prefix)
        ? calendarCaption(prefix, reference)
        : undefined;
    if (prefixPeriod) return zonedPeriod(prefixPeriod, timeZone);
    const separator = Math.max(title.lastIndexOf("|"), title.lastIndexOf(":"));
    const caption = separator >= 0 ? title.slice(separator + 1).trim() : undefined;
    const captionPeriod = caption ? calendarCaption(caption, reference) : undefined;
    if (captionPeriod) return zonedPeriod(captionPeriod, timeZone);
    let start: number | undefined;
    let end: number | undefined;
    if (/^(?:this weekend\b|ce week-end\b)/i.test(title)) {
      const weekday = new Date(reference).getUTCDay();
      start = reference + (weekday === 0 ? -1 : 6 - weekday) * DAY;
      end = start + 2 * DAY;
    } else {
      const match =
        /^(?:([\p{L}]+)\.?\s+(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?|(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s+([\p{L}]+)\.?)(?:,?\s+(\d{4}))?\s*:/u.exec(
          title,
        );
      if (!match) continue;
      const monthText = (match[1] ?? match[6]).toLocaleLowerCase();
      const month = monthIndex(monthText);
      if (month === undefined) continue;
      const firstDay = Number(match[2] ?? match[4]);
      const lastDay = Number(match[3] ?? match[5] ?? firstDay);
      const year = match[7] ? Number(match[7]) : part("year");
      const years = match[7] ? [year] : [year - 1, year, year + 1];
      start = years
        .map((y) => Date.UTC(y, month, firstDay))
        .sort((a, b) => Math.abs(a - reference) - Math.abs(b - reference))[0];
      const date = new Date(start);
      if (date.getUTCMonth() !== month || date.getUTCDate() !== firstDay || lastDay < firstDay)
        continue;
      const last = new Date(Date.UTC(date.getUTCFullYear(), month, lastDay));
      if (last.getUTCMonth() !== month || last.getUTCDate() !== lastDay) continue;
      end = last.getTime() + DAY;
    }
    return { startsAt: midnightInZone(start, timeZone), endsAt: midnightInZone(end, timeZone) };
  }
  if (/\b(?:affected services|service impacts|holiday)\b/iu.test(alert.title)) {
    const occurrence =
      /\bwhich occurs on\s+((?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?[A-Za-z]+\.?\s+\d{1,2}(?:,?\s+\d{4})?)/iu.exec(
        alert.description ?? "",
      )?.[1];
    const period = occurrence ? calendarCaption(occurrence, reference) : undefined;
    if (period) return zonedPeriod(period, timeZone);
  }
  if (/\b(?:holiday|remembrance day)\b/iu.test(alert.title) && /\bservice\b/iu.test(alert.title)) {
    const occurrence =
      /\bon\s+(?:[A-Za-z'’-]+\s+Day\s*[-–—]\s*)?((?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?[A-Za-z]+\.?\s+\d{1,2}(?:,?\s+\d{4})?)/iu.exec(
        alert.description ?? "",
      )?.[1];
    const period = occurrence ? calendarCaption(occurrence, publicationReference) : undefined;
    if (period) return zonedPeriod(period, timeZone);
  }
  if (/jour du souvenir/iu.test(alert.title)) {
    const occurrence = /\ble\s+(\d{1,2})\s+([\p{L}]+)(?:\s+(\d{4}))?/iu.exec(
      alert.description ?? "",
    );
    const period = occurrence
      ? calendarCaption(
          `${occurrence[2]} ${occurrence[1]}${occurrence[3] ? ", " + occurrence[3] : ""}`,
          publicationReference,
        )
      : undefined;
    if (period) return zonedPeriod(period, timeZone);
  }
  const serviceOccurrence =
    /\b(?:transit detour|service detour|service cancellation|cancelled|canceled|suspended)\s+on\s+((?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?[A-Za-z]+\.?\s+\d{1,2}(?:,?\s+\d{4})?)/iu.exec(
      alert.description ?? "",
    )?.[1];
  const servicePeriod = serviceOccurrence
    ? calendarCaption(serviceOccurrence, reference)
    : undefined;
  if (servicePeriod) return zonedPeriod(servicePeriod, timeZone);
  const noServiceOccurrence =
    /\b(?:no\s+(?:[\p{L}'’-]+\s+){0,6}service|not\s+(?:be\s+)?(?:running|operating))\s+on\s+(?:[\p{L}'’-]+,?\s+){0,4}?([A-Za-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)\b(?!\s*(?:and|or|[-–]))/iu.exec(
      alert.description ?? "",
    )?.[1];
  const noServicePeriod = noServiceOccurrence
    ? calendarCaption(noServiceOccurrence.replace(/(\d{1,2})(?:st|nd|rd|th)\b/giu, "$1"), reference)
    : undefined;
  if (noServicePeriod) return zonedPeriod(noServicePeriod, timeZone);
  return undefined;
}

/** Only an entire date caption supplies boundaries, so surrounding prose cannot extend them. */
function calendarCaption(
  text: string,
  reference: number,
): { startsAt: number; endsAt: number } | undefined {
  const match =
    /^(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?([A-Za-z]+)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:\s*[-–—]\s*(?:([A-Za-z]+)\.?\s+)?(\d{1,2})(?:,?\s+(\d{4}))?)?$/iu.exec(
      text,
    );
  if (!match) return undefined;
  const firstMonth = monthIndex(match[1].toLowerCase());
  const lastMonth = match[4] ? monthIndex(match[4].toLowerCase()) : firstMonth;
  if (firstMonth === undefined || lastMonth === undefined) return undefined;
  const firstDay = Number(match[2]);
  const lastDay = Number(match[5] ?? firstDay);
  const crossesYear = lastMonth < firstMonth;
  const referenceYear = new Date(reference).getUTCFullYear();
  const nearestYear = [referenceYear - 1, referenceYear, referenceYear + 1].sort(
    (a, b) =>
      Math.abs(Date.UTC(a, firstMonth, firstDay) - reference) -
      Math.abs(Date.UTC(b, firstMonth, firstDay) - reference),
  )[0];
  const firstYear = match[3]
    ? Number(match[3])
    : match[6]
      ? Number(match[6]) - Number(crossesYear)
      : nearestYear;
  const lastYear = match[6] ? Number(match[6]) : firstYear + Number(crossesYear);
  const start = Date.UTC(firstYear, firstMonth, firstDay);
  const last = Date.UTC(lastYear, lastMonth, lastDay);
  if (
    new Date(start).getUTCMonth() !== firstMonth ||
    new Date(start).getUTCDate() !== firstDay ||
    new Date(last).getUTCMonth() !== lastMonth ||
    new Date(last).getUTCDate() !== lastDay ||
    last < start
  )
    throw new Error("Invalid published impact period");
  return { startsAt: start, endsAt: last + DAY };
}

function zonedPeriod(period: Required<AlertPeriod>, timeZone: string): Required<AlertPeriod> {
  return {
    startsAt: midnightInZone(period.startsAt, timeZone),
    endsAt: midnightInZone(period.endsAt, timeZone),
  };
}

function monthIndex(text: string): number | undefined {
  for (let month = 0; month < 12; month++) {
    for (const locale of ["en", "fr"]) {
      for (const width of ["short", "long"] as const) {
        const name = new Intl.DateTimeFormat(locale, { month: width, timeZone: "UTC" })
          .format(Date.UTC(2024, month, 1))
          .toLocaleLowerCase()
          .replace(/\.$/, "");
        if (name === text) return month;
      }
    }
  }
  return undefined;
}

/** Convert a calendar date to local midnight, including DST offset changes. */
function midnightInZone(calendar: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let instant = calendar;
  for (let i = 0; i < 3; i++) {
    const parts = formatter.formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((p) => p.type === type)?.value);
    const local = Date.UTC(
      part("year"),
      part("month") - 1,
      part("day"),
      part("hour"),
      part("minute"),
      part("second"),
    );
    instant += calendar - local;
  }
  return instant;
}

/** Separate dated cancellation paragraphs so another event cannot widen their service window. */
export function splitPublishedCancellations(
  alert: GenericAlert,
  timeZone: string,
): readonly GenericAlert[] {
  if (alert.activePeriods?.length || alert.impactPeriods?.length || alert.endsAt !== undefined)
    return [alert];
  const lines =
    alert.description
      ?.split("\n")
      .map((line) => line.trim())
      .filter(Boolean) ?? [];
  if (lines.length < 2) return [alert];
  const referenceParts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(alert.updatedAt);
  const part = (name: Intl.DateTimeFormatPartTypes) =>
    Number(referenceParts.find((entry) => entry.type === name)?.value);
  const reference = Date.UTC(part("year"), part("month") - 1, part("day"));
  const children: GenericAlert[] = [];
  const remaining: string[] = [];
  for (const line of lines) {
    const dateText =
      /^(?:There will be )?no (?:transit|bus service|service) on ((?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?[A-Za-z]+\.?\s+\d{1,2}(?:,?\s+\d{4})?(?:\s*[-–]\s*(?:[A-Za-z]+\s+)?\d{1,2}(?:,?\s+\d{4})?)?)(?:\s*[-–]\s*[^\d.]+)?\.?$/iu.exec(
        line,
      )?.[1];
    const calendar = dateText ? calendarCaption(dateText, reference) : undefined;
    if (!calendar) {
      remaining.push(line);
      continue;
    }
    const period = zonedPeriod(calendar, timeZone);
    children.push({
      ...alert,
      id: `${alert.id}#cancellation-${new Date(calendar.startsAt).toISOString().slice(0, 10)}`,
      title: line,
      description: line,
      effect: undefined,
      startsAt: period.startsAt,
      endsAt: period.endsAt,
      activePeriods: [period],
      impactPeriods: [period],
    });
  }
  if (children.length === 0) return [alert];
  return [
    ...(remaining.length ? [{ ...alert, description: remaining.join("\n") }] : []),
    ...children,
  ];
}
