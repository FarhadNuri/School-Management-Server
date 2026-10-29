import CourseModel from '../../models/course.model.js';
import mongoose from 'mongoose';
import ClassModel from '../../models/class.model.js';
import StudentModel from '../../models/student.model.js';
import GuardianModel from '../../models/guardian.model.js';
import {
  populateUser,
  USER_PUBLIC_SELECT,
  escapeRegex,
  findUserIds,
} from '../../utils/userHelpers.js';
import { assertValidObjectId } from '../../utils/lessonAccess.js';

const CLASS_SELECT =
  '-assignments -announcements -events -resources -notifications -exams -quizzes -complaints';

const classPopulate = [
  {
    path: 'students',
    select: '-assignments -announcements -events -resources -exams -quizzes',
    populate: [
      populateUser,
      {
        path: 'guardian',
        populate: {
          path: 'user',
          select: 'firstName lastName email photo isActive',
        },
      },
    ],
  },
  {
    path: 'courses',
    select: 'courseName courseCode courseType courseStatus courseTeachers',
  },
];

const guardianPopulate = [
  {
    path: 'user',
    select: `${USER_PUBLIC_SELECT} isDeleted`,
  },
  {
    path: 'students',
    select: 'class user',
    populate: [
      populateUser,
      {
        path: 'class',
        select: 'className classCode grade academicYear isActive',
      },
    ],
  },
];

/**
 * Returns an array of class IDs assigned to the teacher (both via Class.teachers and Teacher.classes).
 */
const getTeacherAssignedClassIds = async (teacher) => {
  const teacherId = teacher._id || teacher;
  const taughtClasses = await ClassModel.find({
    teachers: teacherId,
  })
    .select('_id')
    .lean();

  const classIds = new Set();
  for (const c of teacher.classes || []) {
    classIds.add(String(c?._id || c));
  }
  for (const c of taughtClasses) {
    classIds.add(String(c._id));
  }

  return Array.from(classIds);
};

/**
 * Returns an array of student IDs enrolled in the teacher's assigned classes or directly assigned to the teacher.
 */
const getTeacherStudentIds = async (teacher) => {
  const teacherId = teacher._id || teacher;
  const taughtClasses = await ClassModel.find({
    $or: [
      { teachers: teacherId },
      { _id: { $in: teacher.classes || [] } },
    ],
    isActive: true,
  })
    .select('students')
    .lean();

  const studentIds = new Set();

  for (const c of taughtClasses) {
    for (const sId of c.students || []) {
      studentIds.add(String(sId?._id || sId));
    }
  }

  for (const sId of teacher.students || []) {
    studentIds.add(String(sId?._id || sId));
  }

  return Array.from(studentIds);
};

/**
 * GET /classes
 * Lists all classes assigned to the authenticated teacher.
 */
