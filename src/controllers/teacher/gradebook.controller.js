import mongoose from 'mongoose';
import GradebookModel from '../../models/gradebook.model.js';
import ClassModel from '../../models/class.model.js';
import { assertValidObjectId, isAssignedClass } from '../../utils/lessonAccess.js';
import { loadClassStudents } from '../../utils/examAccess.js';

const getAssignedClassOrThrow = async (classId, teacher) => {
  assertValidObjectId(classId, 'class ID');

  const classItem = await ClassModel.findById(classId)
    .select('className classCode grade academicYear isActive teachers students courses')
    .lean();

  if (!classItem) {
    const error = new Error('Class not found');
    error.statusCode = 404;
    throw error;
  }

  if (!isAssignedClass(classItem, teacher)) {
    const error = new Error('Access denied. This class is not assigned to you.');
    error.statusCode = 403;
    throw error;
  }

  return classItem;
};

export const getTeacherGradebook = async (req, res, next) => {
  try {
    const classId = req.params.classId || req.query.classId;
    if (!classId) {
      return res.status(400).json({ message: 'Class ID is required' });
    }

    const classItem = await getAssignedClassOrThrow(classId, req.teacher);
    const students = await loadClassStudents(classItem._id);

    const gradebook = await GradebookModel.findOne({
      class: classItem._id,
      teacher: req.teacher._id
    }).sort({ isPublished: -1, updatedAt: -1 }).lean();

    // Index saved student grades by studentId
    const savedGradesMap = new Map();
    if (gradebook?.grades) {
      for (const g of gradebook.grades) {
        const sId = String(g.student?._id || g.student || '');
        if (sId) {
          const scoresObj = g.scores instanceof Map
            ? Object.fromEntries(g.scores)
            : (g.scores && typeof g.scores === 'object' ? g.scores : {});
          savedGradesMap.set(sId, {
            scores: scoresObj,
            remarks: g.remarks || ''
          });
        }
      }
    }

    // Merge with class roster
    const studentList = students.map((s) => {
      const sId = String(s._id || s.id);
      const user = s.user || {};
      const saved = savedGradesMap.get(sId);
      const name = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Student';
      const photo = typeof user.photo === 'string' ? user.photo : (user.photo?.url || '');

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

    res.json({
      class: {
        id: classItem._id,
        _id: classItem._id,
        className: classItem.className,
        classCode: classItem.classCode,
        grade: classItem.grade,
        academicYear: classItem.academicYear
      },
      subject: gradebook?.subject || 'Bangla First',
      courseCode: gradebook?.courseCode || 'BN 101',
      isPublished: Boolean(gradebook?.isPublished),
      publishedAt: gradebook?.publishedAt || null,
      status: gradebook?.status || (gradebook?.isPublished ? 'published' : 'draft'),
      assessments: gradebook?.assessments || [],
      students: studentList
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    next(error);
  }
};

export const saveTeacherGradebook = async (req, res, next) => {
  try {
    const classId = req.params.classId || req.body.classId;
    if (!classId) {
      return res.status(400).json({ message: 'Class ID is required' });
    }

    const classItem = await getAssignedClassOrThrow(classId, req.teacher);
    const { assessments = [], grades = [] } = req.body || {};

    // Check if gradebook is published - locked for teachers!
    const existing = await GradebookModel.findOne({
      class: classItem._id,
      teacher: req.teacher._id,
      $or: [{ isPublished: true }, { status: 'published' }]
    });
    if (existing) {
      return res.status(403).json({
        message: 'This gradesheet has been officially published by Admin. Teachers cannot modify published grades.'
      });
    }

    // Validate assessments
    const cleanedAssessments = (Array.isArray(assessments) ? assessments : []).map((a, idx) => ({
      id: String(a.id || `asmt_${idx + 1}`),
      name: String(a.name || `Assessment ${idx + 1}`).trim().slice(0, 100),
      type: ['quiz', 'class_test', 'assignment', 'attendance', 'mid_term', 'final_term', 'other'].includes(a.type)
        ? a.type
        : 'quiz',
      maxMarks: Math.max(1, Number(a.maxMarks) || 100),
      date: a.date ? new Date(a.date) : new Date()
    }));

    // Validate student grades
    const cleanedGrades = (Array.isArray(grades) ? grades : []).map((g) => {
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
    }).filter((g) => mongoose.Types.ObjectId.isValid(g.student));

    const updatedGradebook = await GradebookModel.findOneAndUpdate(
      {
        class: classItem._id,
        teacher: req.teacher._id
      },
      {
        $set: {
          class: classItem._id,
          teacher: req.teacher._id,
          academicYear: classItem.academicYear || '',
          assessments: cleanedAssessments,
          grades: cleanedGrades
        }
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      }
    ).lean();

    res.json({
      message: 'Gradebook saved successfully',
      gradebook: updatedGradebook
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    next(error);
  }
};

export const getTeacherGradebooks = async (req, res, next) => {
  try {
    const gradebooks = await GradebookModel.find({
      teacher: req.teacher._id
    })
      .populate({
        path: 'class',
        select: 'className classCode grade academicYear'
      })
      .lean();

    res.json({
      count: gradebooks.length,
      gradebooks: gradebooks.map((g) => ({
        id: g._id,
        _id: g._id,
        classId: g.class?._id || g.class,
        className: g.class?.className || 'Class',
        classCode: g.class?.classCode || '',
        grade: g.class?.grade || '',
        subject: g.subject || 'Bangla First',
        courseCode: g.courseCode || 'BN 101',
        isPublished: Boolean(g.isPublished),
        status: g.isPublished ? 'published' : 'draft',
        assessmentsCount: g.assessments?.length || 0,
        studentsCount: g.grades?.length || 0,
        updatedAt: g.updatedAt
      }))
    });
  } catch (error) {
    next(error);
  }
};
