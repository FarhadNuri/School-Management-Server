import { Schema, model } from 'mongoose';

const complaintSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: [50, 'Title cannot exceed 50 characters'],
    },
    description: {
      type: String,
      trim: true,
      default: '',
      maxlength: [500, 'Description cannot exceed 500 characters'],
    },
    category: [
      {
        type: String,
        enum: [
          'bullying',
          'harassment',
          'cyberbullying',
          'discrimination',
          'other',
        ],
      },
    ],
    severity: [{ type: String, enum: ['low', 'medium', 'high'] }],
    status: [
      {
        type: String,
        enum: ['pending', 'in_progress', 'under_review', 'resolved'],
        default: 'pending',
      },
    ],
    // Profile ID may point at Student, Teacher, or Guardian (hydrated in controllers)
    reporter: { type: Schema.Types.ObjectId },
    witnesses: {
      type: String,
      trim: true,
      default: '',
      maxlength: [200, 'Witnesses cannot exceed 200 characters'],
    },
    reportedParty: {
      type: String,
      trim: true,
      default: '',
      maxlength: [50, 'Reported party cannot exceed 50 characters'],
    },
    photoEvidence: [{ type: String, trim: true, default: '' }],
    dateFiled: { type: Date, required: true, default: Date.now },
    dateResolved: { type: Date, required: false },
    resolutionNotes: { type: String, trim: true, default: '' },
    resolutionDate: { type: Date, required: false },

    // Status management & audit trail fields
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
    resolutionNote: {
      type: String,
      trim: true,
      default: '',
      maxlength: [500, 'Resolution note cannot exceed 500 characters'],
    },
    reviewedAt: { type: Date, default: null },
    statusHistory: [
      {
        status: { type: String, required: true },
        changedBy: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
        changedAt: { type: Date, default: Date.now },
        note: { type: String, trim: true, default: '' },
      },
    ],
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const Complaint = model('Complaint', complaintSchema);

export default Complaint;
