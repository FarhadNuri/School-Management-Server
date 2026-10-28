import mongoose from 'mongoose';
import UserModel from '../../models/user.model.js';
import ClassModel from '../../models/class.model.js';
import PaymentModel from '../../models/payment.model.js';
import StudentModel from '../../models/student.model.js';
import GuardianModel from '../../models/guardian.model.js';
import stripeService from '../../services/stripe.service.js';
import { sendPaymentReceiptEmail } from '../../utils/paymentEmails.js';
import {
  serializePayment,
  paymentPopulate,
} from '../../utils/payment.helpers.js';

/**
 * GET /api/user/payments
 * Lists all invoices for the authenticated user.
 * - Students can view their invoices (title, amount, balance, status, due date), but payUrl is stripped.
 * - Guardians can view their invoices and have access to payUrl (Stripe hosted invoice link).
 */

const syncPaymentWithStripe = async (payment) => {
  if (!payment || payment.status === 'paid') return payment;

  try {
    if (payment.stripeInvoiceId) {
      const invoice = await stripeService.retrieveInvoice(payment.stripeInvoiceId);
      if (invoice && invoice.status === 'paid') {
        stripeService.applyInvoiceToPayment(payment, invoice);
        await payment.save();
        try {
          await sendPaymentReceiptEmail(payment);
        } catch (e) {
          console.warn('Receipt email failed:', e.message);
        }
      }
    } else if (payment.stripeCheckoutSessionId) {
      const session = await stripeService.retrieveCheckoutSession(payment.stripeCheckoutSessionId);
      if (session && session.payment_status === 'paid') {
        stripeService.applyCheckoutSessionToPayment(payment, session);
        await payment.save();
        try {
          await sendPaymentReceiptEmail(payment);
        } catch (e) {
          console.warn('Receipt email failed:', e.message);
        }
      }
    }
  } catch (err) {
    console.warn('Stripe sync skipped:', err.message);
  }

  return payment;
};

