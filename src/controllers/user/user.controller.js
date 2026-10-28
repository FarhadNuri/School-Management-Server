import mongoose from 'mongoose';

import ComplaintModel from '../../models/complaint.model.js';
import StudentModel from '../../models/student.model.js';
import TeacherModel from '../../models/teacher.model.js';
import GuardianModel from '../../models/guardian.model.js';
import { UserModel } from '../../models/user.model.js';
import { uploadFiles, deleteFromCloudinaryMany } from '../../middleware/multer.middleware.js';

const CATEGORIES = [
    'bullying',
    'harassment',
    'cyberbullying',
    'discrimination',
    'other',
];

const SEVERITIES = ['low', 'medium', 'high'];

const toEnumArray = (value, allowed) => {
    if (value == null || value === '') return [];

    const items = Array.isArray(value) ? value : [value];

    return [
        ...new Set(
            items
                .map((item) => String(item).trim().toLowerCase())
                .filter((item) => allowed.includes(item))
        ),
    ];
};

const parseMaybeJson = (value) => {
    if (typeof value !== 'string') return value;

    const trimmed = value.trim();
    if (!trimmed) return value;

    if (
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
        try {
            return JSON.parse(trimmed);
        } catch {
            return value;
        }
    }

    return value;
};

const isObjectId = (value) => {
    if (!value) return false;
    const text = String(value).trim();
    return (
        mongoose.Types.ObjectId.isValid(text) &&
        String(new mongoose.Types.ObjectId(text)) === text
    );
};

const toPhotoArray = (value) => {
    if (value == null || value === '') return [];

    const parsed = parseMaybeJson(value);
    const items = Array.isArray(parsed) ? parsed : [parsed];

    return [
        ...new Set(
            items
                .map((item) => String(item).trim())
                .filter(Boolean)
        ),
    ];
};

const resolveReporterProfileId = async (user) => {
    if (!user?._id || !user.role) return null;

    if (user.role === 'student') {
        const student = await StudentModel.findOne({ user: user._id }).select('_id');
        return student?._id || null;
    }

    if (user.role === 'teacher') {
        const teacher = await TeacherModel.findOne({ user: user._id }).select('_id');
        return teacher?._id || null;
    }

    if (user.role === 'guardian') {
        const guardian = await GuardianModel.findOne({ user: user._id }).select('_id');
        return guardian?._id || null;
    }

    return null;
};

/* Student profile IDs linked to a guardian (wards). */
const resolveGuardianWardIds = async (user) => {
    if (!user?._id || user.role !== 'guardian') return [];

    const guardian = await GuardianModel.findOne({ user: user._id })
        .select('students')
        .lean();

    return (guardian?.students || [])
        .filter(Boolean)
        .map((id) => String(id));
};

const getPayload = (req) => {
    let payload = parseMaybeJson(req.body?.complaint);
    if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
        payload = req.body || {};
    }
    return payload;
};

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
        StudentModel.find({ _id: { $in: unique } })
            .populate('user', 'firstName lastName photo role')
            .lean(),
        TeacherModel.find({ _id: { $in: unique } })
            .lean(),
        GuardianModel.find({ _id: { $in: unique } })
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

const collectPersonIds = (complaints = []) => {
    const ids = [];

    for (const complaint of complaints) {
        if (complaint.reporter) ids.push(complaint.reporter);
    }

    return ids;
};

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

const userCanAccessComplaint = (
    complaint,
    profileId,
    userComplaintIds,
    wardIds = [],
) => {
    const complaintId = String(complaint._id);
    if (userComplaintIds.has(complaintId)) return true;

    const reporterId = String(complaint.reporter || '');
    if (profileId && reporterId === String(profileId)) return true;

    if (wardIds.length > 0 && wardIds.includes(reporterId)) return true;

    return false;
};

export const makeComplaint = async (req, res, next) => {
    const uploadedUrls = [];
    try {
        const payload = getPayload(req);

        const title = String(payload.title || '').trim();
        const description = String(payload.description || '').trim();
        const categories = toEnumArray(payload.category, CATEGORIES);
        const severities = toEnumArray(payload.severity, SEVERITIES);
        const reportedParty = normalizeFreeText(payload.reportedParty, 50);
        const witnesses = normalizeFreeText(payload.witnesses, 200);

        if (!title) {
            return res.status(400).json({ message: 'Title is required' });
        }

        if (title.length > 50) {
            return res.status(400).json({ message: 'Title cannot exceed 50 characters' });
        }

        if (description.length > 500) {
            return res.status(400).json({
                message: 'Description cannot exceed 500 characters',
            });
        }

        if (!categories.length) {
            return res.status(400).json({ message: 'Valid category is required' });
        }

        if (!severities.length) {
            return res.status(400).json({ message: 'Valid severity is required' });
        }

        if (!reportedParty) {
            return res.status(400).json({
                message: 'Reported party is required',
            });
        }

        if (reportedParty.length > 50) {
            return res.status(400).json({
                message: 'Reported party cannot exceed 50 characters',
            });
        }

        if (witnesses.length > 200) {
            return res.status(400).json({
                message: 'Witnesses cannot exceed 200 characters',
            });
        }

        const reporter = await resolveReporterProfileId(req.user);
        if (!reporter) {
            return res.status(400).json({
                message: 'Reporter profile not found for this account',
            });
        }

        const uploaded = await uploadFiles(req.files, 'complaints');
        uploadedUrls.push(...Object.values(uploaded).filter(Boolean));

        const photoEvidence = [
            ...toPhotoArray(payload.photoEvidence),
            ...(uploaded.photoEvidence ? [uploaded.photoEvidence] : []),
        ];

        const complaint = await ComplaintModel.create({
            title,
            description,
            category: categories,
            severity: severities,
            status: ['pending'],
            reporter,
            reportedParty,
            witnesses,
            photoEvidence,
            dateFiled: new Date(),
        });

        await UserModel.findByIdAndUpdate(req.user._id, {
            $addToSet: { complaints: complaint._id },
        });

        uploadedUrls.length = 0;

        res.status(201).json({
            message: 'Complaint filed successfully',
            complaint,
        });
    } catch (error) {
        await deleteFromCloudinaryMany(uploadedUrls);
        next(error);
    }
};

