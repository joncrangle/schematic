import { createContext, useContext, type ParentProps } from "solid-js";
import type { AgencySession } from "~/services/session/AgencySession";

const AgencySessionContext = createContext<AgencySession | null>(null);

export function AgencySessionProvider(props: ParentProps<{ session: AgencySession }>) {
  return <AgencySessionContext value={props.session}>{props.children}</AgencySessionContext>;
}

export function useAgencySession(): AgencySession {
  const ctx = useContext(AgencySessionContext);
  if (!ctx) {
    throw new Error("useAgencySession must be used within an AgencySessionProvider");
  }
  return ctx;
}
