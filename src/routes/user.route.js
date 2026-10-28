import { getMyGrades } from '../controllers/user/grade.controller.js';
import { Router } from 'express';
import { loginUser, getMe, changePassword } from '../controllers/user.controller.js';
import { protectUser } from '../middleware/user.middleware.js';
import { handleComplaintUpload } from '../middleware/multer.middleware.js';
import { makeComplaint, getComplaints, getComplaintById, updateComplaint } from '../controllers/user/user.controller.js';
import { getMyHomeworkById, getMyHomeworks } from '../controllers/user/homework.controller.js';
import { getMyExams, getMyExamById } from '../controllers/user/exam.controller.js';
import { getMyCourses, getMyLessons, getMyLessonById } from '../controllers/user/lesson.controller.js';
import { getMyStudents, getMyStudentById } from '../controllers/user/student.controller.js';
import { getMyAnnouncements, getMyAnnouncementById } from '../controllers/user/announcement.controller.js';
import { getMyAttendance, getMyAttendanceSummary, getMyAttendanceWards, getMyLessonAttendance } from '../controllers/user/attendance.controller.js';
import { getMyPayments, confirmCheckoutSession, getMyPaymentById, checkoutPayment, syncMyPayment } from '../controllers/user/payment.controller.js';
import { getMyDashboard } from '../controllers/user/dashboard.controller.js';


const router = Router() ;

router.post('/login', loginUser);

router.get('/me', protectUser, getMe);
router.patch('/change-password', protectUser, changePassword);

router.post('/complaint', protectUser, handleComplaintUpload, makeComplaint);
router.get('/complaints', protectUser, getComplaints);
router.get('/complaint/:id', protectUser, getComplaintById);
router.patch('/complaint/:id', protectUser, handleComplaintUpload, updateComplaint);


router.get('/courses', protectUser, getMyCourses);
router.get('/materials', protectUser, getMyLessons);
router.get('/materials/:id', protectUser, getMyLessonById);
router.get('/lessons', protectUser, getMyLessons);
router.get('/lessons/:id', protectUser, getMyLessonById);


router.get('/homeworks', protectUser, getMyHomeworks);
router.get('/homeworks/:id', protectUser, getMyHomeworkById);
router.get('/exams', protectUser, getMyExams);
router.get('/exams/:id', protectUser, getMyExamById);

router.get('/students', protectUser, getMyStudents);
router.get('/students/:id', protectUser, getMyStudentById);


router.get('/announcements', protectUser, getMyAnnouncements);
router.get('/announcements/:id', protectUser, getMyAnnouncementById);

router.get('/attendance', protectUser, getMyAttendance);
router.get('/attendance/summary', protectUser, getMyAttendanceSummary);
router.get('/attendance/wards', protectUser, getMyAttendanceWards);
router.get('/attendance/lessons/:lessonId', protectUser, getMyLessonAttendance);

router.get('/payments', protectUser, getMyPayments);
router.get('/payments/checkout-session/:sessionId', protectUser, confirmCheckoutSession);
router.get('/payments/:id', protectUser, getMyPaymentById);
router.post('/payments/:id/checkout', protectUser, checkoutPayment);
router.post('/payments/:id/sync', protectUser, syncMyPayment);

router.get('/dashboard', protectUser, getMyDashboard);



router.get('/grades', protectUser, getMyGrades);

export default router;
