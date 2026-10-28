import Class from "../../models/class.model.js";
import Student from "../../models/student.model.js";
import Teacher from "../../models/teacher.model.js";
import Guardian from "../../models/guardian.model.js";
import User from "../../models/user.model.js";
import Admin from "../../models/admin.model.js";
import {uploadFiles, deleteFromCloudinaryMany} from '../../middleware/multer.middleware.js'
import ENV from "../../config/env.js";  
import mongoose from "mongoose";
import Complaint from "../../models/complaint.model.js";

const ALLOWED_STATUSES = ['pending', 'under_review', 'in_progress', 'resolved'];

const STATUS_LABELS = {
    pending: 'Open',
    under_review: 'Under review',
    in_progress: 'Under review',
    resolved: 'Resolved',
};

const getStatusValue = (status) => {
    if (Array.isArray(status)) return status[0] || 'pending';
    return status || 'pending';
};


const isObjectId = (value) => {
    if (!value) return false;
    const text = String(value).trim();
    return (
        mongoose.Types.ObjectId.isValid(text) &&
        String(new mongoose.Types.ObjectId(text)) === text
    );
};

// Shape a student / teacher / guardian profile into the person object used
// in serialized complaints (id, role, display name, photo).
const toPerson = (profile, role) => {
    if (!profile) return null;

    const user =
        profile.user && typeof profile.user === 'object' ? profile.user : {};
    const name = `${user.firstName || ''} ${user.lastName || ''}`.trim();

    return {
        id: String(profile._id),
        _id: profile._id,
        role,
        name: name || 'Unknown',
        photo: user.photo || '',
    };
};

// Look up unique person IDs across Student, Teacher, and Guardian, then
// return a Map of id → toPerson() so list/detail can attach reporter info.
const hydratePeopleByIds = async (ids = []) => {
    const unique = [
        ...new Set(
            ids
                .map((id) => String(id || '').trim())
                .filter((id) => isObjectId(id))
        ),
    ];

    const peopleMap = new Map();
    if (!unique.length) return peopleMap;

    const [students, teachers, guardians] = await Promise.all([
        Student.find({ _id: { $in: unique } })
            .populate('user', 'firstName lastName photo role')
            .lean(),
        Teacher.find({ _id: { $in: unique } })
            .populate('user', 'firstName lastName photo role')
            .lean(),
        Guardian.find({ _id: { $in: unique } })
            .populate('user', 'firstName lastName photo role')
            .lean(),
    ]);

    for (const student of students) {
        peopleMap.set(String(student._id), toPerson(student, 'student'));
    }
    for (const teacher of teachers) {
        peopleMap.set(String(teacher._id), toPerson(teacher, 'teacher'));
    }
    for (const guardian of guardians) {
        peopleMap.set(String(guardian._id), toPerson(guardian, 'guardian'));
    }

    return peopleMap;
};

// Resolve a stored person id through the hydrated Map. Falls back to an
// "Unknown" stub if the profile was deleted or not found.
const mapPerson = (id, peopleMap) => {
    if (!id) return null;
    const key = String(id);
    return (
        peopleMap.get(key) || {
            id: key,
            _id: key,
            role: 'unknown',
            name: 'Unknown',
            photo: '',
        }
    );
};

// Gather reporter IDs from a complaint list so hydratePeopleByIds can
// fetch them in one batch for getComplaints / getComplaintById.
const collectPersonIds = (complaints = []) => {
    const ids = [];

    for (const complaint of complaints) {
        if (complaint.reporter) ids.push(complaint.reporter);
    }

    return ids;
};

// Flatten reportedParty / witnesses into a trimmed string for the API.
// Accepts a string, array, or object and caps length so responses stay tidy.
const normalizeFreeText = (value, maxLength = 50) => {
    if (value == null) return '';

    if (typeof value === 'string') {
        return value.trim().slice(0, maxLength);
    }

    if (Array.isArray(value)) {
        return value
            .map((item) => {
                if (typeof item === 'string') return item.trim();
                if (item && typeof item === 'object') {
                    return String(item.name || item._id || item.id || '').trim();
                }
                return String(item || '').trim();
            })
            .filter(Boolean)
            .join(', ')
            .slice(0, maxLength);
    }

    if (typeof value === 'object') {
        return String(value.name || value._id || value.id || '')
            .trim()
            .slice(0, maxLength);
    }

    return String(value).trim().slice(0, maxLength);
};

const serializeComplaint = (complaint, peopleMap) => {
    const plain =
        typeof complaint.toObject === 'function'
            ? complaint.toObject()
            : { ...complaint };

    const statusVal = getStatusValue(plain.status);
    const statusLabel = STATUS_LABELS[statusVal] || 'Open';

    return {
        ...plain,
        statusLabel,
        'status label': statusLabel,
        resolvedAt: plain.resolvedAt || null,
        resolutionNote: plain.resolutionNote || plain.resolutionNotes || '',
        statusHistory: plain.statusHistory || [],
        reporter: mapPerson(plain.reporter, peopleMap),
        reportedParty: normalizeFreeText(plain.reportedParty, 50),
        witnesses: normalizeFreeText(plain.witnesses, 200),
    };
};

