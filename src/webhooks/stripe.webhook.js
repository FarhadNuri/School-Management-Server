import PaymentModel from '../models/payment.model.js';
import stripe from '../config/stripe.js';
import ENV from '../config/env.js';
import stripeService from '../services/stripe.service.js';
import { sendPaymentReceiptEmail } from '../utils/paymentEmails.js';


/**
 * Resolve a Payment document from a Stripe Invoice payload.
 */
const findPaymentForInvoice = async (invoice) => {
    if (!invoice) return null;

    const paymentId = invoice.metadata?.paymentId;
    if (paymentId) {
        const byMeta = await PaymentModel.findById(paymentId);
        if (byMeta) return byMeta;
    }

    if (invoice.id) {
        return PaymentModel.findOne({ stripeInvoiceId: invoice.id });
    }

    return null;
};

const findPaymentForCheckoutSession = async (session) => {
    if (!session) return null;

    const paymentId =
        session.metadata?.paymentId || session.client_reference_id;
    if (paymentId) {
        const byMeta = await PaymentModel.findById(paymentId);
        if (byMeta) return byMeta;
    }

    if (session.id) {
        return PaymentModel.findOne({ stripeCheckoutSessionId: session.id });
    }

    return null;
};

/**
 * Mark local payment paid from Checkout, then settle the linked invoice
 * out-of-band so Stripe Invoice and Checkout stay in sync without double charge.
 */
const settleCheckoutSession = async (session) => {
    const payment = await findPaymentForCheckoutSession(session);
    if (!payment) return;

    await stripeService.applyCheckoutSessionToPayment(payment, session);
    await payment.save();

    if (payment.status === 'paid' && payment.stripeInvoiceId) {
        try {
            const invoice = await stripeService.markInvoicePaidOutOfBand(
                payment.stripeInvoiceId,
            );
            if (invoice) {
                await stripeService.applyInvoiceToPayment(payment, invoice);
                await payment.save();
            }
        } catch (error) {
            console.warn(
                'Webhook invoice out-of-band settle skipped:',
                error.message,
            );
        }
    }

    if (payment.status === 'paid') {
        await sendPaymentReceiptEmail(payment);
    }
};

const handleInvoiceEvent = async (invoice) => {
    const payment = await findPaymentForInvoice(invoice);
    if (!payment) return;

    const wasPaid = payment.status === 'paid';
    await stripeService.applyInvoiceToPayment(payment, invoice);
    await payment.save();

    if (!wasPaid && payment.status === 'paid') {
        await sendPaymentReceiptEmail(payment);
    }
};

/**
 * Verify Stripe signature and parse the event payload.
 */
const constructStripeEvent = (req) => {
  const signature = req.headers['stripe-signature'];

  if (ENV.STRIPE_WEBHOOK_SECRET) {
    return stripe.webhooks.constructEvent([
      req.body,
      signature,
      ENV.STRIPE_WEBHOOK_SECRET,
    ]);
  }

  if (ENV.NODE_ENV === 'production') {
    const error = new Error('Webhook secret is not configured');
    error.statusCode = 500;
    throw error;
  }

  console.warn(
    '⚠ STRIPE_WEBHOOK_SECRET missing - webhook signature not verified',
  );

  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
    return JSON.parse(req.body.toString());
  }

  return req.body;
};

/**
 * Dispatch a verified Stripe event to the matching domain handler.
 */
const dispatchStripeEvent = async (event) => {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      await settleCheckoutSession(event.data.object);
      break;

    case 'invoice.paid':
    case 'invoice.payment_succeeded':
    case 'invoice.updated':
    case 'invoice.voided':
    case 'invoice.marked_uncollectible':
      await handleInvoiceEvent(event.data.object);
      break;

    default:
      break;
  }
};

const handleStripeWebhook = async (req, res) => {
  let event;

  try {
    event = constructStripeEvent(req);
  } catch (error) {
    console.error('Stripe webhook signature error:', error.message);
    const status = error.statusCode || 400;
    return res.status(status).send(
      status === 500
        ? error.message
        : `Webhook Error: ${error.message}`,
    );
  }

  try {
    await dispatchStripeEvent(event);
    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook handler error:', error);
    res.status(500).json({ message: 'Webhook handler failed' });
  }
};



export { handleStripeWebhook }