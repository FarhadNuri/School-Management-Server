import mongoose from "mongoose";
import AttendanceModel from "../../models/attendance.model.js";
import LessonModel from "../../models/lesson.model.js";
import ClassModel from "../../models/class.model.js";
import StudentModel from "../../models/student.model.js";
import {
    ATTENDANCE_STATUSES,
    assertValidObjectId,
    serializeAttendance,
    serializeLesson,
    lessonPopulate,
    attendancePopulate,
    summarizeRecords,
    getStudentName,
} from "../../utils/attendanceAccess.js";
import { isAssignedClass } from "../../utils/lessonAccess.js";

const getOwnedLessonOrThrow = async (lessonId, teacherId) => {
    assertValidObjectId(lessonId, "lesson ID");

    const lesson = await LessonModel.findOne({
        _id: lessonId,
        teacher: teacherId,
        isActive: true,
    })
        .populate(lessonPopulate)
        .lean();
    if (!lesson) {
        const error = new Error('Lesson not found');
        error.statusCode = 404;
        throw error;
    }

    return lesson;
};

const getAssignedClassOrThrow = async (classId, teacher) => {
    assertValidObjectId(classId, 'class ID');

    const classItem = await ClassModel.findById(classId)
        .select('className classCode grade academicYear isActive teachers students courses')
        .populate({
            path: 'courses',
            select: 'courseName courseCode courseStatus',
        })
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

const loadClassRoster = async (classId) => {
    const classItem = await ClassModel.findById(classId)
        .select('className classCode students isActive')
        .lean();

    if (!classItem) {
        const error = new Error('Class not found');
        error.statusCode = 404;
        throw error;
    }
    const students = await StudentModel.find({
        _id: { $in: classItem.students || [] },
    })
        .select('user class idType')
        .populate({
            path: 'user',
            select: 'firstName lastName photo email isDeleted isActive',
        })
        .lean();

    return students
        .filter((student) => student?.user && !student.user.isDeleted)
        .sort((a, b) =>
            getStudentName(a).localeCompare(getStudentName(b), undefined, {
                sensitivity: 'base',
            })
        );
};

const buildRosterResponse = (lesson, students, records) => {
    const recordByStudent = new Map(
        records.map((record) => [
            String(record.student?._id || record.student),
            record,
        ])
    );

    const roster = students.map((student) => {
        const existing = recordByStudent.get(String(student._id));
        const serialized = existing ? serializeAttendance(existing) : null;

        return {
            studentId: String(student._id),
            firstName: student.user?.firstName || '',
            lastName: student.user?.lastName || '',
            name: getStudentName(student),
            photo: student.user?.photo || '',
            status: serialized?.status || null,
            note: serialized?.note || '',
            attendanceId: serialized?.id || null,
            markedAt: serialized?.markedAt || null,
        };
    });

    const marked = roster.filter((item) => item.status);
    const summary = summarizeRecords(marked);

    return {
        lesson: lesson ? serializeLesson(lesson) : null,
        roster,
        summary: {
            ...summary,
            rosterSize: roster.length,
            markedCount: marked.length,
            unmarkedCount: roster.length - marked.length,
            isComplete: roster.length > 0 && marked.length === roster.length,
        },
    };
};

/**
 * Normalizes a date string YYYY-MM-DD into start and end of that day in UTC
 */
const parseDateRangeUTC = (dateStr) => {
    if (!dateStr || typeof dateStr !== 'string') {
        const error = new Error('A valid date (YYYY-MM-DD) is required');
        error.statusCode = 400;
        throw error;
    }

    const parts = dateStr.trim().split('-');
    if (parts.length !== 3) {
        const error = new Error('Date must be formatted as YYYY-MM-DD');
        error.statusCode = 400;
        throw error;
    }

    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1; // 0-indexed
    const day = parseInt(parts[2], 10);

    const start = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
    const end = new Date(Date.UTC(year, month, day, 23, 59, 59, 999));

    if (Number.isNaN(start.getTime())) {
        const error = new Error('Invalid date provided');
        error.statusCode = 400;
        throw error;
    }

    return { start, end, dateStr: `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}` };
};

// ==========================================
// SECTION-BASED ATTENDANCE CONTROLLERS
// ==========================================

/**
 * GET /api/teacher/attendance/sections
 * Returns all class sections assigned to the logged-in teacher
 */
const getTeacherAttendanceSections = async (req, res, next) => {
    try {
        const teacher = req.teacher;
        const teacherId = teacher._id;

        const taughtClasses = await ClassModel.find({
            $or: [
                { teachers: teacherId },
                { _id: { $in: teacher.classes || [] } },
            ],
            isActive: true,
        })
            .select('className classCode grade academicYear students courses coverImage description')
            .populate({
                path: 'courses',
                select: 'courseName courseCode',
            })
            .lean();

        // Unique by _id
        const seen = new Set();
        const sections = [];

        for (const cls of taughtClasses) {
            const idStr = String(cls._id);
            if (seen.has(idStr)) continue;
            seen.add(idStr);

            const courseNames = (cls.courses || [])
                .map((c) => c?.courseName)
                .filter(Boolean);

            sections.push({
                _id: idStr,
                id: idStr,
                className: cls.className,
                classCode: cls.classCode,
                grade: cls.grade,
                academicYear: cls.academicYear,
                studentCount: (cls.students || []).length,
                courses: courseNames,
                coverImage: cls.coverImage || '',
                description: cls.description || '',
            });
        }

        res.json({
            count: sections.length,
            sections,
        });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ message: error.message });
        }
        next(error);
    }
};

