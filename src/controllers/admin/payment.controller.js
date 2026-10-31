import mongoose from 'mongoose';
import PaymentModel from '../../models/payment.model.js';
import StudentModel from '../../models/student.model.js';
import mailer from '../../utils/Mailer.js';
import { invoiceIssuedEmail } from '../../utils/emailTemplate.js';
import ENV from '../../config/env.js';
import stripeService from '../../services/stripe.service.js';
import {
  resolvePurpose,
  serializePayment,
  paymentPopulate,
  PURPOSE_LABELS,
  personName,
} from '../../utils/payment.helpers.js';

const formatMoney = (amount, currency = 'USD') => {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: (currency || 'USD').toUpperCase(),
      maximumFractionDigits: 2,
    }).format(Number(amount) || 0);
  } catch {
    return `${currency} ${Number(amount) || 0}`;
  }
};

const formatDateLabel = (date) => {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
};

const loadPayment = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const error = new Error('Invalid payment ID');
    error.statusCode = 400;
    throw error;
  }

  const payment = await PaymentModel.findById(id).populate(paymentPopulate);
  if (!payment || !payment.isActive) {
    const error = new Error('Payment not found');
    error.statusCode = 404;
    throw error;
  }

  return payment;
};

const syncPaymentWithStripe = async (payment) => {
  if (!payment || !payment.stripeInvoiceId) {
    return payment;
  }
  if (payment.status === 'paid' && payment.receiptUrl) {
    return payment;
  }

  try {
    const invoice = await stripeService.retrieveInvoice(
      payment.stripeInvoiceId
    );
    if (invoice) {
      await stripeService.applyInvoiceToPayment(payment, invoice);
      await payment.save();
    }
  } catch (error) {
    console.warn('Stripe sync skipped:', error.message);
  }

  return payment;
};

const sendInvoiceEmail = async (payment) => {
  const guardianUser = payment.guardian?.user;
  if (!guardianUser?.email) return false;

  const studentName = personName(payment.student) || 'your student';
  // Send guardians into the app so Pay uses Checkout (success/failure return pages).
  const dashboardUrl = ENV.FRONTEND_URL
    ? `${ENV.FRONTEND_URL.replace(/\/$/, '')}/dashboard/payments`
    : '';
  const payUrl = payment.stripeHostedInvoiceUrl || dashboardUrl;

  const template = invoiceIssuedEmail({
    firstName: guardianUser.firstName,
    studentName,
    title: payment.title,
    feeType: PURPOSE_LABELS[payment.purpose] || payment.purpose,
    amountLabel: formatMoney(payment.amount, payment.currency),
    dueDateLabel: formatDateLabel(payment.dueDate),
    payUrl,
    dashboardUrl,
  });

  await mailer.sendEmail({
    to: guardianUser.email,
    subject: template.subject,
    html: template.html,
    text: template.text,
  })
  return true;
}

