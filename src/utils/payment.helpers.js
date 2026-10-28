const PURPOSE_LABELS = {
  tuition: 'Tuition',
  exam_fee: 'Exam',
  transport: 'Transport',
  uniform: 'Uniform',
  books: 'Books',
  hostel: 'Hostel',
  activity: 'Activity',
  library: 'Library',
  other: 'Other',
};

const FEE_TYPE_TO_PURPOSE = {
  Tuition: 'tuition',
  Exam: 'exam_fee',
  Transport: 'transport',
  Uniform: 'uniform',
  Books: 'books',
  Hostel: 'hostel',
  Activity: 'activity',
  Library: 'library',
  Other: 'other',
};

const METHOD_LABELS = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank Transfer',
  mobile_money: 'Mobile Money',
  cheque: 'Cheque',
  stripe: 'Stripe',
  other: 'Other',
};

// Builds a display name from a student, guardian, or nested user.
// Used in payment APIs, receipts, and invoice emails.
const personName = (entity) => {
  if (!entity) return '';
  if (entity.name) return entity.name;
  const user = entity.user && typeof entity.user === 'object' ? entity.user : entity;
  return `${user.firstName || ''} ${user.lastName || ''}`.trim();
};

const isPastDue = (dueDate, status) => {
  if (!dueDate) return false;
  if (!['pending', 'partial', 'partially_paid'].includes(status)) return false;
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return false;
  const endOfDueDay = new Date(due);
  endOfDueDay.setHours(23, 59, 59, 999);
  return endOfDueDay < new Date();
};

// Human-readable payment status for the UI (Paid, Pending, Overdue, etc.).
const displayStatus = (payment) => {
  const status = payment.status || 'pending';
  if (isPastDue(payment.dueDate, status)) return 'Overdue';
  return status.charAt(0).toUpperCase() + status.slice(1);
};

const resolvePurpose = (feeTypeOrPurpose) => {
  if (!feeTypeOrPurpose) return null;
  const raw = String(feeTypeOrPurpose).trim();
  if (FEE_TYPE_TO_PURPOSE[raw]) return FEE_TYPE_TO_PURPOSE[raw];
  const lower = raw.toLowerCase().replace(/\s+/g, '_');
  if (PURPOSE_LABELS[lower]) return lower;
  if (lower === 'exam') return 'exam_fee';
  return null;
};

// Converts a fee amount (e.g. 1500.00) into Stripe's smallest currency unit (cents).
const toStripeAmount = (amount) => Math.round(Number(amount) * 100);

// Shapes a payment for admin and guardian APIs: names, balance, overdue status,
// Stripe receipt links, and class info.
const serializePayment = (payment) => {
  if (!payment) return null;

  const studentDoc =
    payment.student && typeof payment.student === 'object'
      ? payment.student
      : null;

  const guardianDoc =
    payment.guardian && typeof payment.guardian === 'object'
      ? payment.guardian
      : null;

  const classDoc =
    payment.class && typeof payment.class === 'object'
      ? payment.class
      : null;

  const amount = Number(payment.amount) || 0;
  const amountPaid = Number(payment.amountPaid) || 0;
  const balance = Math.max(0, amount - amountPaid);
  const statusKey = payment.status || 'pending';
  const status = displayStatus(payment);
  const purpose = payment.purpose || 'other';
  const kind = statusKey === 'paid' ? 'Payment' : 'Invoice';

  return {
    id: String(payment._id || payment.id),
    _id: payment._id || payment.id,
    kind,
    title: payment.title || PURPOSE_LABELS[purpose] || 'Invoice',
    purpose,
    feeType: PURPOSE_LABELS[purpose] || 'Other',
    description: payment.description || '',
    amount,
    amountPaid,
    balance,
    currency: (payment.currency || 'USD').toUpperCase(),
    method: payment.method || 'stripe',
    paymentMethod: METHOD_LABELS[payment.method] || payment.method || null,
    status,
    statusKey,
    term: payment.term || '',
    academicYear: payment.academicYear || '',
    dueDate: payment.dueDate || null,
    paidAt: payment.paidDate || null,
    paidDate: payment.paidDate || null,
    notes: payment.notes || '',
    receiptNumber: payment.transactionId || null,
    receiptUrl: payment.receiptUrl || payment.stripeInvoicePdf || '',
    stripeInvoiceId: payment.stripeInvoiceId || '',
    stripeHostedInvoiceUrl: payment.stripeHostedInvoiceUrl || '',
    stripeInvoicePdf: payment.stripeInvoicePdf || '',
    isActive: payment.isActive !== false,
    createdAt: payment.createdAt || null,
    updatedAt: payment.updatedAt || null,
    student: studentDoc
      ? {
          id: String(studentDoc._id || studentDoc.id),
          name: personName(studentDoc),
          email: studentDoc.user?.email || studentDoc.email || '',
          photo: studentDoc.user?.photo || studentDoc.photo || '',
          classGrade:
            classDoc?.className ||
            studentDoc.class?.className ||
            '',
        }
      : payment.student
      ? { id: String(payment.student), name: '', email: '', photo: '' }
      : null,
    guardian: guardianDoc
      ? {
          id: String(guardianDoc._id || guardianDoc.id),
          name: personName(guardianDoc),
          email: guardianDoc.user?.email || guardianDoc.email || '',
          photo: guardianDoc.user?.photo || guardianDoc.photo || '',
        }
      : payment.guardian
      ? { id: String(payment.guardian), name: '', email: '', photo: '' }
      : null,
    class: classDoc
      ? {
          id: String(classDoc._id || classDoc.id),
          className: classDoc.className || '',
          classCode: classDoc.classCode || '',
        }
      : null,
  };
};



const paymentPopulate = [
  {
    path: 'student',
    select: 'user class guardian',
    populate: [
      {
        path: 'user',
        select: 'firstName lastName email photo',
      },
      {
        path: 'class',
        select: 'className classCode grade academicYear',
      },
    ],
  },
  {
    path: 'guardian',
    select: 'user stripeCustomerId',
    populate: {
      path: 'user',
      select: 'firstName lastName email photo',
    },
  },
  {
    path: 'class',
    select: 'className classCode grade academicYear',
  },
];

export {
  PURPOSE_LABELS,
  FEE_TYPE_TO_PURPOSE,
  METHOD_LABELS,
  personName,
  isPastDue,
  displayStatus,
  resolvePurpose,
  toStripeAmount,
  serializePayment,
  paymentPopulate,
};