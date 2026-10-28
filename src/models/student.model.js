import { Schema, model } from 'mongoose';
import { ID_TYPES } from '../utils/idTypes.js';

const studentSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    idType: {
      type: String,
      required: true,
      enum: ID_TYPES,
      default: 'National ID',
    },
    // Legacy single-document field; prefer identification.front/back
    idPhoto: { type: String, default: '' },
    identification: {
      front: { type: String, default: '' },
      back: { type: String, default: '' },
    },
    class: { type: Schema.Types.ObjectId, ref: 'Class' },
    guardian: { type: Schema.Types.ObjectId, ref: 'Guardian' },
    emergencyContact: {
      type: String,
      required: true,
      trim: true,
      maxlength: [20, 'Emergency contact must be less than 20 characters'],
    },
    assignments: [{ type: Schema.Types.ObjectId, ref: 'Assignment' }],
    announcements: [{ type: Schema.Types.ObjectId, ref: 'Announcement' }],
    events: [{ type: Schema.Types.ObjectId, ref: 'Event' }],
    resources: [{ type: Schema.Types.ObjectId, ref: 'Resource' }],
    exams: [{ type: Schema.Types.ObjectId, ref: 'Exam' }],
    quizzes: [{ type: Schema.Types.ObjectId, ref: 'Quiz' }],
  },
  { timestamps: true }
);

const Student= model('Student', studentSchema);

export default Student;
