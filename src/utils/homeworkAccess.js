import mongoose from 'mongoose';
import { assertValidObjectId, resolveAccessContext, getAccessibleCourses } from './lessonAccess.js';

const homeworkPopulate = [
  {
    path: 'class',
    select: 'className classCode grade academicYear isActive teachers',
  },
  {
    path: 'course',
    select: 'courseName courseCode courseType courseStatus courseClass',
  },
  {
    path: 'teacher',
    select: 'user',
    populate: {
      path: 'user',
      select: 'firstName lastName email photo',
    },
  },
];

// True if this teacher is listed on the class. 
// Used when checking whether they may create lessons, homework, or exams for that class.
const isAssignedClass = (classItem, teacher) => {
  if (!classItem || !teacher) return false;

  const teacherId = teacher._id || teacher.id || teacher;
  const targetTeacherId = String(teacherId);

  const isTeacherOnClass = (classItem.teachers || []).some((t) => {
    const tStr = String(t._id || t.id || t);
    return tStr === targetTeacherId;
  });

  const linkedClassIds = (teacher.classes || []).map((id) =>
    String(id._id || id.id || id)
  );

  return isTeacherOnClass || linkedClassIds.includes(String(classItem._id || classItem.id || classItem));
};
const buildHomeworkVisibilityQuery = (context) => {
  const query = { isActive: true };

  if (context.role === 'teacher') {
    if (!context.teacherId) {
      query._id = null;
      return query;
    }
    query.teacher = context.teacherId;
    return query;
  }

  if (!context.classIds.length) {
    query._id = null;
    return query;
  }

  query.class = {
    $in: context.classIds.map((id) => new mongoose.Types.ObjectId(id)),
  };
  return query;
};

const canAccessHomework = (homework, context) => {
  if (!homework || !context) return false;

  if (context.role === 'teacher') {
    return String(homework.teacher) === String(context.teacherId);
  }

  if (context.role === 'student') {
    return context.classIds.includes(String(homework.class));
  }

  if (context.role === 'guardian') {
    return context.classIds.includes(String(homework.class));
  }

  return false;
};

const getTeacherName = (homework) => {
  const teacher = homework?.teacher;
  if (!teacher) return '';
  const user = teacher.user || teacher;
  return `${user.firstName || ''} ${user.lastName || ''}`.trim();
};

const serializeHomework = (homework) => {
  const plain = typeof homework.toObject === 'function' ? homework.toObject() : { ...homework };

  return {
    id: String(homework._id),
    _id: homework._id,
    title: homework.title || '',
    description: homework.description || '',
    instructions: homework.instructions || homework.description || '',
    subject: homework.subject || homework.course?.courseName || '',
    dueDate: homework.dueDate || null,
    materials: Array.isArray(homework.materials) ? homework.materials : [],
    
    // Class info
    classId: homework.class?._id || null,
    className: homework.class?.className || '',
    classCode: homework.class?.classCode || '',
    
    // Course info (from populate)
    courseId: homework.course?._id || null,
    courseName: homework.course?.courseName || homework.subject || '',
    courseCode: homework.course?.courseCode || '',
    courseType: homework.course?.courseType || '',
    
    // Teacher info (from populate)
    teacherId: homework.teacher?._id || null,
    teacher: getTeacherName(homework),
    
    maxScore: homework.maxScore,
    isActive: homework.isActive ?? true,
    createdAt: homework.createdAt,
    updatedAt: homework.updatedAt,
  };
};

export { homeworkPopulate, assertValidObjectId, buildHomeworkVisibilityQuery, canAccessHomework, serializeHomework,
    getAccessibleCourses, resolveAccessContext, isAssignedClass
 };