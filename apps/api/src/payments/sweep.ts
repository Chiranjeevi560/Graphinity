// A payment left `creating` (the server stopped between recording the ask and recording Razorpay's link) is marked
// failed after an hour, so the record says what happened. If Razorpay did make the link and it is paid, the webhook
// still adopts it from the signed event (routes/payments.ts): failed never blocks money from being recorded.
import type { Database } from '../db.ts';

export async function sweepStalePayments(db: Pick<Database, 'asSystem'>): Promise<number> {
  return db.asSystem(
    async q =>
      (
        await q.query(
          "UPDATE app.payments SET status = 'failed' WHERE status = 'creating' AND created_at < now() - interval '1 hour'",
        )
      ).rowCount ?? 0,
  );
}
