import { Schema, model } from 'mongoose';
import { ID_TYPES } from '../utils/idTypes.js';

const guardianSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    students: [{ type: Schema.Types.ObjectId, ref: 'Student' }],
    idType: {
      type: String,
      required: true,
      enum: ID_TYPES,
      default: 'National ID',
    },
    idPhoto: { type: String, default: '' },
    identification: {
      front: { type: String, default: '' },
      back: { type: String, default: '' },
    },
    stripeCustomerId: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

const Guardian = model('Guardian', guardianSchema);

export default Guardian;
