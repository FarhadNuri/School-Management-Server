import stripe from '../config/stripe.js';
import ENV from '../config/env.js';
import GuardianModel from '../models/guardian.model.js';
import { toStripeAmount, PURPOSE_LABELS } from '../utils/payment.helpers.js';

const frontendBaseUrl = () =>
  (ENV.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

const getOrCreateCustomer = async ({ guardian, guardianUser }) => {
  if (!guardian || !guardianUser?.email) {
    throw Object.assign(new Error('Guardian email is required for Stripe'), {
      statusCode: 400,
    });
  }

  if (guardian.stripeCustomerId) {
    try {
      const existing = await stripe.customers.retrieve(
        guardian.stripeCustomerId,
      );
      if (!existing.deleted) return existing;
    } catch {
      // Customer missing remotely — create a fresh one below.
    }
  }

  const customer = await stripe.customers.create({
    email: guardianUser.email,
    name: `${guardianUser.firstName || ''} ${guardianUser.lastName || ''}`.trim(),
    metadata: {
      guardianId: String(guardian._id),
      userId: String(guardianUser._id),
    },
  });

  await GuardianModel.findByIdAndUpdate(guardian._id, {
    stripeCustomerId: customer.id,
  });

  guardian.stripeCustomerId = customer.id;
  return customer;
};

const createAndFinalizeInvoice = async ({
  customerId,
  payment,
  studentName,
}) => {
  const currency = (payment.currency || 'USD').toLowerCase();
  const unitAmount = toStripeAmount(payment.amount);

  if (!Number.isFinite(unitAmount) || unitAmount < 1) {
    throw Object.assign(new Error('Amount must be at least 0.01'), {
      statusCode: 400,
    });
  }

  let daysUntilDue = 7;
  if (payment.dueDate) {
    const due = new Date(payment.dueDate);
    const now = new Date();
    const diffMs = due.setHours(23, 59, 59, 999) - now.getTime();
    daysUntilDue = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
  }

  const purposeLabel =
    PURPOSE_LABELS[payment.purpose] || payment.purpose || 'Fee';
  const description = [studentName, purposeLabel, payment.term]
    .filter(Boolean)
    .join(' · ')
    .slice(0, 500);

  const paymentId = String(payment._id);

    // 1. Create the draft invoice first
  const invoice = await stripe.invoices.create({
    customer: customerId,
    collection_method: 'send_invoice',
    days_until_due: daysUntilDue,
    metadata: {
      paymentId,
      purpose: payment.purpose,
      studentId: String(payment.student || ''),
      guardianId: String(payment.guardian || ''),
    },
  });

  // 2. Attach the invoice item directly to this draft invoice
  await stripe.invoiceItems.create({
    customer: customerId,
    invoice: invoice.id,
    amount: unitAmount,
    currency,
    description: payment.title || description,
    metadata: {
      paymentId,
      purpose: payment.purpose,
      studentId: String(payment.student || ''),
      guardianId: String(payment.guardian || ''),
    },
  });

  // Finalize invoice to generate payment intent and hosted URL
  const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id, {
    auto_advance: true,
  });

  return finalizedInvoice;
};

const createCheckoutSession = async ({ payment, customerId, studentName }) => {
  const currency = (payment.currency || 'USD').toLowerCase();
  const unitAmount = toStripeAmount(payment.amount);

  if (!Number.isFinite(unitAmount) || unitAmount < 1) {
    throw Object.assign(new Error('Amount must be at least 0.01'), {
      statusCode: 400,
    });
  }

  const purposeLabel =
    PURPOSE_LABELS[payment.purpose] || payment.purpose || 'Fee';
  const productName = payment.title || purposeLabel;
  const productDescription = [studentName, purposeLabel, payment.term]
    .filter(Boolean)
    .join(' · ')
    .slice(0, 500);

  const paymentId = String(payment._id);
  const base = frontendBaseUrl();

  return stripe.checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    client_reference_id: paymentId,
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency,
          unit_amount: unitAmount,
          product_data: {
            name: productName,
            description: productDescription || undefined,
          },
        },
        quantity: 1,
      },
    ],
    metadata: {
      paymentId,
      purpose: payment.purpose,
      studentId: String(payment.student || ''),
      guardianId: String(payment.guardian || ''),
    },
    success_url: `${base}/payments/${paymentId}?status=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/payments/${paymentId}?status=cancelled`,
  });
};
const retrieveCheckoutSession = async (sessionId) => {
  if (!sessionId) return null;
  return stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent', 'line_items'],
  });
};