/**
 * GET /api/teacher/attendance/sections/:classId/monthly?year=2026&month=10
 * Returns day-by-day attendance summary for the given section in that month
 */
const getSectionMonthlyAttendance = async (req, res, next) => {
    try {
        const { classId } = req.params;
        const classItem = await getAssignedClassOrThrow(classId, req.teacher);

        const now = new Date();
        const year = req.query.year ? parseInt(req.query.year, 10) : now.getUTCFullYear();
        const month = req.query.month ? parseInt(req.query.month, 10) : (now.getUTCMonth() + 1);

        if (Number.isNaN(year) || Number.isNaN(month) || month < 1 || month > 12) {
            return res.status(400).json({ message: 'Invalid year or month query parameter' });
        }

        const startOfMonth = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
        // Next month day 0 gives last day of current month
        const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const endOfMonth = new Date(Date.UTC(year, month - 1, daysInMonth, 23, 59, 59, 999));

        const rosterSize = (classItem.students || []).length;

        // Aggregate daily attendance for this class in this month
        const dailyRecords = await AttendanceModel.aggregate([
            {
                $match: {
                    class: new mongoose.Types.ObjectId(classId),
                    date: { $gte: startOfMonth, $lte: endOfMonth },
                },
            },
            {
                $group: {
                    _id: {
                        $dateToString: { format: "%Y-%m-%d", date: "$date", timezone: "UTC" },
                    },
                    total: { $sum: 1 },
                    present: {
                        $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] },
                    },
                    absent: {
                        $sum: { $cond: [{ $eq: ["$status", "absent"] }, 1, 0] },
                    },
                    late: {
                        $sum: { $cond: [{ $eq: ["$status", "late"] }, 1, 0] },
                    },
                    excused: {
                        $sum: { $cond: [{ $eq: ["$status", "excused"] }, 1, 0] },
                    },
                },
            },
        ]);

        const recordByDayStr = new Map(
            dailyRecords.map((item) => [item._id, item])
        );

        // Build days object for all days in month
        const days = {};
        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const stat = recordByDayStr.get(dateStr);

            if (stat && stat.total > 0) {
                const attended = (stat.present || 0) + (stat.late || 0);
                days[d] = {
                    date: dateStr,
                    day: d,
                    hasRecords: true,
                    rosterSize,
                    markedCount: stat.total,
                    unmarkedCount: Math.max(0, rosterSize - stat.total),
                    present: stat.present || 0,
                    absent: stat.absent || 0,
                    late: stat.late || 0,
                    excused: stat.excused || 0,
                    attended,
                    attendanceRate: rosterSize > 0 ? Math.round((attended / rosterSize) * 100) : 0,
                    isComplete: rosterSize > 0 && stat.total >= rosterSize,
                };
            } else {
                days[d] = {
                    date: dateStr,
                    day: d,
                    hasRecords: false,
                    rosterSize,
                    markedCount: 0,
                    unmarkedCount: rosterSize,
                    present: 0,
                    absent: 0,
                    late: 0,
                    excused: 0,
                    attended: 0,
                    attendanceRate: 0,
                    isComplete: false,
                };
            }
        }

        res.json({
            class: {
                id: String(classItem._id),
                className: classItem.className,
                classCode: classItem.classCode,
                grade: classItem.grade,
                academicYear: classItem.academicYear,
                studentCount: rosterSize,
            },
            year,
            month,
            daysInMonth,
            days,
        });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ message: error.message });
        }
        next(error);
    }
};

