/**
 * The browser token handoff instructions (AC-12.2), in one place.
 *
 * Shown by `auth login` and `auth status`, and by any command whose stored token stops working
 * (AC-12.11). The token handoff is the only mechanism the target application supports (ADR 0004
 * Decision 4), so these never mention a password or API key.
 */

export function handoffInstructions(url?: string): string {
  const target = url ?? "<url>";
  return [
    "To obtain a token:",
    "  1. Sign in to the web application in your browser.",
    '  2. Open the browser console and run:  sessionStorage.getItem("authToken")',
    "  3. Pipe the value in:",
    `       signum auth login --url ${target} < token.txt`,
    `       printf %s "$TOKEN" | signum auth login --url ${target}`,
  ].join("\n");
}
