/// <reference types="vite/client" />
/// <reference types="@solidjs/vite-plugin/boundary-modules" />
import "./jsonc.d.ts";

import type { D1DatabaseBinding } from "~/infrastructure/storage/RuntimeBindings";

declare global {
  type RuntimeEnvironmentValue = D1DatabaseBinding | string | undefined;

  var env:
    | (Record<string, RuntimeEnvironmentValue> & {
        // Dedicated notifications DB, not an agency, global push storage.
        readonly DB_NOTIFICATIONS?: D1DatabaseBinding;
        // Consolidated static transit topology DB (ADR-0009).
        readonly DB_TRANSIT?: D1DatabaseBinding;
        readonly VAPID_PUBLIC_KEY?: string;
        readonly VAPID_PRIVATE_KEY?: string;
        readonly VAPID_SUBJECT?: string;
        readonly PUSH_ENDPOINT_HOSTS?: string;
      })
    | undefined;
  var Bun: unknown | undefined;
}

export {};