export const createInvoice = async (req, res, next) => {
  try {
    const {
      studentId,
      title,
      feeType,
      purpose,
      description,
      amount,
      currency,
      term,
      academicYear,
      dueDate,
      notes,
    } = req.body;

    if (!studentId || !mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ message: 'Valid studentId is required' });
    }

    if (!title?.trim()) {
      return res.status(400).json({ message: 'Title is required' });
    }
    const amountNumber = Number(amount);
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      return res.status(400).json({ message: 'Amount must be greater than 0' });
    }

    const resolvedPurpose = resolvePurpose(purpose || feeType);
    if (!resolvedPurpose) {
      return res.status(400).json({ message: 'Valid fee type / purpose is required' });
    }

    const student = await StudentModel.findById(studentId)
      .populate({
        path: 'user',
        select: 'firstName lastName email photo isActive isDeleted',
      })
      .populate({
        path: 'guardian',
        populate: {
          path: 'user',
          select: 'firstName lastName email photo isActive isDeleted',
        },
      });

    if (!student || !student.user || student.user.isDeleted) {
      return res.status(404).json({ message: 'Student not found' });
    }

    if (!student.guardian || !student.guardian.user) {
      return res.status(400).json({
        message:
          'This student has no guardian. Link a guardian before creating an invoice.',
      });
    }

    if (student.guardian.user.isDeleted || student.guardian.user.isActive === false) {
      return res.status(400).json({
        message: 'The linked guardian account is inactive.',
      });
    }

    const payment = await PaymentModel.create({
      student: student._id,
      guardian: student.guardian._id,
      class: student.class || undefined,
      title: title.trim(),
      purpose: resolvedPurpose,
      description: description?.trim() || notes?.trim() || '',
      amount: amountNumber,
      amountPaid: 0,
      currency: (currency || 'USD').toUpperCase(),
      method: 'stripe',
      status: 'pending',
      term: term?.trim() || '',
      academicYear: academicYear?.trim() || '',
      dueDate: dueDate ? new Date(dueDate) : undefined,
      notes: notes?.trim() || '',
    });

    let stripeInvoice;
    try {
      const customer = await stripeService.getOrCreateCustomer({
        guardian: student.guardian,
        guardianUser: student.guardian.user,
      });

      stripeInvoice = await stripeService.createAndFinalizeInvoice({
        customerId: customer.id,
        payment,
        studentName: personName(student),
      });

      await stripeService.applyInvoiceToPayment(payment, stripeInvoice);
      await payment.save();
    } catch (stripeError) {
      payment.status = 'failed';
      payment.notes = [
        payment.notes,
        `Stripe error: ${stripeError.message}`,
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 500);
      await payment.save();

      const error = new Error(
        stripeError.message || 'Failed to create Stripe invoice',
      );
      error.statusCode = stripeError.statusCode || 502;
      throw error;
    }

    const populated = await PaymentModel.findById(payment._id).populate(
      paymentPopulate,
    );

    let emailSent = false;
    try {
      emailSent = await sendInvoiceEmail(populated);
    } catch (emailError) {
      console.warn('Invoice email failed:', emailError.message);
    }

    res.status(201).json({
      message: 'Invoice created successfully',
      payment: serializePayment(populated),
      emailSent,
      hostedInvoiceUrl: populated.stripeHostedInvoiceUrl || null,
    });
  } catch (error) {
    if (error.statusCode) res.status(error.statusCode)
    next(error)
  }
}