/**
 * GET /api/teacher/attendance/sections/:classId/date/:date
 * Returns student roster and any marked attendance for a given section on that day
 */
const getSectionDailyAttendance = async (req, res, next) => {
    try {
        const { classId, date: dateStr } = req.params;
        const classItem = await getAssignedClassOrThrow(classId, req.teacher);
        const { start, end, dateStr: normalizedDate } = parseDateRangeUTC(dateStr);

        const students = await loadClassRoster(classId);
        const records = await AttendanceModel.find({
            class: classId,
            date: { $gte: start, $lte: end },
        })
            .populate(attendancePopulate)
            .lean();

        const recordByStudent = new Map(
            records.map((r) => [String(r.student?._id || r.student), r])
        );

        const roster = students.map((student) => {
            const existing = recordByStudent.get(String(student._id));
            const serialized = existing ? serializeAttendance(existing) : null;

            return {
                studentId: String(student._id),
                firstName: student.user?.firstName || '',
                lastName: student.user?.lastName || '',
                name: getStudentName(student),
                photo: student.user?.photo || '',
                status: serialized?.status || null,
                note: serialized?.note || '',
                attendanceId: serialized?.id || null,
                markedAt: serialized?.markedAt || null,
            };
        });

        const marked = roster.filter((item) => item.status);
        const summary = summarizeRecords(marked);

        res.json({
            class: {
                id: String(classItem._id),
                className: classItem.className,
                classCode: classItem.classCode,
                grade: classItem.grade,
                academicYear: classItem.academicYear,
            },
            date: normalizedDate,
            roster,
            summary: {
                ...summary,
                rosterSize: roster.length,
                markedCount: marked.length,
                unmarkedCount: roster.length - marked.length,
                isComplete: roster.length > 0 && marked.length === roster.length,
            },
        });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ message: error.message });
        }
        next(error);
    }
};

/**
 * PUT /api/teacher/attendance/sections/:classId/date/:date
 * Saves or updates daily attendance for that section and date
 */