const getComplaints = async (req, res, next) => {
  try {
    const complaints = await Complaint.find()
      .sort({ dateFiled: -1, createdAt: -1 })
      .lean();

    // id → person lookup for every reporter on this page (one batch fetch).
    const peopleMap = await hydratePeopleByIds(collectPersonIds(complaints));
    // Complaints ready for the API: reporter is a person object, not a raw id.
    const serialized = complaints.map((complaint) =>
      serializeComplaint(complaint, peopleMap)
    );

    res.json({
      message: 'Complaints fetched successfully',
      complaints: serialized,
    });
  } catch (error) {
    next(error);
  }
};

const getComplaintById = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid complaint ID' });
    }

    const complaint = await Complaint.findById(id)
      .populate('statusHistory.changedBy', 'firstName lastName')
      .lean();
    if (!complaint || complaint.isDeleted) {
      return res.status(404).json({ message: 'Complaint not found' });
    }

    const peopleMap = await hydratePeopleByIds(collectPersonIds([complaint]));

    res.json({
      message: 'Complaint fetched successfully',
      complaint: serializeComplaint(complaint, peopleMap),
    });
  } catch (error) {
    next(error);
  }
};

const updateComplaintStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, resolutionNote } = req.body;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid complaint ID' });
    }

    const complaint = await Complaint.findById(id);
    if (!complaint || complaint.isDeleted) {
      return res.status(404).json({ message: 'Complaint not found' });
    }

    if (!status || typeof status !== 'string') {
      return res.status(400).json({
        message: 'Valid status is required. Allowed values: pending, under_review, resolved',
      });
    }

    const normalizedStatus = status.trim().toLowerCase();
    if (!ALLOWED_STATUSES.includes(normalizedStatus)) {
      return res.status(400).json({
        message: 'Invalid status. Allowed values: pending, under_review, resolved',
      });
    }

    const currentStatus = getStatusValue(complaint.status);
    const isSameStatus =
      currentStatus === normalizedStatus ||
      (['under_review', 'in_progress'].includes(currentStatus) &&
        ['under_review', 'in_progress'].includes(normalizedStatus));

    if (isSameStatus) {
      return res.status(400).json({
        message: `Complaint is already ${currentStatus}`,
      });
    }

    if (
      resolutionNote !== undefined &&
      resolutionNote !== null &&
      typeof resolutionNote === 'string' &&
      resolutionNote.length > 500
    ) {
      return res.status(400).json({
        message: 'Resolution note cannot exceed 500 characters',
      });
    }

    const noteText =
      resolutionNote !== undefined && resolutionNote !== null
        ? String(resolutionNote).trim()
        : '';

    if (normalizedStatus === 'resolved') {
      const now = new Date();
      complaint.resolvedAt = now;
      complaint.dateResolved = now;
      complaint.resolutionDate = now;
      complaint.resolvedBy = req.admin?._id || null;
      if (resolutionNote !== undefined) {
        complaint.resolutionNote = noteText;
        complaint.resolutionNotes = noteText;
      }
    } else if (normalizedStatus === 'under_review' || normalizedStatus === 'in_progress') {
      complaint.reviewedAt = new Date();
      complaint.resolvedAt = null;
      complaint.dateResolved = null;
      complaint.resolutionDate = null;
      complaint.resolvedBy = null;
      if (resolutionNote !== undefined) {
        complaint.resolutionNote = noteText;
        complaint.resolutionNotes = noteText;
      }
    } else if (normalizedStatus === 'pending') {
      complaint.resolvedAt = null;
      complaint.dateResolved = null;
      complaint.resolutionDate = null;
      complaint.resolvedBy = null;
      complaint.resolutionNote = '';
      complaint.resolutionNotes = '';
    }

    complaint.status = [normalizedStatus];

    if (!Array.isArray(complaint.statusHistory)) {
      complaint.statusHistory = [];
    }

    complaint.statusHistory.push({
      status: normalizedStatus,
      changedBy: req.admin?._id || null,
      changedAt: new Date(),
      note: noteText,
    });

    await complaint.save();

    const savedComplaint = await Complaint.findById(complaint._id)
      .populate('statusHistory.changedBy', 'firstName lastName')
      .lean();

    const peopleMap = await hydratePeopleByIds(collectPersonIds([savedComplaint]));

    res.json({
      message: 'Complaint status updated',
      complaint: serializeComplaint(savedComplaint, peopleMap),
    });
  } catch (error) {
    next(error);
  }
};

export { getComplaints, getComplaintById, updateComplaintStatus, serializeComplaint };

export const deleteComplaint = async (req, res) => {
  try {
    const { id } = req.params;
    const complaint = await ComplaintModel.findById(id);
    if (!complaint) {
      return res.status(404).json({ success: false, message: 'Complaint not found' });
    }

    if (complaint.attachment) {
      try {
        const publicId = getPublicIdFromUrl(complaint.attachment);
        if (publicId) await deleteImageFromCloudinary(publicId);
      } catch (e) {
        console.error('Error deleting complaint attachment from cloudinary:', e);
      }
    }

    await ComplaintModel.findByIdAndDelete(id);
    return res.status(200).json({ success: true, message: 'Complaint deleted successfully' });
  } catch (error) {
    console.error('Error in deleteComplaint:', error);
    return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
};
