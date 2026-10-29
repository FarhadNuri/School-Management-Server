import mongoose from "mongoose";
import GuardianModel from '../../models/guardian.model.js';

import LessonModel from '../../models/lesson.model.js';
import {
    resolveAccessContext,
    getAccessibleCourses,
    buildLessonVisibilityQuery,
    lessonPopulate,
    serializeLesson,
    assertValidObjectId,
    canAccessLesson,
} from '../../utils/lessonAccess.js';


export const getMyCourses = async (req, res, next) => {
    try {
        const context = await resolveAccessContext(req.user);
        const courses = await getAccessibleCourses(context, req.query);

        let wards = [];
        if (req.user.role === "guardian") {
            const guardian = await GuardianModel.findOne({ user: req.user._id })
                .populate({
                    path: "students",
                    populate: [
                        { path: "user", select: "firstName lastName email" },
                        { path: "class", select: "className grade classCode" },
                    ],
                })
                .lean();

            if (guardian && guardian.students) {
                wards = guardian.students
                    .filter((s) => s && s.user && !s.user.isDeleted)
                    .map((s) => ({
                        studentId: String(s._id),
                        studentName: ((s.user.firstName || "") + " " + (s.user.lastName || "")).trim() || "Student",
                        classId: s.class && s.class._id ? String(s.class._id) : "",
                        className: s.class && s.class.className ? s.class.className : "",
                        grade: s.class ? s.class.grade : undefined,
                    }));
            }
        }

        res.json({
            count: courses.length,
            courses,
            wards,
        });
    } catch (error) {
        next(error);
    }
};

export const getMyLessons = async (req, res, next) => {
    try {
        const context = await resolveAccessContext(req.user);
        const query = buildLessonVisibilityQuery(context);

        if (query._id === null) {
            return res.json({ count: 0, lessons: [] });
        }

        const lessons = await LessonModel.find(query)
            .populate(lessonPopulate)
            .sort({ scheduledAt: 1 })
            .lean();

        const serialized = lessons.map(serializeLesson);

        res.json({
            count: serialized.length,
            lessons: serialized,
        });
    } catch (error) {
        next(error);
    }
};

export const getMyLessonById = async (req, res, next) => {
    try {
        const { id } = req.params;
        assertValidObjectId(id, 'lesson ID');

        const context = await resolveAccessContext(req.user);
        const lesson = await LessonModel.findOne({
            _id: id,
            isActive: true,
        })
            .populate(lessonPopulate)
            .lean();

        if (!lesson || !canAccessLesson(lesson, context)) {
            return res.status(404).json({ message: 'Lesson not found' });
        }

        res.json({ lesson: serializeLesson(lesson) });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ message: error.message });
        }
        next(error);
    };
}
export const getMyCourseById = async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid course ID" });
        }

        const CourseModel = (await import("../../models/course.model.js")).default;
        const course = await CourseModel.findById(id)
            .populate("courseClass", "className classCode grade academicYear isActive")
            .populate({
                path: "courseTeachers",
                populate: {
                    path: "user",
                    select: "firstName lastName email photo isActive",
                },
            })
            .populate({
                path: "courseStudents",
                populate: {
                    path: "user",
                    select: "firstName lastName email photo isActive",
                },
            })
            .lean();

        if (!course) {
            return res.status(404).json({ message: "Course not found" });
        }

        const teachers = course.courseTeachers || [];
        const students = course.courseStudents || [];
        const classItem = course.courseClass || {};
        const teacherNames = teachers
            .map((t) => (t.user ? ((t.user.firstName || "") + " " + (t.user.lastName || "")).trim() : "Teacher"))
            .filter(Boolean)
            .join(", ");

        const adapted = {
            id: String(course._id),
            _id: course._id,
            name: course.courseName,
            courseName: course.courseName,
            code: course.courseCode,
            courseCode: course.courseCode,
            shortCode: course.courseName.replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase() || "CRS",
            type: course.courseType || "Core",
            status: course.courseStatus || "Active",
            isActive: course.courseStatus === "Active",
            description: course.courseDescription || "",
            coverImage: course.coverImage || null,
            class: classItem.className || "—",
            className: classItem.className || "—",
            grade: classItem.grade != null ? "Class " + classItem.grade : "",
            classId: classItem._id ? String(classItem._id) : "",
            teacher: teacherNames || "No teacher assigned",
            teachers,
            enrolled: String(students.length),
            students,
        };

        res.json({ course: adapted });
    } catch (error) {
        next(error);
    }
};

