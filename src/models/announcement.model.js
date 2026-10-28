import { Schema, model } from "mongoose"

const announcementSchema = new Schema({
    title: { type: String, required: true, trim: true, maxlength: [50, 'Title cannot exceed 50 characters'] },
    description: { type: String, trim: true, default: '', maxlength: [1000, 'Description cannot exceed 1000 characters'] },
    category: [{ type: String, enum: ['general', 'academic', 'disciplinary', 'other'] }],
    severity: [{ type: String, enum: ['low', 'medium', 'high'] }],
    targetAudience: [{ type: String, enum: ['all', 'students', 'teachers', 'guardians', 'other'] }],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    attachments: [{ type: String }],
}, { timestamps: true });


const Announcement = model('Announcement', announcementSchema)

export default Announcement