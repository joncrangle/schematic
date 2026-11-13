import { createSignal, untrack, type Accessor } from "solid-js";

/**
 * Controlled/uncontrolled duality: a component prop optionally owns the
 * value; without it, an internal signal serves. Reads prefer the prop whenever
 * it is defined, including an explicit `null`, which NearbyPanel's nullable
 * expandedRouteId relies on, writes always land on the internal signal, so
 * clearing the prop (to undefined) hands back exactly what was written.
 */
export function createControllableSignal<T>(
  value: (() => T | undefined) | undefined,
  fallback: Accessor<T>,
): [Accessor<T>, (next: Exclude<T, Function> | ((prev: T) => T)) => void] {
  // One-time seed: component setup is not a tracking scope, so read the
  // fallback without subscribing. The prop path in read() below stays fully
  // reactive. The internal signal accepts writes from owned scopes
  // (setup-time seeding).
  const [internal, setInternal] = createSignal<T>(untrack(fallback) as Exclude<T, Function>, {
    ownedWrite: true,
  });
  const read = () => {
    const propValue = value?.();
    return propValue !== undefined ? propValue : internal();
  };
  return [read, setInternal];
}
