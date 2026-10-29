import mongoose from 'mongoose';

import ClassModel from '../models/class.model.js';
import CourseModel from '../models/course.model.js';
import StudentModel from '../models/student.model.js';
import TeacherModel from '../models/teacher.model.js';
import GuardianModel from '../models/guardian.model.js';

const lessonPopulate = [
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

// Deduplicates IDs so class and course lookups do not repeat the same record.
const uniqueIds = (ids = []) => [
    ...new Set(
        ids
            .filter(Boolean)
            .map((id) => id.toString())
    ),
];


const isAssignedClass = (classItem, teacher) => {
    if (!classItem || !teacher) return false;

    const teacherId = teacher._id || teacher;
    const linkedClassIds = (teacher.classes || []).map((id) =>
        (id._id || id).toString()
    );

    return (
        teacherOwnsClass(classItem, teacherId) ||
        linkedClassIds.includes(classItem._id.toString())
    );
};

const serializeLesson = (lesson) => {
    if (!lesson) return null;
    const plain = typeof lesson.toObject === 'function' ? lesson.toObject() : { ...lesson };

    return {
        _id: plain._id.toString(),
        id: plain._id.toString(),
        title: plain.title || '',
        subject: plain.subject || '',
        description: plain.description || '',
        content: plain.content || '',
        contentType: plain.contentType || '',
        startDate: plain.startDate || null,
        startTime: plain.startTime || null,
        endDate: plain.endDate || null,
        endTime: plain.endTime || null,
        scheduledAt: plain.scheduledAt || null,
        durationMinutes: plain.durationMinutes ?? plain.maxDuration ?? null,
        maxDuration: plain.maxDuration ?? plain.durationMinutes ?? null,
        durationUnit: plain.durationUnit || 'minutes',
        lessonStatus: plain.lessonStatus || 'Active',
        lessonType: plain.lessonType || '',
        notes: plain.notes || '',
        teacherNotes: plain.teacherNotes || '',
        materials: plain.materials || [],
        class: plain.class?._id || plain.class || null,
        classId: plain.class?._id || plain.class || null,
        className: plain.class?.className || null,
        classCode: plain.class?.classCode || null,
        grade: plain.class?.grade || null,
        course: plain.course?._id || plain.course || null,
        courseId: plain.course?._id || plain.course || null,
        courseName: plain.course?.courseName || null,
        courseCode: plain.course?.courseCode || null,
        teacher: plain.teacher?._id || plain.teacher || null,
        teacherId: plain.teacher?._id || plain.teacher || null,
        teacherName: getTeacherName(plain),
        isActive: plain.isActive ?? true,
        createdAt: plain.createdAt,
        updatedAt: plain.updatedAt,
    };
};

// Throws 400 if the ID is not a valid MongoDB ObjectId.
// Shared by lesson, homework, exam, and attendance routes.
const assertValidObjectId = (id, label = 'ID') => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const error = new Error(`Invalid ${label}`);
    error.statusCode = 400;
    throw error;
  }
};

// True if this teacher is listed on the class. Used when checking whether they
// may create lessons, homework, or exams for that class.
const teacherOwnsClass = (classItem, teacherId) => {
  const id = teacherId.toString();
  return (classItem.teachers || []).some(
    (teacher) => (teacher._id || teacher).toString() === id
  );
};

const resolveAccessContext = async (user) => {
    if (!user?._id || !user.role) {
        return {
            role: null,
            teacherId: null,
            studentId: null,
            guardianId: null,
            classIds: [],
        };
    }

    if (user.role === 'teacher') {
        const teacher = await TeacherModel.findOne({ user: user._id })
            .select('_id classes')
            .lean();

        if (!teacher) {
            return {
                role: 'teacher',
                teacherId: null,
                studentId: null,
                guardianId: null,
                classIds: [],
            };
        }

        const taughtClasses = await ClassModel.find({ teachers: teacher._id })
            .select('_id')
            .lean();

        return {
            role: 'teacher',
            teacherId: teacher._id,
            teacher,
            studentId: null,
            guardianId: null,
            classIds: uniqueIds([
                ...(teacher.classes || []),
                ...taughtClasses.map((item) => item._id),
            ]),
        };
    }

    if (user.role === 'student') {
        const student = await StudentModel.findOne({ user: user._id })
            .select('_id class')
            .lean();

        return {
            role: 'student',
            teacherId: null,
            studentId: student?._id || null,
            guardianId: null,
            classIds: student?.class ? [student.class.toString()] : [],
        };
    }

    if (user.role === 'guardian') {
        const guardian = await GuardianModel.findOne({ user: user._id })
            .select('_id students')
            .lean();

        if (!guardian) {
            return {
                role: 'guardian',
                teacherId: null,
                studentId: null,
                guardianId: null,
                classIds: [],
            };
        }
        const wards = await StudentModel.find({
            _id: { $in: guardian.students || [] },
        })
            .select('class')
            .lean();

        return {
            role: 'guardian',
            teacherId: null,
            studentId: null,
            guardianId: guardian._id,
            classIds: uniqueIds(wards.map((ward) => ward.class)),
        };
    }

    return {
        role: user.role,
        teacherId: null,
        studentId: null,
        guardianId: null,
        classIds: [],
    };
};

// Display name of the lesson's teacher for API responses.
const getTeacherName = (lesson) => {
    const user = lesson?.teacher?.user;
    if (!user || typeof user !== 'object') return '';
    return `${user.firstName || ''} ${user.lastName || ''}`.trim();
};

