import mongoose from 'mongoose';
import GradebookModel from '../../models/gradebook.model.js';
import ClassModel from '../../models/class.model.js';
import StudentModel from '../../models/student.model.js';
import '../../models/teacher.model.js';
import '../../models/user.model.js';
import { assertValidObjectId } from '../../utils/lessonAccess.js';
import { loadClassStudents } from '../../utils/examAccess.js';

// GET /api/admin/grades
export const getAdminGradebooks = async (req, res, next) => {
  try {
    const { classId, status, search } = req.query;
    const filter = {};

    if (classId && classId !== 'all') {
      assertValidObjectId(classId, 'class ID');
      filter.class = classId;
    }

    if (status && status !== 'all') {
      if (status === 'published') filter.isPublished = true;
      else if (status === 'draft') filter.isPublished = false;
    }

    const gradebooks = await GradebookModel.find(filter)
      .populate('class', 'className classCode grade academicYear')
      .populate({
        path: 'teacher',
        select: 'user',
        populate: {
          path: 'user',
          select: 'firstName lastName email photo'
        }
      })
      .sort({ updatedAt: -1 })
      .lean();

    const formatted = gradebooks.map((g) => {
      const teacherUser = g.teacher?.user || {};
      const teacherName = `${teacherUser.firstName || ''} ${teacherUser.lastName || ''}`.trim() || 'Assigned Teacher';

      return {
        id: g._id,
        _id: g._id,
        classId: g.class?._id || g.class,
        className: g.class?.className || 'Class',
        classCode: g.class?.classCode || '',
        grade: g.class?.grade || '',
        teacherId: g.teacher?._id,
        teacherName,
        teacherEmail: teacherUser.email || '',
        subject: g.subject || 'Subject',
        courseCode: g.courseCode || '',
        academicYear: g.academicYear || '',
        assessmentsCount: g.assessments?.length || 0,
        studentsCount: g.grades?.length || 0,
        isPublished: Boolean(g.isPublished),
        status: g.isPublished ? 'published' : 'draft',
        publishedAt: g.publishedAt || null,
        updatedAt: g.updatedAt,
        createdAt: g.createdAt
      };
    });

    let result = formatted;
    if (search?.trim()) {
      const q = search.toLowerCase().trim();
      result = result.filter(
        (r) =>
          r.className.toLowerCase().includes(q) ||
          r.subject.toLowerCase().includes(q) ||
          r.courseCode.toLowerCase().includes(q) ||
          r.teacherName.toLowerCase().includes(q)
      );
    }

    res.json({
      count: result.length,
      gradebooks: result
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/grades/:id
export const getAdminGradebookById = async (req, res, next) => {
  try {
    const { id } = req.params;
    assertValidObjectId(id, 'gradebook ID');

    const gradebook = await GradebookModel.findById(id)
      .populate('class', 'className classCode grade academicYear')
      .populate({
        path: 'teacher',
        select: 'user',
        populate: {
          path: 'user',
          select: 'firstName lastName email photo'
        }
      })
      .lean();

    if (!gradebook) {
      return res.status(404).json({ message: 'Gradebook not found' });
    }

    const students = await loadClassStudents(gradebook.class?._id || gradebook.class);

    // Index saved grades
    const savedGradesMap = new Map();
    if (gradebook.grades) {
      for (const g of gradebook.grades) {
        const sId = String(g.student?._id || g.student || '');
        if (sId) {
          const scoresObj =
            g.scores instanceof Map
              ? Object.fromEntries(g.scores)
              : g.scores && typeof g.scores === 'object'
              ? g.scores
              : {};
          savedGradesMap.set(sId, {
            scores: scoresObj,
            remarks: g.remarks || ''
          });
        }
      }
    }

    const studentList = students.map((s) => {
      const sId = String(s._id || s.id);
      const user = s.user || {};
      const saved = savedGradesMap.get(sId);
      const name = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Student';
      const photo = typeof user.photo === 'string' ? user.photo : user.photo?.url || '';

      return {
        studentId: sId,
        id: sId,
        _id: sId,
        name,
        email: user.email || '',
        photo,
        scores: saved?.scores || {},
        remarks: saved?.remarks || ''
      };
    });

    const teacherUser = gradebook.teacher?.user || {};
    const teacherName = `${teacherUser.firstName || ''} ${teacherUser.lastName || ''}`.trim() || 'Assigned Teacher';

    res.json({
      gradebook: {
        id: gradebook._id,
        _id: gradebook._id,
        class: gradebook.class,
        teacher: {
          id: gradebook.teacher?._id,
          name: teacherName,
          email: teacherUser.email || ''
        },
        subject: gradebook.subject || 'Subject',
        courseCode: gradebook.courseCode || '',
        academicYear: gradebook.academicYear || '',
        isPublished: Boolean(gradebook.isPublished),
        status: gradebook.isPublished ? 'published' : 'draft',
        publishedAt: gradebook.publishedAt,
        assessments: gradebook.assessments || [],
        students: studentList
      }
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    next(error);
  }
};

// PUT /api/admin/grades/:id
export const updateAdminGradebook = async (req, res, next) => {
  try {
    const { id } = req.params;
    assertValidObjectId(id, 'gradebook ID');

    const gradebook = await GradebookModel.findById(id);
    if (!gradebook) {
      return res.status(404).json({ message: 'Gradebook not found' });
    }

    const { assessments = [], grades = [], subject, courseCode } = req.body || {};

    const cleanedAssessments = (Array.isArray(assessments) ? assessments : []).map((a, idx) => ({
      id: String(a.id || `asmt_${idx + 1}`),
      name: String(a.name || `Assessment ${idx + 1}`).trim().slice(0, 100),
      type: ['quiz', 'class_test', 'assignment', 'attendance', 'mid_term', 'final_term', 'other'].includes(a.type)
        ? a.type
        : 'quiz',
      maxMarks: Math.max(1, Number(a.maxMarks) || 100),
      date: a.date ? new Date(a.date) : new Date()
    }));

    const cleanedGrades = (Array.isArray(grades) ? grades : [])
      .map((g) => {
        const studentId = String(g.studentId || g.student || g.id || '');
        const rawScores = g.scores && typeof g.scores === 'object' ? g.scores : {};
        const scoresMap = {};

        for (const [key, val] of Object.entries(rawScores)) {
          if (val !== undefined && val !== null && val !== '') {
            const num = Number(val);
            if (!Number.isNaN(num) && num >= 0) {
              scoresMap[key] = num;
            }
          }
        }

        return {
          student: new mongoose.Types.ObjectId(studentId),
          scores: scoresMap,
          remarks: String(g.remarks || '').trim().slice(0, 500)
        };
      })
      .filter((g) => mongoose.Types.ObjectId.isValid(g.student));

    if (subject) gradebook.subject = String(subject).trim();
    if (courseCode) gradebook.courseCode = String(courseCode).trim();
    gradebook.assessments = cleanedAssessments;
    gradebook.grades = cleanedGrades;

    await gradebook.save();

    res.json({
      message: 'Gradebook updated successfully by admin',
      gradebook
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    next(error);
  }
};

// PATCH /api/admin/grades/:id/publish
export const togglePublishGradebook = async (req, res, next) => {
  try {
    const { id } = req.params;
    assertValidObjectId(id, 'gradebook ID');

    const gradebook = await GradebookModel.findById(id);
    if (!gradebook) {
      return res.status(404).json({ message: 'Gradebook not found' });
    }

    const publishVal = req.body?.publish !== undefined ? req.body.publish : req.body?.isPublished;
    const shouldPublish = publishVal !== undefined ? Boolean(publishVal) : !gradebook.isPublished;

    gradebook.isPublished = shouldPublish;
    gradebook.status = shouldPublish ? 'published' : 'draft';
    gradebook.publishedAt = shouldPublish ? new Date() : null;
    gradebook.publishedBy = shouldPublish ? req.user?._id : null;

    await gradebook.save();

    res.json({
      message: shouldPublish ? 'Gradebook published successfully! Students can now view their grades.' : 'Gradebook reverted to draft. Grades are now hidden from students.',
      isPublished: gradebook.isPublished,
      status: gradebook.status,
      publishedAt: gradebook.publishedAt
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    next(error);
  }
};
