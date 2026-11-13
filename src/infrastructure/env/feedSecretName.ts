/** Feed credentials use a dedicated namespace so manifests cannot name app secrets. */
export const FEED_SECRET_NAME_PATTERN = /^FEED_[A-Z0-9]+(?:_[A-Z0-9]+)*$/u;

export function isFeedSecretName(name: string): boolean {
  return FEED_SECRET_NAME_PATTERN.test(name);
}