// Mongo query that lists only lessons this user may see:
// own lessons for teachers, class lessons for students and guardians.
const buildLessonVisibilityQuery = (context) => {
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

const getAccessibleCourses = async (context, options = {}) => {
    const courseList = [];
    const seen = new Set();
    let targetClassIds = [...(context.classIds || [])];

    // For teachers: Show ALL curriculum subjects for Class 6, 7, 8 (matching admin catalog)
    if (context.role === "teacher") {
        const courses = await CourseModel.find({
            courseStatus: "Active",
        })
            .populate("courseClass", "className classCode grade academicYear isActive")
            .populate({
                path: "courseTeachers",
                populate: {
                    path: "user",
                    select: "firstName lastName email photo",
                },
            })
            .populate("courseStudents", "_id")
            .sort({ courseCode: 1 })
            .lean();

        for (const course of courses) {
            if (!course || !course._id) continue;
            const id = String(course._id);
            if (seen.has(id)) continue;
            seen.add(id);

            const teacherNames = (course.courseTeachers || [])
                .map((t) => (t.user ? ((t.user.firstName || "") + " " + (t.user.lastName || "")).trim() : "Teacher"))
                .filter(Boolean)
                .join(", ");

            const classItem = course.courseClass || {};
            const gradeStr = classItem.grade != null ? "Class " + classItem.grade : "";

            courseList.push({
                id,
                _id: course._id,
                name: course.courseName,
                courseName: course.courseName,
                code: course.courseCode,
                courseCode: course.courseCode,
                shortCode: course.courseName.replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase() || "CRS",
                type: course.courseType || "Core",
                courseType: course.courseType || "Core",
                status: course.courseStatus || "Active",
                courseStatus: course.courseStatus || "Active",
                isActive: course.courseStatus === "Active",
                description: course.courseDescription || "",
                courseDescription: course.courseDescription || "",
                coverImage: course.coverImage || null,
                image: course.coverImage || null,
                class: classItem.className || "",
                className: classItem.className || "",
                classCode: classItem.classCode || "",
                classId: classItem._id ? String(classItem._id) : "",
                grade: gradeStr,
                teacher: teacherNames || "No teacher assigned",
                teachers: course.courseTeachers || [],
                enrolled: String((course.courseStudents || []).length),
            });
        }
        return courseList;
    }

    if (options.studentId) {
        const student = await StudentModel.findById(options.studentId).select("class").lean();
        if (student && student.class && targetClassIds.includes(String(student.class))) {
            targetClassIds = [String(student.class)];
        }
    } else if (options.classId) {
        if (targetClassIds.includes(String(options.classId))) {
            targetClassIds = [String(options.classId)];
        }
    }

    if (targetClassIds.length) {
        const classes = await ClassModel.find({
            _id: { $in: targetClassIds },
            isActive: true,
        })
            .select("className classCode grade courses")
            .populate({
                path: "courses",
                match: { courseStatus: "Active" },
                select: "courseName courseCode courseType courseStatus courseClass coverImage courseDescription courseTeachers courseStudents",
                populate: {
                    path: "courseTeachers",
                    populate: {
                        path: "user",
                        select: "firstName lastName email photo",
                    },
                },
            })
            .lean();

        for (const classItem of classes) {
            for (const course of classItem.courses || []) {
                if (!course || !course._id) continue;
                const id = String(course._id);
                const key = id + "_" + String(classItem._id);
                if (seen.has(key)) continue;
                seen.add(key);

                const teacherNames = (course.courseTeachers || [])
                    .map((t) => (t.user ? ((t.user.firstName || "") + " " + (t.user.lastName || "")).trim() : "Teacher"))
                    .filter(Boolean)
                    .join(", ");

                const gradeStr = classItem.grade != null ? "Class " + classItem.grade : "";

                courseList.push({
                    id,
                    _id: course._id,
                    name: course.courseName,
                    courseName: course.courseName,
                    code: course.courseCode,
                    courseCode: course.courseCode,
                    shortCode: course.courseName.replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase() || "CRS",
                    type: course.courseType || "Core",
                    courseType: course.courseType || "Core",
                    status: course.courseStatus || "Active",
                    courseStatus: course.courseStatus || "Active",
                    isActive: course.courseStatus === "Active",
                    description: course.courseDescription || "",
                    courseDescription: course.courseDescription || "",
                    coverImage: course.coverImage || null,
                    image: course.coverImage || null,
                    class: classItem.className,
                    className: classItem.className,
                    classCode: classItem.classCode,
                    classId: String(classItem._id),
                    grade: gradeStr,
                    teacher: teacherNames || "No teacher assigned",
                    teachers: course.courseTeachers || [],
                    enrolled: String((course.courseStudents || []).length),
                });
            }
        }
    }

    return courseList;
};

const canAccessLesson = (lesson, context) => {
    if (!lesson || !context) return false;

    if (context.role === 'teacher') {
        return (
            String(lesson.teacher?._id || lesson.teacher) ===
            String(context.teacherId)
        );
    }

    if (context.role === 'student' || context.role === 'guardian') {
        const classId = String(lesson.class?._id || lesson.class || '');
        return context.classIds.includes(classId);
    }

    if (context.role === 'admin') return true;

    return false;
};

export { lessonPopulate, teacherOwnsClass, resolveAccessContext, getAccessibleCourses, buildLessonVisibilityQuery, getTeacherName, assertValidObjectId, serializeLesson, isAssignedClass, canAccessLesson }