const saveSectionDailyAttendance = async (req, res, next) => {
    try {
        const { classId, date: dateStr } = req.params;
        const classItem = await getAssignedClassOrThrow(classId, req.teacher);
        const { start, end, dateStr: normalizedDate } = parseDateRangeUTC(dateStr);

        const students = await loadClassRoster(classId);
        const allowedStudentIds = new Set(
            students.map((student) => String(student._id))
        );

        const { records } = req.body || {};
        if (!Array.isArray(records) || records.length === 0) {
            return res.status(400).json({
                message: 'Provide at least one attendance record to save.',
            });
        }

        const ops = [];
        const seen = new Set();
        const now = new Date();

        for (const item of records) {
            const studentId = String(item?.studentId || item?.student || '');
            const status = String(item?.status || '').trim().toLowerCase();
            const note = String(item?.note || '').trim().slice(0, 500);

            if (!studentId || !allowedStudentIds.has(studentId)) {
                return res.status(400).json({
                    message: "One or more students are not enrolled in this section's roster.",
                });
            }

            if (!ATTENDANCE_STATUSES.includes(status)) {
                return res.status(400).json({
                    message: 'Status must be present, absent, late, or excused.',
                });
            }

            if (seen.has(studentId)) continue;
            seen.add(studentId);

            ops.push({
                updateOne: {
                    filter: {
                        class: classItem._id,
                        student: studentId,
                        date: start,
                    },
                    update: {
                        $set: {
                            class: classItem._id,
                            student: studentId,
                            teacher: req.teacher._id,
                            markedBy: req.teacher._id,
                            status,
                            note,
                            markedAt: now,
                            date: start,
                        },
                    },
                    upsert: true,
                },
            });
        }

        if (ops.length) {
            await AttendanceModel.bulkWrite(ops, { ordered: false });
        }

        const saved = await AttendanceModel.find({
            class: classItem._id,
            date: { $gte: start, $lte: end },
        })
            .populate(attendancePopulate)
            .lean();

        const recordByStudent = new Map(
            saved.map((r) => [String(r.student?._id || r.student), r])
        );

        const roster = students.map((student) => {
            const existing = recordByStudent.get(String(student._id));
            const serialized = existing ? serializeAttendance(existing) : null;

            return {
                studentId: String(student._id),
                firstName: student.user?.firstName || '',
                lastName: student.user?.lastName || '',
                name: getStudentName(student),
                photo: student.user?.photo || '',
                status: serialized?.status || null,
                note: serialized?.note || '',
                attendanceId: serialized?.id || null,
                markedAt: serialized?.markedAt || null,
            };
        });

        const marked = roster.filter((item) => item.status);
        const summary = summarizeRecords(marked);

        res.json({
            message: 'Attendance saved successfully',
            class: {
                id: String(classItem._id),
                className: classItem.className,
                classCode: classItem.classCode,
                grade: classItem.grade,
                academicYear: classItem.academicYear,
            },
            date: normalizedDate,
            roster,
            summary: {
                ...summary,
                rosterSize: roster.length,
                markedCount: marked.length,
                unmarkedCount: roster.length - marked.length,
                isComplete: roster.length > 0 && marked.length === roster.length,
            },
        });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ message: error.message });
        }
        next(error);
    }
};

// ==========================================
// LEGACY LESSON-BASED ATTENDANCE CONTROLLERS
// ==========================================

const getLessonAttendance = async (req, res, next) => {
    try {
        const lesson = await getOwnedLessonOrThrow(
            req.params.lessonId,
            req.teacher._id
        );
        const students = await loadClassRoster(lesson.class?._id || lesson.class);
        const records = await AttendanceModel.find({ lesson: lesson._id })
            .populate(attendancePopulate)
            .lean();

        res.json(buildRosterResponse(lesson, students, records));
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ message: error.message });
        }
        next(error);
    }
};

const saveLessonAttendance = async (req, res, next) => {
    try {
        const lesson = await getOwnedLessonOrThrow(
            req.params.lessonId,
            req.teacher._id
        );

        const classId = lesson.class?._id || lesson.class;
        const students = await loadClassRoster(classId);
        const allowedStudentIds = new Set(
            students.map((student) => String(student._id))
        );

        const { records } = req.body || {};
        if (!Array.isArray(records) || records.length === 0) {
            return res.status(400).json({
                message: 'Provide at least one attendance record to save.',
            });
        }

        const ops = [];
        const seen = new Set();
        const now = new Date();
        const lessonDate = new Date(lesson.scheduledAt);

        for (const item of records) {
            const studentId = String(item?.studentId || item?.student || '');
            const status = String(item?.status || '').trim().toLowerCase();
            const note = String(item?.note || '')
                .trim()
                .slice(0, 500);

            if (!studentId || !allowedStudentIds.has(studentId)) {
                return res.status(400).json({
                    message:
                        "One or more students are not in this lesson's class roster.",
                });
            }

            if (!ATTENDANCE_STATUSES.includes(status)) {
                return res.status(400).json({
                    message:
                        'Status must be present, absent, late, or excused.',
                });
            }

            if (seen.has(studentId)) continue;
            seen.add(studentId);

            ops.push({
                updateOne: {
                    filter: {
                        lesson: lesson._id,
                        student: studentId,
                    },
                    update: {
                        $set: {
                            lesson: lesson._id,
                            student: studentId,
                            class: classId,
                            teacher: req.teacher._id,
                            status,
                            note,
                            markedBy: req.teacher._id,
                            markedAt: now,
                            date: lessonDate,
                        },
                    },
                    upsert: true,
                },
            });
        }
        if (ops.length) {
            await AttendanceModel.bulkWrite(ops, { ordered: false });
        }

        const saved = await AttendanceModel.find({ lesson: lesson._id })
            .populate(attendancePopulate)
            .lean();

        res.json({
            message: 'Attendance saved successfully',
            ...buildRosterResponse(lesson, students, saved),
        });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ message: error.message });
        }
        next(error);
    }
};

