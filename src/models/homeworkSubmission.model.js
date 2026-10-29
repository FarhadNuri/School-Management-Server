import { Schema, model } from 'mongoose';

const homeworkSubmissionSchema = new Schema(
  {
    homework: {
      type: Schema.Types.ObjectId,
      ref: 'Homework',
      required: true,
      index: true,
    },
    student: {
      type: Schema.Types.ObjectId,
      ref: 'Student',
      required: true,
      index: true,
    },
    class: {
      type: Schema.Types.ObjectId,
      ref: 'Class',
      required: true,
    },
    link: {
      type: String,
      trim: true,
      default: '',
    },
    fileUrl: {
      type: String,
      default: '',
    },
    fileName: {
      type: String,
      default: '',
    },
    fileType: {
      type: String,
      default: '',
    },
    fileSize: {
      type: Number,
      default: 0,
    },
    comment: {
      type: String,
      trim: true,
      default: '',
      maxlength: 1000,
    },
    status: {
      type: String,
      enum: ['submitted', 'graded', 'returned'],
      default: 'submitted',
    },
    submittedAt: {
      type: Date,
      default: Date.now,
    },
    resubmittedAt: {
      type: Date,
    },
    isResubmitted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

homeworkSubmissionSchema.index({ homework: 1, student: 1 }, { unique: true });

const HomeworkSubmission = model('HomeworkSubmission', homeworkSubmissionSchema);
export default HomeworkSubmission;