const retrieveInvoice = async (stripeInvoiceId) => {
  if (!stripeInvoiceId) return null;
  return stripe.invoices.retrieve(stripeInvoiceId, {
    expand: ['payment_intent'],
  });
};

const markInvoicePaidOutOfBand = async (stripeInvoiceId) => {
  if (!stripeInvoiceId) return null;
  const invoice = await stripe.invoices.retrieve(stripeInvoiceId);
  if (!invoice || invoice.status === 'paid') {
    return invoice;
  }

  if (invoice.status === 'draft') {
    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
    if (finalized.status === 'paid') return finalized;
  }

  return stripe.invoices.pay(stripeInvoiceId, {
    paid_out_of_band: true,
  });
};

const voidInvoice = async (stripeInvoiceId) => {
  if (!stripeInvoiceId) return null;
  return stripe.invoices.voidInvoice(stripeInvoiceId);
};

const applyInvoiceToPayment = (payment, invoice) => {
  if (!payment || !invoice) return payment;

  payment.stripeInvoiceId = invoice.id || payment.stripeInvoiceId;
  payment.stripeCustomerId =
    typeof invoice.customer === 'string'
      ? invoice.customer
      : invoice.customer?.id || payment.stripeCustomerId;
  payment.stripeHostedInvoiceUrl =
    invoice.hosted_invoice_url || payment.stripeHostedInvoiceUrl;
  payment.stripeInvoicePdf = invoice.invoice_pdf || payment.stripeInvoicePdf;

  const paymentIntent =
    typeof invoice.payment_intent === 'object'
      ? invoice.payment_intent
      : null;
  if (paymentIntent?.id) {
    payment.stripePaymentIntentId = paymentIntent.id;
  } else if (typeof invoice.payment_intent === 'string') {
    payment.stripePaymentIntentId = invoice.payment_intent;
  }

  if (invoice.status === 'paid') {
    payment.status = 'paid';
    payment.amountPaid =
      typeof invoice.amount_paid === 'number'
        ? invoice.amount_paid / 100
        : payment.amount;
    payment.method = 'stripe';
    payment.paidDate = new Date();
    payment.transactionId =
      payment.stripePaymentIntentId || invoice.id || payment.transactionId;
  } else if (
    invoice.status === 'open' &&
    payment.status !== 'paid' &&
    payment.status !== 'cancelled'
  ) {
    payment.status = 'pending';
    payment.stripeHostedInvoiceUrl =
      invoice.hosted_invoice_url || payment.stripeHostedInvoiceUrl;
  }

  return payment;
};

const applyCheckoutSessionToPayment = (payment, session) => {
  if (!payment || !session) return payment;

  payment.stripeCheckoutSessionId = session.id || payment.stripeCheckoutSessionId;
  payment.stripeCustomerId =
    typeof session.customer === 'string'
      ? session.customer
      : session.customer?.id || payment.stripeCustomerId;

  const paymentIntent =
    typeof session.payment_intent === 'object'
      ? session.payment_intent
      : null;
  if (paymentIntent?.id) {
    payment.stripePaymentIntentId = paymentIntent.id;
  } else if (typeof session.payment_intent === 'string') {
    payment.stripePaymentIntentId = session.payment_intent;
  }

  if (session.payment_status === 'paid') {
    payment.status = 'paid';
    payment.amountPaid = payment.amount;
    payment.method = 'stripe';
    payment.paidDate = new Date();
    payment.transactionId =
      payment.stripePaymentIntentId || session.id || payment.transactionId;
  } else if (
    session.status === 'expired' &&
    payment.status !== 'paid' &&
    payment.status !== 'cancelled'
  ) {
    // Leave as pending so the guardian can retry.
    payment.status = 'pending';
  }

  return payment;
};

const stripeService = {
  getOrCreateCustomer,
  createAndFinalizeInvoice,
  createCheckoutSession,
  retrieveCheckoutSession,
  retrieveInvoice,
  voidInvoice,
  markInvoicePaidOutOfBand,
  applyInvoiceToPayment,
  applyCheckoutSessionToPayment,
};

export {
  getOrCreateCustomer,
  createAndFinalizeInvoice,
  createCheckoutSession,
  retrieveCheckoutSession,
  retrieveInvoice,
  voidInvoice,
  markInvoicePaidOutOfBand,
  applyInvoiceToPayment,
  applyCheckoutSessionToPayment,
};

export default stripeService;