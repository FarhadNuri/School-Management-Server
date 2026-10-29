import { Schema, model } from 'mongoose';

const periodSchema = new Schema(
  {
    periodNumber: { type: Number, required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    subject: { type: String, default: '' },
    teacherName: { type: String, default: '' },
    teacher: { type: Schema.Types.ObjectId, ref: 'Teacher', default: null },
    sectionName: { type: String, default: '' },
    class: { type: Schema.Types.ObjectId, ref: 'Class', default: null },
    room: { type: String, default: '' },
  },
  { _id: false }
);

const dayScheduleSchema = new Schema(
  {
    day: {
      type: String,
      enum: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      required: true,
    },
    periods: [periodSchema],
  },
  { _id: false }
);

const routineSchema = new Schema(
  {
    type: {
      type: String,
      enum: ['class', 'teacher'],
      required: true,
      index: true,
    },
    class: {
      type: Schema.Types.ObjectId,
      ref: 'Class',
      default: null,
      index: true,
    },
    teacher: {
      type: Schema.Types.ObjectId,
      ref: 'Teacher',
      default: null,
      index: true,
    },
    title: {
      type: String,
      required: true,
    },
    academicYear: {
      type: String,
      default: '2025/2026',
    },
    schedule: [dayScheduleSchema],
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

const Routine = model('Routine', routineSchema);
export default Routine;