export const getPayments = async (req, res, next) => {
  try {
    const { search, status, purpose, feeType, studentId, guardianId } = req.query;
    const filter = { isActive: true };

    if (studentId && mongoose.Types.ObjectId.isValid(studentId)) {
      filter.student = studentId;
    }
    if (guardianId && mongoose.Types.ObjectId.isValid(guardianId)) {
      filter.guardian = guardianId;
    }

    const resolvedPurpose = resolvePurpose(purpose || feeType);
    if (resolvedPurpose) filter.purpose = resolvedPurpose;

    if (status && status !== 'All' && status !== 'Overdue') {
      filter.status = String(status).toLowerCase();
    }

    let payments = await PaymentModel.find(filter)
      .populate(paymentPopulate)
      .sort({ createdAt: -1 })
      .lean();

    if (status === 'Overdue') {
      const now = new Date();
      payments = payments.filter((payment) => {
        if (!['pending', 'partial'].includes(payment.status)) {
          return false;
        }
        if (!payment.dueDate) return false;
        const due = new Date(payment.dueDate);
        due.setHours(23, 59, 59, 999);
        return due < now;
      });
    }

    if (search?.trim()) {
      const q = search.trim().toLowerCase();
      payments = payments.filter((payment) => {
        const haystack = [
          payment.title,
          payment.purpose,
          payment.term,
          payment.academicYear,
          payment.status,
          payment.transactionId,
          payment.notes,
          personName(payment.student),
          personName(payment.guardian),
          payment.student?.user?.email,
          payment.guardian?.user?.email,
          String(payment._id),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(q);
      });
    }

    const serialized = payments.map(serializePayment);

    const stats = serialized.reduce(
      (acc, payment) => {
        acc.totalCollected += payment.amountPaid;
        acc.outstanding += payment.balance;
        if (payment.status === 'Overdue') acc.overdueCount += 1;
        if (payment.statusKey === 'paid') acc.paidCount += 1;
        return acc;
      },
      {
        totalCollected: 0,
        outstanding: 0,
        overdueCount: 0,
        paidCount: 0,
      },
    );

    res.json({
      count: serialized.length,
      stats,
      payments: serialized,
    });
  } catch (error) {
    next(error);
  }
};

export const getPaymentById = async (req, res, next) => {
  try {
    let payment = await loadPayment(req.params.id);
    payment = await syncPaymentWithStripe(payment);
    const populated = await PaymentModel.findById(payment._id).populate(
      paymentPopulate,
    );

    res.json({ payment: serializePayment(populated) });
  } catch (error) {
    if (error.statusCode) res.status(error.statusCode);
    next(error);
  }
};

export const updatePayment = async (req, res, next) => {
  try {
    const payment = await loadPayment(req.params.id);
    const { notes, term, academicYear, dueDate } = req.body;

    if (notes !== undefined) payment.notes = String(notes).trim();
    if (term !== undefined) payment.term = String(term).trim();
    if (academicYear !== undefined) {
      payment.academicYear = String(academicYear).trim();
    }
    if (dueDate !== undefined) {
      payment.dueDate = dueDate ? new Date(dueDate) : undefined;
    }

    await payment.save();
    const populated = await PaymentModel.findById(payment._id).populate(
      paymentPopulate,
    );

    res.json({
      message: 'Payment updated successfully',
      payment: serializePayment(populated),
    });
  } catch (error) {
    if (error.statusCode) res.status(error.statusCode);
    next(error);
  }
};

export const cancelPayment = async (req, res, next) => {
  try {
    const payment = await loadPayment(req.params.id);

    if (payment.status === 'paid') {
      return res
        .status(400)
        .json({ message: 'Paid invoices cannot be cancelled' });
    }

    if (payment.status === 'cancelled') {
      return res.status(400).json({ message: 'Invoice is already cancelled' });
    }

    if (payment.stripeInvoiceId) {
      try {
        const voided = await stripeService.voidInvoice(
          payment.stripeInvoiceId,
        );
        await stripeService.applyInvoiceToPayment(payment, voided);
      } catch (stripeError) {
        // Still cancel locally if Stripe invoice is already unusable.
        console.warn('Stripe void failed:', stripeError.message);
        payment.status = 'cancelled';
      }
    } else {
      payment.status = 'cancelled';
    }

    await payment.save();
    const populated = await PaymentModel.findById(payment._id).populate(
      paymentPopulate,
    );

    res.json({
      message: 'Invoice cancelled successfully',
      payment: serializePayment(populated),
    });
  } catch (error) {
    if (error.statusCode) res.status(error.statusCode);
    next(error);
  }
};

export const resendInvoice = async (req, res, next) => {
  try {
    let payment = await loadPayment(req.params.id);
    payment = await syncPaymentWithStripe(payment);

    if (payment.status === 'paid') {
      return res
        .status(400)
        .json({ message: 'This invoice is already paid' });
    }
    if (payment.status === 'cancelled') {
      return res
        .status(400)
        .json({ message: 'Cancelled invoices cannot be resent' });
    }

    const populated = await PaymentModel.findById(payment._id).populate(
      paymentPopulate,
    );

    const emailSent = await sendInvoiceEmail(populated);

    res.json({
      message: emailSent
        ? 'Invoice email resent to guardian'
        : 'No guardian email available',
      emailSent,
      payment: serializePayment(populated),
      hostedInvoiceUrl: populated.stripeHostedInvoiceUrl || null,
    });
  } catch (error) {
    if (error.statusCode) res.status(error.statusCode);
    next(error);
  }
};