import {
    getTeacherGradebooks,
    getTeacherGradebook,
    saveTeacherGradebook,
} from "../controllers/teacher/gradebook.controller.js";
﻿import { Router } from "express";
import {
    getTeacherClasses,
    getTeacherClassById,
    getTeacherGuardians,
    getTeacherGuardianById,
    getTeacherCourses,
} from "../controllers/teacher/teacher.controller.js";
import {
    createLesson,
    updateLesson,
    deleteLesson,
    getTeacherLessons,
    getTeacherLessonById,
} from "../controllers/teacher/lesson.controller.js";
import {
    createHomework,
    updateHomework,
    getTeacherHomeworks,
    getTeacherHomeworkById,
} from "../controllers/teacher/homework.controller.js";
import {
    createExam,
    updateExam,
    getTeacherExams,
    getTeacherExamById,
    saveExamResults,
} from "../controllers/teacher/exam.controller.js";
import {
    getTeacherAttendanceSections,
    getSectionMonthlyAttendance,
    getSectionDailyAttendance,
    saveSectionDailyAttendance,
    getLessonAttendance,
    saveLessonAttendance,
    getTeacherAttendanceLessons,
} from "../controllers/teacher/attendance.controller.js";
import {
    createTeacherAnnouncement,
    getTeacherAnnouncements,
    updateTeacherAnnouncement,
    deleteTeacherAnnouncement,
} from "../controllers/teacher/announcement.controller.js";
import { protectTeacher } from "../middleware/teacher.middleware.js";
import {
    handleLessonUpload,
    handleHomeworkUpload,
    handleAnnouncementUpload,
} from "../middleware/multer.middleware.js";

const router = Router();

router.use(protectTeacher);

router.get("/classes", getTeacherClasses);
router.get("/classes/:id", getTeacherClassById);
router.get("/courses", getTeacherCourses);
router.get("/guardians", getTeacherGuardians);
router.get("/guardians/:id", getTeacherGuardianById);

// Materials & Lessons
router.get("/materials", getTeacherLessons);
router.post('/materials', handleLessonUpload, createLesson);
router.get('/materials/:id', getTeacherLessonById);
router.patch('/materials/:id', handleLessonUpload, updateLesson);
router.delete('/materials/:id', deleteLesson);

router.get("/lessons", getTeacherLessons);
router.post('/lessons', handleLessonUpload, createLesson);
router.get('/lessons/:id', getTeacherLessonById);
router.patch('/lessons/:id', handleLessonUpload, updateLesson);
router.delete('/lessons/:id', deleteLesson);

router.get('/homeworks', getTeacherHomeworks);
router.post('/homeworks', handleHomeworkUpload, createHomework);
router.get('/homeworks/:id', getTeacherHomeworkById);
router.patch('/homeworks/:id', handleHomeworkUpload, updateHomework);

router.get('/exams', getTeacherExams);
router.post('/exams', createExam);
router.get('/exams/:id', getTeacherExamById);
router.patch('/exams/:id', updateExam);
router.put('/exams/:id/results', saveExamResults);

// Class Gradebook / Grades routes
router.get('/grades', getTeacherGradebooks);
router.get('/grades/:classId', getTeacherGradebook);
router.put('/grades/:classId', saveTeacherGradebook);

// Section-based Daily Attendance
router.get('/attendance/sections', getTeacherAttendanceSections);
router.get('/attendance/sections/:classId/monthly', getSectionMonthlyAttendance);
router.get('/attendance/sections/:classId/date/:date', getSectionDailyAttendance);
router.put('/attendance/sections/:classId/date/:date', saveSectionDailyAttendance);

// Legacy lesson-based attendance
router.get('/attendance/lessons', getTeacherAttendanceLessons);
router.get('/attendance/lessons/:lessonId', getLessonAttendance);
router.put('/attendance/lessons/:lessonId', saveLessonAttendance);

// Teacher Announcements
router.get('/announcements', getTeacherAnnouncements);
router.post('/announcements', handleAnnouncementUpload, createTeacherAnnouncement);
router.patch('/announcements/:id', handleAnnouncementUpload, updateTeacherAnnouncement);
router.delete('/announcements/:id', deleteTeacherAnnouncement);

export default router;