const getTeacherAttendanceLessons = async (req, res, next) => {
    try {
        const lessons = await LessonModel.find({
            teacher: req.teacher._id,
            isActive: true,
        })
            .populate(lessonPopulate)
            .sort({ scheduledAt: -1 })
            .lean();

        if (!lessons.length) {
            return res.json({ count: 0, lessons: [] });
        }

        const lessonIds = lessons.map((lesson) => lesson._id);
        const aggregates = await AttendanceModel.aggregate([
            { $match: { lesson: { $in: lessonIds } } },
            {
                $group: {
                    _id: '$lesson',
                    total: { $sum: 1 },
                    present: {
                        $sum: {
                            $cond: [{ $eq: ['$status', 'present'] }, 1, 0],
                        },
                    },
                    absent: {
                        $sum: {
                            $cond: [{ $eq: ['$status', 'absent'] }, 1, 0],
                        },
                    },
                    late: {
                        $sum: {
                            $cond: [{ $eq: ['$status', 'late'] }, 1, 0],
                        },
                    },
                    excused: {
                        $sum: {
                            $cond: [{ $eq: ['$status', 'excused'] }, 1, 0],
                        },
                    },
                },
            },
        ]);

        const statsByLesson = new Map(
            aggregates.map((item) => [String(item._id), item])
        );

        const classIds = [
            ...new Set(
                lessons
                    .map((lesson) => String(lesson.class?._id || lesson.class || ''))
                    .filter(Boolean)
            ),
        ];

        const classes = await ClassModel.find({ _id: { $in: classIds } })
            .select('students')
            .lean();

        const rosterSizeByClass = new Map(
            classes.map((classItem) => [
                String(classItem._id),
                (classItem.students || []).length,
            ])
        );

        const payload = lessons.map((lesson) => {
            const serialized = serializeLesson(lesson);
            const stats = statsByLesson.get(String(lesson._id));
            const rosterSize =
                rosterSizeByClass.get(
                    String(lesson.class?._id || lesson.class || '')
                ) || 0;
            const markedCount = stats?.total || 0;
            const attended = (stats?.present || 0) + (stats?.late || 0);

            return {
                ...serialized,
                attendance: {
                    rosterSize,
                    markedCount,
                    unmarkedCount: Math.max(0, rosterSize - markedCount),
                    present: stats?.present || 0,
                    absent: stats?.absent || 0,
                    late: stats?.late || 0,
                    excused: stats?.excused || 0,
                    attended,
                    attendanceRate: rosterSize > 0 ? (attended / rosterSize) * 100 : 0,
                    isComplete: rosterSize > 0 && markedCount === rosterSize,
                },
            };
        });

        res.json({ count: payload.length, lessons: payload });
    } catch (error) {
        next(error);
    }
};

export {
    getTeacherAttendanceSections,
    getSectionMonthlyAttendance,
    getSectionDailyAttendance,
    saveSectionDailyAttendance,
    getTeacherAttendanceLessons,
    getLessonAttendance,
    saveLessonAttendance,
};
