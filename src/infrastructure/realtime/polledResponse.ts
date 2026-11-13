const validators = new WeakMap<
  Response,
  { accept: () => Promise<void>; reject: () => Promise<void> }
>();

export function registerPolledResponse(
  response: Response,
  hooks: { accept: () => Promise<void>; reject: () => Promise<void> },
): Response {
  validators.set(response, hooks);
  return response;
}
export async function acceptPolledResponse(response: Response | undefined): Promise<void> {
  if (response) await validators.get(response)?.accept();
}
export async function rejectPolledResponse(response: Response | undefined): Promise<void> {
  if (response) await validators.get(response)?.reject();
}
