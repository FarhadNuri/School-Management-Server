import mongoose from 'mongoose';
import Announcement from '../../models/announcement.model.js';
import {
  CATEGORIES,
  SEVERITIES,
  TARGET_AUDIENCES,
  serializeAnnouncement
} from '../user/announcement.controller.js';
import {
  uploadFileList,
  deleteFromCloudinaryMany
} from '../../middleware/multer.middleware.js';

const toEnumArray = (value, allowed) => {
  if (value == null || value === '') return [];
  const items = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      items
        .map((item) => String(item).trim().toLowerCase())
        .filter((item) => allowed.includes(item))
    )
  ];
};

/**
 * POST /api/teacher/announcements
 * Creates a new announcement authored by the authenticated teacher, with optional file attachments.
 */
export const createTeacherAnnouncement = async (req, res, next) => {
  try {
    const { title, description, category, severity, targetAudience } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ message: 'Title is required' });
    }

    if (title.trim().length > 50) {
      return res.status(400).json({ message: 'Title cannot exceed 50 characters' });
    }

    const categories = toEnumArray(category || 'general', CATEGORIES);
    const severities = toEnumArray(severity || 'medium', SEVERITIES);
    let audiences = toEnumArray(targetAudience || 'all', TARGET_AUDIENCES);

    if (!categories.length) {
      return res.status(400).json({ message: 'Valid category is required' });
    }

    if (!severities.length) {
      return res.status(400).json({ message: 'Valid severity is required' });
    }

    if (!audiences.length) {
      audiences = ['all'];
    }

    if (audiences.length > 1 && audiences.includes('all')) {
      audiences = audiences.filter((item) => item !== 'all');
    }

    if (description && description.trim().length > 1000) {
      return res.status(400).json({ message: 'Description cannot exceed 1000 characters' });
    }

    // Upload any attached files to Cloudinary (under announcements folder)
    let attachments = [];
    if (req.files && req.files.length > 0) {
      attachments = await uploadFileList(req.files, 'announcements');
    }

    const announcement = await Announcement.create({
      title: title.trim(),
      description: description?.trim() || '',
      category: categories,
      severity: severities,
      targetAudience: audiences,
      attachments,
      createdBy: req.user?._id
    });

    res.status(201).json({
      message: 'Announcement created successfully',
      announcement: serializeAnnouncement(announcement)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/teacher/announcements
 * Retrieves announcements visible to the teacher or created by the teacher.
 */
export const getTeacherAnnouncements = async (req, res, next) => {
  try {
    const { search, category, severity, page, limit } = req.query;

    const teacherAudienceCondition = {
      $or: [
        { targetAudience: 'teachers' },
        {
          $and: [
            { targetAudience: 'all' },
            { targetAudience: { $nin: ['students', 'guardians'] } }
          ]
        }
      ]
    };

    const visibilityCondition = req.user?._id
      ? {
        $or: [teacherAudienceCondition, { createdBy: req.user._id }]
      }
      : teacherAudienceCondition;

    const filter = { ...visibilityCondition };

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
      filter.$and = [
        visibilityCondition,
        { $or: [{ title: { $regex: term, $options: 'i' } }, { description: { $regex: term, $options: 'i' } }] }
      ];
      delete filter.$or;
    }

    let query = Announcement.find(filter).sort({ createdAt: -1 });

    if (limit && Number(limit) > 0) {
      const pageNum = Math.max(1, Number(page) || 1);
      const limitNum = Number(limit);
      query = query.skip((pageNum - 1) * limitNum).limit(limitNum);
    }

    const announcements = await query.lean();
    const serialized = announcements.map(serializeAnnouncement);

    res.json({
      count: serialized.length,
      announcements: serialized
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/teacher/announcements/:id
 * Updates an announcement authored by the authenticated teacher.
 */
export const updateTeacherAnnouncement = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid announcement ID' });
    }

    const announcement = await Announcement.findById(id);
    if (!announcement) {
      return res.status(404).json({ message: 'Announcement not found' });
    }

    // Verify ownership: only the creator can edit
    if (String(announcement.createdBy) !== String(req.user?._id)) {
      return res.status(403).json({ message: 'You are only permitted to edit announcements you created.' });
    }

    const { title, description, category, severity, targetAudience, existingAttachments } = req.body;

    if (title !== undefined) {
      if (!title.trim()) {
        return res.status(400).json({ message: 'Title cannot be empty' });
      }
      if (title.trim().length > 50) {
        return res.status(400).json({ message: 'Title cannot exceed 50 characters' });
      }
      announcement.title = title.trim();
    }

    if (description !== undefined) {
      if (description.trim().length > 1000) {
        return res.status(400).json({ message: 'Description cannot exceed 1000 characters' });
      }
      announcement.description = description.trim();
    }

    if (category !== undefined) {
      const cats = toEnumArray(category, CATEGORIES);
      if (cats.length) announcement.category = cats;
    }

    if (severity !== undefined) {
      const sevs = toEnumArray(severity, SEVERITIES);
      if (sevs.length) announcement.severity = sevs;
    }

    if (targetAudience !== undefined) {
      let auds = toEnumArray(targetAudience, TARGET_AUDIENCES);
      if (auds.length > 1 && auds.includes('all')) {
        auds = auds.filter((item) => item !== 'all');
      }
      if (auds.length) announcement.targetAudience = auds;
    }

    // Parse kept existing attachments
    let keptAttachments = [];
    if (existingAttachments !== undefined) {
      try {
        const parsed = typeof existingAttachments === 'string' ? JSON.parse(existingAttachments) : existingAttachments;
        keptAttachments = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        keptAttachments = Array.isArray(existingAttachments) ? existingAttachments : [existingAttachments];
      }
    } else {
      keptAttachments = announcement.attachments || [];
    }

    // Upload newly provided files
    let newlyUploaded = [];
    if (req.files && req.files.length > 0) {
      newlyUploaded = await uploadFileList(req.files, 'announcements');
    }

    // Delete removed attachments from Cloudinary
    const removedAttachments = (announcement.attachments || []).filter((oldUrl) => !keptAttachments.includes(oldUrl));
    if (removedAttachments.length > 0) {
      deleteFromCloudinaryMany(removedAttachments).catch((err) =>
        console.error('Failed to delete removed announcement attachments from Cloudinary:', err)
      );
    }

    announcement.attachments = [...keptAttachments, ...newlyUploaded];
    await announcement.save();

    res.status(200).json({
      message: 'Announcement updated successfully',
      announcement: serializeAnnouncement(announcement)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/teacher/announcements/:id
 * Deletes an announcement authored by the authenticated teacher.
 */
export const deleteTeacherAnnouncement = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid announcement ID' });
    }

    const announcement = await Announcement.findById(id);
    if (!announcement) {
      return res.status(404).json({ message: 'Announcement not found' });
    }

    // Verify ownership: only the creator can delete
    if (String(announcement.createdBy) !== String(req.user?._id)) {
      return res.status(403).json({ message: 'You are only permitted to delete announcements you created.' });
    }

    // Clean up attachments from Cloudinary
    if (announcement.attachments && announcement.attachments.length > 0) {
      deleteFromCloudinaryMany(announcement.attachments).catch((err) =>
        console.error('Failed to delete announcement attachments from Cloudinary:', err)
      );
    }

    await Announcement.findByIdAndDelete(id);

    res.status(200).json({
      message: 'Announcement deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};
