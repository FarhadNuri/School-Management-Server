import { Schema, model } from 'mongoose';

const assessmentSchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ['quiz', 'class_test', 'assignment', 'attendance', 'mid_term', 'final_term', 'other'],
      default: 'quiz'
    },
    maxMarks: { type: Number, required: true, min: 1, default: 100 },
    date: { type: Date, default: Date.now }
  },
  { _id: false }
);

const studentGradeSchema = new Schema(
  {
    student: { type: Schema.Types.ObjectId, ref: 'Student', required: true },
    scores: { type: Map, of: Number, default: {} },
    remarks: { type: String, default: '' }
  },
  { _id: false }
);

const gradebookSchema = new Schema(
  {
    class: { type: Schema.Types.ObjectId, ref: 'Class', required: true },
    teacher: { type: Schema.Types.ObjectId, ref: 'Teacher', required: true },
    course: { type: Schema.Types.ObjectId, ref: 'Course', default: null },
    subject: { type: String, default: 'Bangla First' },
    courseCode: { type: String, default: 'BN 101' },
    academicYear: { type: String, default: '' },
    assessments: [assessmentSchema],
    grades: [studentGradeSchema],
    isPublished: { type: Boolean, default: false },
    status: { type: String, enum: ['draft', 'published'], default: 'draft' },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

gradebookSchema.index({ class: 1, teacher: 1, subject: 1 });
gradebookSchema.index({ class: 1, isPublished: 1 });

const Gradebook = model('Gradebook', gradebookSchema);

export default Gradebook;
