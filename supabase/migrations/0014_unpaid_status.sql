-- 0014_unpaid_status.sql
-- Add a new "unpaid" order status: a side-flag (like "cancelled"), NOT a step
-- in the New → In Progress → Ready → Completed production line.
--
-- Use case: an order comes in but Paige can't match/find the payment (she
-- collects full payment up front and won't start a set unpaid). She flags the
-- order "unpaid", which auto-sends the customer a gentle nudge to send payment
-- and reference their order number. Once paid, she moves it on to In Progress.
--
-- NOTE: the live orders_status_chk is the COLLAPSED 5-value set
-- ('new','in_progress','ready','completed','cancelled') — repo migration 0008's
-- 'ready_to_ship'/'ready_for_label' set was later superseded via the Supabase
-- MCP. This migration reflects the live reality and just ADDS 'unpaid'.

-- 1) Allow 'unpaid' on orders.status. Additive superset — no existing row is
--    invalidated, so the momentary drop→add is safe.
alter table public.orders drop constraint if exists orders_status_chk;
alter table public.orders add constraint orders_status_chk
  check (status in ('new','unpaid','in_progress','ready','completed','cancelled'));

-- 2) Seed the editable "unpaid" email template. notification_templates.status
--    is a free-form PK (no CHECK/FK); one row per status, 1:1 with the value.
--    Body uses the {{total}} (amount due) and {{order_no}} (PM-###) placeholders
--    rendered client-side by admin.html's renderEmailHtml().
insert into public.notification_templates (status, subject, heading, body, enabled, sort) values
  ('unpaid',
   'A quick note about your order 💛',
   'Just waiting on payment',
   'I''m so excited to make your set! I just wanted to reach out because I haven''t been able to match a payment to your order yet, so I haven''t started it. Whenever you get a chance, please send your total of {{total}} and add your order number {{order_no}} to the payment note so I can find it. As soon as it comes through, I''ll get right to work! 💕',
   true, 2)
on conflict (status) do nothing;
