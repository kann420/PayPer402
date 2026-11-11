/** Error copy for facilitator and route codes (design spec §8.6). */
export const ERROR_COPY: Record<string, string> = {
  nothing_to_settle: 'Nothing to charge right now.',
  settlement_in_progress: 'A PayPal charge is already running.',
  wallet_not_active: "Your PayPal link isn't active.",
  wallet_already_active: 'Your PayPal account is already linked.',
  settlement_failed: 'The final charge was declined, so your PayPal account stays linked. Try again later.',
  paypal_unavailable: "PayPal didn't answer. Try again in a moment.",
  too_many_claims: 'You have 5 unused codes. Use one or wait for them to expire.',
  seller_unavailable: "The seller console isn't available right now.",
};

/** The copy for an error code; other codes show the server's message. */
export function errorCopy(code: string, message: string): string {
  return Object.hasOwn(ERROR_COPY, code) ? (ERROR_COPY[code] as string) : message;
}

/**
 * The live run's default task (design spec §10.10). English, so the report is in English. It is
 * the same trip-research task as the agent package's `DEFAULT_TASK` (CLI and demo): the agent
 * searches, checks rates and reviews, and recommends one hotel.
 */
export const WEB_DEFAULT_TASK =
  'Find me a quiet hotel in Kyoto near Gion for cherry blossom season, March 30 to April 2, 2027, under $250 a night. Walking distance to Kiyomizu-dera is a plus.';
