/**
 * The browser token handoff instructions (AC-12.2), in one place.
 *
 * Shown by `auth login` and `auth status`, and by any command whose stored token stops working
 * (AC-12.11). The token handoff is the only mechanism the target application supports (ADR 0004
 * Decision 4), so these never mention a password or API key.
 */

/**
 * The login command for a target, spelled the way the user named it: by instance when they used one,
 * so the hint can be pasted back as-is rather than with a URL they never typed.
 */
export function loginCommand(url?: string, instance?: string): string {
  return instance !== undefined ? `signum -i ${instance} auth login` : `signum auth login --url ${url ?? "<url>"}`;
}

export function handoffInstructions(url?: string, instance?: string): string {
  const login = loginCommand(url, instance);
  return [
    "To obtain a token:",
    "  1. Sign in to the web application in your browser.",
    '  2. Open the browser console and run:  sessionStorage.getItem("authToken")',
    "  3. Pipe the value in:",
    `       ${login} < token.txt`,
    `       printf %s "$TOKEN" | ${login}`,
  ].join("\n");
}