export const getMyPayments = async (req, res, next) => {
  try {
    const { search } = req.query;
    const user = req.user;

    if (!user || !user.role) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const conditions = [{ isActive: true }];

    if (user.role === 'student') {
      const student = await StudentModel.findOne({ user: user._id }).select('_id');
      if (!student) {
        return res.json({ count: 0, payments: [] });
      }
      conditions.push({ student: student._id });
    } else if (user.role === 'guardian') {
      const guardian = await GuardianModel.findOne({ user: user._id }).select('_id students');
      if (!guardian) {
        return res.json({ count: 0, payments: [] });
      }
      const studentIds = (guardian.students || []).filter(Boolean);
      conditions.push({
        $or: [
          { guardian: guardian._id },
          ...(studentIds.length ? [{ student: { $in: studentIds } }] : []),
        ],
      });
    } else {
      // Teachers or other roles don't have fee invoices
      return res.json({ count: 0, payments: [] });
    }

    if (search?.trim()) {
      const term = search.trim();
      const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      conditions.push({
        $or: [
          { title: regex },
          { purpose: regex },
          { description: regex },
          { transactionId: regex },
        ],
      });
    }

    const filter = conditions.length > 1 ? { $and: conditions } : conditions[0];

    const payments = await PaymentModel.find(filter)
      .populate(paymentPopulate)
      .sort({ createdAt: -1 });

    // Live sync any pending/overdue invoices with Stripe
    const pendingStripeList = payments.filter(
      (p) => p.status !== 'paid' && (p.stripeInvoiceId || p.stripeCheckoutSessionId)
    );

    if (pendingStripeList.length > 0) {
      await Promise.allSettled(
        pendingStripeList.map(async (doc) => {
          await syncPaymentWithStripe(doc);
        })
      );
    }

    const serialized = payments.map((payment) => {
      const item = serializePayment(payment);
      if (user.role === 'student') {
        // Students are allowed to view the invoice, but NOT the payment link
        item.stripeHostedInvoiceUrl = '';
        item.stripeCheckoutSessionId = '';
        item.payUrl = null;
      }
      return item;
    });

    res.json({
      count: serialized.length,
      payments: serialized,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/user/payments/:id
 * Retrieves a single invoice by ID with strict role authorization.
 */
export const getMyPaymentById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const user = req.user;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid payment ID' });
    }

    const payment = await PaymentModel.findById(id).populate(paymentPopulate);
    if (!payment || !payment.isActive) {
      return res.status(404).json({ message: 'Payment not found' });
    }
    await syncPaymentWithStripe(payment);

    // Verify ownership
    if (user.role === 'student') {
      const student = await StudentModel.findOne({ user: user._id }).select('_id');
      const studentId = student?._id?.toString();
      const paymentStudentId = (payment.student?._id || payment.student)?.toString();
      if (!studentId || studentId !== paymentStudentId) {
        return res.status(403).json({ message: 'You do not have access to this payment' });
      }
    } else if (user.role === 'guardian') {
      const guardian = await GuardianModel.findOne({ user: user._id }).select('_id students');
      const guardianId = guardian?._id?.toString();
      const paymentGuardianId = (payment.guardian?._id || payment.guardian)?.toString();
      const studentIds = (guardian?.students || []).map((s) => s.toString());
      const paymentStudentId = (payment.student?._id || payment.student)?.toString();

      const isOwned =
        guardianId === paymentGuardianId ||
        (paymentStudentId && studentIds.includes(paymentStudentId));
      if (!isOwned) {
        return res.status(403).json({ message: 'You do not have access to this payment' });
      }
    } else {
      return res.status(403).json({ message: 'Access denied' });
    }

    const serialized = serializePayment(payment);
    if (user.role === 'student') {
      serialized.stripeHostedInvoiceUrl = '';
      serialized.stripeCheckoutSessionId = '';
      serialized.payUrl = null;
    }

    res.json({ payment: serialized });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/user/payments/:id/checkout
 * Allows guardians to initiate or retrieve a Stripe payment checkout URL.
 * Students and teachers are forbidden from paying.
 */
export const checkoutPayment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const user = req.user;

    if (user.role !== 'guardian') {
      return res.status(403).json({ message: 'Only guardians can pay invoices' });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid payment ID' });
    }

    const payment = await PaymentModel.findById(id).populate(paymentPopulate);
    if (!payment || !payment.isActive) {
      return res.status(404).json({ message: 'Payment not found' });
    }

    if (payment.status === 'paid') {
      return res.status(400).json({ message: 'This invoice has already been paid' });
    }

    const guardian = await GuardianModel.findOne({ user: user._id }).select('_id students');
    const guardianId = guardian?._id?.toString();
    const paymentGuardianId = (payment.guardian?._id || payment.guardian)?.toString();
    const studentIds = (guardian?.students || []).map((s) => s.toString());
    const paymentStudentId = (payment.student?._id || payment.student)?.toString();

    const isOwned =
      guardianId === paymentGuardianId ||
      (paymentStudentId && studentIds.includes(paymentStudentId));
    if (!isOwned) {
      return res.status(403).json({ message: 'You do not have permission to pay this invoice' });
    }

    // If stripeHostedInvoiceUrl already exists, return it
    if (payment.stripeHostedInvoiceUrl) {
      return res.json({
        url: payment.stripeHostedInvoiceUrl,
        payUrl: payment.stripeHostedInvoiceUrl,
      });
    }

    // Otherwise create a Stripe checkout session if available
    try {
      const session = await stripeService.createCheckoutSession(payment);
      payment.stripeCheckoutSessionId = session.id;
      await payment.save();
      return res.json({
        url: session.url,
        payUrl: session.url,
        sessionId: session.id,
      });
    } catch (stripeErr) {
      return res.status(500).json({
        message: stripeErr.message || 'Unable to initiate payment session',
      });
    }
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/user/payments/checkout-session/:sessionId
 * Confirms payment status for a checkout session.
 */
export const confirmCheckoutSession = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId) {
      return res.status(400).json({ message: 'Session ID is required' });
    }

    const session = await stripeService.retrieveCheckoutSession(sessionId);
    if (!session) {
      return res.status(404).json({ message: 'Checkout session not found' });
    }

    const paymentId = session.metadata?.paymentId;
    if (paymentId && session.payment_status === 'paid') {
      await PaymentModel.findByIdAndUpdate(paymentId, {
        status: 'paid',
        paidDate: new Date(),
        amountPaid: Number(session.amount_total || 0) / 100,
        transactionId: session.payment_intent?.id || session.id,
      });
    }

    res.json({
      status: session.payment_status,
      session,
    });
  } catch (error) {
    next(error);
  }
};


/**
 * POST /api/user/payments/:id/sync
 * Manually force a live sync with Stripe for a payment invoice.
 */
export const syncMyPayment = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid payment ID' });
    }
    const payment = await PaymentModel.findById(id).populate(paymentPopulate);
    if (!payment || !payment.isActive) {
      return res.status(404).json({ message: 'Payment not found' });
    }
    await syncPaymentWithStripe(payment);
    const populated = await PaymentModel.findById(payment._id).populate(paymentPopulate);
    res.json({
      message: 'Payment status synced successfully',
      payment: serializePayment(populated)
    });
  } catch (error) {
    next(error);
  }
};