export const getComplaints = async (req, res, next) => {
    try {
        const [profileId, wardIds] = await Promise.all([
            resolveReporterProfileId(req.user),
            resolveGuardianWardIds(req.user),
        ]);
        const userComplaintIds = (req.user.complaints || []).map(String);

        const orFilters = [];
        if (userComplaintIds.length) {
            orFilters.push({ _id: { $in: userComplaintIds } });
        }
        if (profileId) {
            orFilters.push({ reporter: profileId });
        }
        if (wardIds.length) {
            orFilters.push({ reporter: { $in: wardIds } });
        }

        const complaints = orFilters.length
            ? await ComplaintModel.find({ $or: orFilters }).sort({
                dateFiled: -1,
                createdAt: -1,
            })
            : [];

        const peopleMap = await hydratePeopleByIds(collectPersonIds(complaints));
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

export const getComplaintById = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!isObjectId(id)) {
            return res.status(400).json({ message: 'Invalid complaint ID' });
        }

        const complaint = await ComplaintModel.findById(id);
        if (!complaint) {
            return res.status(404).json({ message: 'Complaint not found' });
        }

        const [profileId, wardIds] = await Promise.all([
            resolveReporterProfileId(req.user),
            resolveGuardianWardIds(req.user),
        ]);
        const userComplaintIds = new Set(
            (req.user.complaints || []).map(String)
        );

        if (
            !userCanAccessComplaint(
                complaint,
                profileId,
                userComplaintIds,
                wardIds,
            )
        ) {
            return res.status(403).json({
                message: 'You do not have access to this complaint',
            });
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


export const updateComplaint = async (req, res, next) => {
    const uploadedUrls = [];
    try {
        const { id } = req.params;

        if (!isObjectId(id)) {
            return res.status(400).json({ message: 'Invalid complaint ID' });
        }

        const complaint = await ComplaintModel.findById(id);
        if (!complaint) {
            return res.status(404).json({ message: 'Complaint not found' });
        }

        const payload = getPayload(req);

        if (payload.title != null) {
            const title = String(payload.title).trim();
            if (!title) {
                return res.status(400).json({ message: 'Title is required' });
            }
            if (title.length > 50) {
                return res.status(400).json({
                    message: 'Title cannot exceed 50 characters',
                });
            }
            complaint.title = title;
        }

        if (payload.description != null) {
            const description = String(payload.description).trim();
            if (description.length > 500) {
                return res.status(400).json({
                    message: 'Description cannot exceed 500 characters',
                });
            }
            complaint.description = description;
        }

        if (payload.category != null) {
            const categories = toEnumArray(payload.category, CATEGORIES);
            if (!categories.length) {
                return res.status(400).json({
                    message: 'Valid category is required',
                });
            }
            complaint.category = categories;
        }

        if (payload.severity != null) {
            const severities = toEnumArray(payload.severity, SEVERITIES);
            if (!severities.length) {
                return res.status(400).json({
                    message: 'Valid severity is required',
                });
            }
            complaint.severity = severities;
        }

        // Status and resolution are managed by admin only.
        if (payload.reportedParty != null) {
            const reportedParty = normalizeFreeText(payload.reportedParty, 50);
            if (!reportedParty) {
                return res.status(400).json({
                    message: 'Reported party is required',
                });
            }
            if (reportedParty.length > 50) {
                return res.status(400).json({
                    message: 'Reported party cannot exceed 50 characters',
                });
            }
            complaint.reportedParty = reportedParty;
        }

        if (payload.witnesses != null) {
            const witnesses = normalizeFreeText(payload.witnesses, 200);
            if (witnesses.length > 200) {
                return res.status(400).json({
                    message: 'Witnesses cannot exceed 200 characters',
                });
            }
            complaint.witnesses = witnesses;
        }

        const uploaded = await uploadFiles(req.files, 'complaints');
        uploadedUrls.push(...Object.values(uploaded).filter(Boolean));

        if (uploaded.photoEvidence) {
            complaint.photoEvidence = [
                ...(complaint.photoEvidence || []),
                uploaded.photoEvidence,
            ];
        }

        await complaint.save();
        uploadedUrls.length = 0;

        res.json({
            message: 'Complaint updated successfully',
            complaint,
        });
    } catch (error) {
        await deleteFromCloudinaryMany(uploadedUrls);
        next(error);
    }
};