export const getTeacherClasses = async (req, res, next) => {
  try {
    const { search, isActive } = req.query;
    const assignedClassIds = await getTeacherAssignedClassIds(req.teacher);

    if (!assignedClassIds.length) {
      return res.json({ count: 0, classes: [] });
    }

    const filter = {
      _id: { $in: assignedClassIds.map((id) => new mongoose.Types.ObjectId(id)) },
    };

    if (isActive === 'true' || isActive === 'false') {
      filter.isActive = isActive === 'true';
    } else {
      filter.isActive = true;
    }

    if (search?.trim()) {
      const term = search.trim();
      const regex = new RegExp(escapeRegex(term), 'i');

      const orConditions = [
        { className: regex },
        { classCode: regex },
        { academicYear: regex },
        { description: regex },
      ];

      const grade = Number(term);
      if (!Number.isNaN(grade)) {
        orConditions.push({ grade });
      }

      filter.$and = filter.$and || [];
      filter.$and.push({ $or: orConditions });
    }

    const classes = await ClassModel.find(filter)
      .select(CLASS_SELECT)
      .populate(classPopulate)
      .populate({
        path: 'teachers',
        populate: {
          path: 'user',
          select: 'firstName lastName email photo isActive',
        },
      })
      .sort({ className: 1, grade: 1 })
      .lean();

    const teacherIdStr = String(req.teacher?._id || req.teacher || '');
    const enrichedClasses = classes.map((c) => {
      const myAssignedCourses = (c.courses || []).filter((co) =>
        (co.courseTeachers || []).some((tId) => String(tId) === teacherIdStr)
      );
      const mySubject = myAssignedCourses.map((ac) => ac.courseName).join(', ') || '';
      const myCourseCode = myAssignedCourses.map((ac) => ac.courseCode).join(', ') || '';

      return {
        ...c,
        myCourses: myAssignedCourses,
        mySubject,
        myCourseCode
      };
    });

    res.json({
      count: enrichedClasses.length,
      classes: enrichedClasses,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    next(error);
  }
};

/**
 * GET /classes/:id
 * Fetches a single class assigned to the authenticated teacher.
 */
export const getTeacherClassById = async (req, res, next) => {
  try {
    const { id } = req.params;
    assertValidObjectId(id, 'class ID');

    const assignedClassIds = await getTeacherAssignedClassIds(req.teacher);

    if (!assignedClassIds.includes(String(id))) {
      return res.status(403).json({
        message: 'Access denied. This class is not assigned to you.',
      });
    }

    const classItem = await ClassModel.findById(id)
      .select(CLASS_SELECT)
      .populate(classPopulate)
      .populate({
        path: 'teachers',
        populate: {
          path: 'user',
          select: 'firstName lastName email photo isActive',
        },
      })
      .lean();

    if (!classItem) {
      return res.status(404).json({ message: 'Class not found' });
    }

    res.json({ class: classItem });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    next(error);
  }
};

/**
 * GET /guardians
 * Lists guardians of students enrolled in the teacher's classes.
 */
export const getTeacherGuardians = async (req, res, next) => {
  try {
    const { search, isActive } = req.query;
    const studentIds = await getTeacherStudentIds(req.teacher);

    if (!studentIds.length) {
      return res.json({ count: 0, guardians: [] });
    }

    // Find guardian IDs associated with teacher's students
    const studentsWithGuardians = await StudentModel.find({
      _id: { $in: studentIds.map((id) => new mongoose.Types.ObjectId(id)) },
      guardian: { $ne: null },
    })
      .select('guardian')
      .lean();

    const guardianIds = [
      ...new Set(
        studentsWithGuardians
          .map((s) => String(s.guardian))
          .filter((id) => id && mongoose.Types.ObjectId.isValid(id))
      ),
    ];

    if (!guardianIds.length) {
      return res.json({ count: 0, guardians: [] });
    }

    const filter = {
      _id: { $in: guardianIds.map((id) => new mongoose.Types.ObjectId(id)) },
    };

    if (search?.trim() || isActive === 'true' || isActive === 'false') {
      const userIds = await findUserIds({
        role: 'guardian',
        search,
        isActive,
        includePhoneSearch: true,
      });

      filter.user = { $in: userIds };
    }

    const guardians = await GuardianModel.find(filter)
      .populate(guardianPopulate)
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      count: guardians.length,
      guardians,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    next(error);
  }
};

/**
 * GET /guardians/:id
 * Fetches a single guardian by ID, verifying that the guardian has a ward in the teacher's classes.
 */
export const getTeacherGuardianById = async (req, res, next) => {
  try {
    const { id } = req.params;
    assertValidObjectId(id, 'guardian ID');

    const studentIds = await getTeacherStudentIds(req.teacher);
    const teacherStudentSet = new Set(studentIds.map(String));

    const guardian = await GuardianModel.findById(id)
      .populate(guardianPopulate)
      .lean();

    if (!guardian) {
      return res.status(404).json({ message: 'Guardian not found' });
    }

    // Verify guardian has at least one ward associated with this teacher
    const wardIds = (guardian.students || []).map((s) => String(s._id || s));
    const hasWardInTeacherClasses = wardIds.some((sId) => teacherStudentSet.has(sId));

    if (!hasWardInTeacherClasses) {
      return res.status(403).json({
        message: 'Access denied. This guardian has no students in your classes.',
      });
    }

    res.json({ guardian });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    next(error);
  }
};
/**
 * GET /courses
 * Returns all courses/subjects assigned to the authenticated teacher.
 */
export const getTeacherCourses = async (req, res, next) => {
  try {
    const teacherId = req.teacher._id;

    const courses = await CourseModel.find({
      courseTeachers: teacherId,
      courseStatus: { $ne: 'Inactive' },
    })
      .select('courseName courseCode courseType courseStatus courseClass')
      .populate('courseClass', 'className classCode grade academicYear')
      .sort({ courseCode: 1, courseName: 1 })
      .lean();

    res.json({
      count: courses.length,
      courses,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    next(error);
  }
};
