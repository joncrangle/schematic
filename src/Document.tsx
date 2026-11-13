import type { ParentProps } from "solid-js";
import { HydrationScript } from "@solidjs/web";
import { DEFAULT_UI_LOCALE, SUPPORTED_UI_LOCALES } from "~/domain/locale";
import styleCss from "./styles.css?url";

export default function Document(props: ParentProps) {
  const defaultDirection = SUPPORTED_UI_LOCALES.find(
    ({ tag }) => tag === DEFAULT_UI_LOCALE,
  )!.direction;
  return (
    <html lang={DEFAULT_UI_LOCALE} dir={defaultDirection}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#202020" />
        <link rel="stylesheet" href={styleCss} />

        {/* Favicons & Fallbacks */}
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
        {/* iOS & PWA Manifest */}
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
        <title>Schematic</title>
        <HydrationScript />
      </head>
      <body>{props.children}</body>
    </html>
  );
}
