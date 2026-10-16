import { Router, type Response } from 'express';
import { handler } from '../http';
import { errorMessage } from '../logger';
import type { ServiceContext } from '../services/context';
import type { WalletService } from '../services/wallets';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Sends the browser on after linking: a 302 to `${WEB_APP_URL}/link/complete?status=…`, or a
 * minimal page when `WEB_APP_URL` is unset.
 */
function finishRedirect(ctx: ServiceContext, res: Response, status: string): void {
  if (ctx.config.webAppUrl) {
    res.redirect(302, `${ctx.config.webAppUrl}/link/complete?status=${encodeURIComponent(status)}`);
    return;
  }
  const text =
    status === 'active'
      ? 'Your PayPal account is linked. You can close this window.'
      : status === 'waiting_for_approval'
        ? 'Linking is still in progress. Return to PayPer402 to check its status.'
        : 'Linking did not complete. Return to PayPer402 to try again.';
  res
    .status(200)
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8"><title>PayPer402</title>` +
        `<p style="font:16px system-ui;padding:24px">${escapeHtml(text)}</p>`,
    );
}

/** `/paypal/return` and `/paypal/cancel` (design spec §7.5), keyed by single-use `state`. */
export function paypalRoutes(ctx: ServiceContext, wallets: WalletService): Router {
  const router = Router();
  const stateOf = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : undefined;

  router.get(
    '/return',
    handler(async (req, res) => {
      const state = stateOf(req.query['state']);
      const operatorId = state ? wallets.findByState(state) : undefined;
      // Unknown or used state: redirect anyway, reveal nothing, change nothing.
      if (!state || !operatorId) {
        finishRedirect(ctx, res, 'unknown');
        return;
      }
      if (wallets.relinkPending(operatorId)) {
        finishRedirect(ctx, res, wallets.get(operatorId).status);
        return;
      }
      try {
        const wallet = await wallets.finish(operatorId, state);
        finishRedirect(ctx, res, wallet.status);
      } catch (err) {
        ctx.logger.warn('Finishing a link from the PayPal return failed', { operatorId, error: errorMessage(err) });
        finishRedirect(ctx, res, wallets.get(operatorId).status);
      }
    }),
  );

  router.get('/cancel', (req, res) => {
    const state = stateOf(req.query['state']);
    const operatorId = state ? wallets.cancel(state) : undefined;
    finishRedirect(ctx, res, operatorId ? wallets.get(operatorId).status : 'unknown');
  });

  return router;
}
