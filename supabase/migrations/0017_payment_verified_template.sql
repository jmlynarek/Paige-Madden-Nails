-- 0017: "Payment verified" customer email template.
--
-- Fired from admin's "Mark payment collected" button (setPaymentCollected in
-- admin.html), NOT from a status change — payment_collected is a standalone
-- flag, deliberately separate from the status flow. This email is the
-- promise-keeper for the order-received email ("first I'll confirm your
-- payment"): it tells the customer the money arrived and they're officially
-- in the queue, without promising when work starts (Paige may be backlogged).
-- The separate in_progress ("Set started") template stays tied to the status
-- flow for the actual "I've started" moment; it's off by default and acts as
-- a seasonal dial for busy periods.
--
-- Copy deliberately makes no timing promises: "in the queue" is true whether
-- Paige starts in an hour or in three weeks.

insert into public.notification_templates (status, subject, heading, body, enabled, sort) values
  ('payment_verified',
   'Payment received! You''re in the queue 🎉',
   'Payment verified',
   'Great news: your payment came through and your order is officially in the queue. I''ll take it from here, and you''ll hear from me as soon as your set is ready.',
   true, 2)
on conflict (status) do nothing;
