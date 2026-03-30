// app/api/webhooks/stripe/route.js
// Stripe webhook — upgrades/downgrades user plans in real time

import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';
import { headers } from 'next/headers';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const prisma = new PrismaClient();

const PLAN_MAP = {
  [process.env.STRIPE_PRO_PRICE_ID]:   'PRO',
  [process.env.STRIPE_ELITE_PRICE_ID]: 'ELITE',
};

export async function POST(request) {
  const body = await request.text();
  const headersList = headers();
  const sig = headersList.get('stripe-signature');

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature failed:', err.message);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  console.log(`📦 Stripe event: ${event.type}`);

  try {
    switch (event.type) {
      // ── Subscription created / updated ─────────────────────────────────
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const priceId = subscription.items.data[0]?.price?.id;
        const plan = PLAN_MAP[priceId] || 'FREE';
        const isActive = ['active', 'trialing'].includes(subscription.status);

        await prisma.user.updateMany({
          where: { stripeCustomerId: customerId },
          data: { plan: isActive ? plan : 'FREE' },
        });

        console.log(`✅ User plan updated to ${isActive ? plan : 'FREE'} (customer: ${customerId})`);
        break;
      }

      // ── Subscription cancelled ──────────────────────────────────────────
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        await prisma.user.updateMany({
          where: { stripeCustomerId: subscription.customer },
          data: { plan: 'FREE' },
        });
        console.log(`⬇️ User downgraded to FREE (customer: ${subscription.customer})`);
        break;
      }

      // ── Checkout completed — link Stripe customer to user ───────────────
      case 'checkout.session.completed': {
        const session = event.data.object;
        const clerkId = session.metadata?.clerkId;
        const customerId = session.customer;

        if (clerkId && customerId) {
          await prisma.user.update({
            where: { clerkId },
            data: { stripeCustomerId: customerId },
          });
          console.log(`🔗 Linked Stripe customer ${customerId} to user ${clerkId}`);
        }
        break;
      }

      // ── Payment failed ──────────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.warn(`⚠️ Payment failed for customer: ${invoice.customer}`);
        // Optionally notify user — do NOT immediately downgrade
        break;
      }

      default:
        console.log(`Unhandled Stripe event: ${event.type}`);
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    return NextResponse.json({ error: 'Webhook handler failed' }, { status: 500 });
  }
}
