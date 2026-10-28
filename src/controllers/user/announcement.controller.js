import mongoose from 'mongoose';
import AnnouncementModel from '../../models/announcement.model.js';
import { assertValidObjectId } from '../../utils/lessonAccess.js';

const CATEGORIES = ['general', 'academic', 'disciplinary', 'other'];
const SEVERITIES = ['low', 'medium', 'high'];
const TARGET_AUDIENCES = ['all', 'students', 'teachers', 'guardians', 'other'];

const ROLE_TO_AUDIENCE = {
    student: 'students',
    teacher: 'teachers',
    guardian: 'guardians',
};

const ALL_SPECIFIC_ROLES = ['students', 'teachers', 'guardians'];

/**
 * Checks whether an announcement is accessible to the user based on role and target audience.
 */
const canAccessAnnouncement = (announcement, user) => {
    if (!announcement || !user) return false;
    if (user.role === 'admin') return true;

    const audiences = (announcement.targetAudience || []).map((a) => String(a).toLowerCase());
    if (!audiences.length) return true;

    const roleAudience = ROLE_TO_AUDIENCE[user.role];

    // If announcement explicitly targets user's role (e.g. 'students' for student)
    if (roleAudience && audiences.includes(roleAudience)) {
        return true;
    }

    // If announcement targets 'all', it is visible as long as it does not target OTHER roles exclusively
    if (audiences.includes('all')) {
        const otherRoles = ALL_SPECIFIC_ROLES.filter((r) => r !== roleAudience);
        const targetsOtherRoles = audiences.some((r) => otherRoles.includes(r));
        if (!targetsOtherRoles) {
            return true;
        }
    }

    return false;
};

/**
 * Serializes an announcement document into a clean API response.
 */
const serializeAnnouncement = (announcement) => {
    if (!announcement) return null;
    const plain = typeof announcement.toObject === 'function' ? announcement.toObject() : { ...announcement };

    return {
        id: String(plain._id),
        _id: plain._id,
        title: plain.title || '',
        description: plain.description || '',
        category: plain.category || [],
        severity: plain.severity || [],
        targetAudience: plain.targetAudience || [],
        attachments: Array.isArray(plain.attachments) ? plain.attachments : [],
        createdBy: plain.createdBy ? String(plain.createdBy) : null,
        createdAt: plain.createdAt || null,
        updatedAt: plain.updatedAt || null,
    };
};

/**
 * GET /announcements
 * Lists announcements visible to the current user (filtered by user role and target audience).
 * Supports search, category, and severity filtering.
 */
export const getMyAnnouncements = async (req, res, next) => {
    try {
        const { search, category, severity, page, limit } = req.query;
        const filter = {};

        // Restrict to user's permitted target audience (or announcements created by this user)
        if (req.user?.role !== 'admin') {
            const roleAudience = ROLE_TO_AUDIENCE[req.user?.role];
            let audienceCondition;
            if (roleAudience) {
                const otherRoles = ALL_SPECIFIC_ROLES.filter((r) => r !== roleAudience);
                audienceCondition = {
                    $or: [
                        { targetAudience: roleAudience },
                        {
                            $and: [
                                { targetAudience: 'all' },
                                { targetAudience: { $nin: otherRoles } }
                            ]
                        }
                    ]
                };
            } else {
                audienceCondition = { targetAudience: 'all' };
            }

            if (req.user?._id) {
                filter.$or = [
                    audienceCondition,
                    { createdBy: req.user._id }
                ];
            } else {
                Object.assign(filter, audienceCondition);
            }
        }

        if (category) {
            const cat = String(category).toLowerCase().trim();
            if (CATEGORIES.includes(cat)) {
                filter.category = cat;
            }
        }

        if (severity) {
            const sev = String(severity).toLowerCase().trim();
            if (SEVERITIES.includes(sev)) {
                filter.severity = sev;
            }
        }

        if (search?.trim()) {
            const term = search.trim();
            const regex = new RegExp(
                term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                'i'
            );
            filter.$or = [{ title: regex }, { description: regex }];
        }

        let query = AnnouncementModel.find(filter).sort({ createdAt: -1 });

        if (limit && Number(limit) > 0) {
            const pageNum = Math.max(1, Number(page) || 1);
            const limitNum = Number(limit);
            query = query.skip((pageNum - 1) * limitNum).limit(limitNum);
        }

        const announcements = await query.lean();
        const serialized = announcements.map(serializeAnnouncement);

        res.json({
            count: serialized.length,
            announcements: serialized,
        });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ message: error.message });
        }
        next(error);
    }
};

/**
 * GET /announcements/:id
 * Fetches a single announcement by ID if accessible to the user.
 */
export const getMyAnnouncementById = async (req, res, next) => {
    try {
        const { id } = req.params;
        assertValidObjectId(id, 'announcement ID');

        const announcement = await AnnouncementModel.findById(id).lean();

        if (!announcement || !canAccessAnnouncement(announcement, req.user)) {
            return res.status(404).json({ message: 'Announcement not found' });
        }

        res.json({
            announcement: serializeAnnouncement(announcement),
        });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ message: error.message });
        }
        next(error);
    }
};

export {
    canAccessAnnouncement,
    serializeAnnouncement,
    CATEGORIES,
    SEVERITIES,
    TARGET_AUDIENCES,
};
