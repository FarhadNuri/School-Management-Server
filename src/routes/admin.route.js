import mailer from "../utils/Mailer.js";
import {
  getAdminRoutines,
  getAdminRoutineById,
  createAdminRoutine,
  updateAdminRoutine,
  deleteAdminRoutine
} from '../controllers/admin/routine.controller.js';
import {
  getAdminGradebooks,
  getAdminGradebookById,
  updateAdminGradebook,
  togglePublishGradebook
} from '../controllers/admin/gradebook.controller.js';
import { Router } from "express";   
import {loginAdmin} from '../controllers/admin/admin.controller.js'
import { admminProtector } from "../middleware/admin.middleware.js";
import { getMe,changePassword,updateMyPhoto } from "../controllers/admin/admin.controller.js";
import { handleClassUpload, handleCourseUpload, handleUserPhotoUpload } from "../middleware/multer.middleware.js";
import { getAdminDashboard } from "../controllers/admin/dashboard.controller.js";
import { handleAnnouncementUpload } from "../middleware/multer.middleware.js";
import { addAnnouncement, getAnnouncements, updateAnnouncement, getAnnouncementById, deleteAnnouncement } from '../controllers/admin/announcement.controller.js';
import { addClass, getClasses, getClassById, updateClass, deleteClass } from "../controllers/admin/class.controller.js"
import { getComplaints, getComplaintById, updateComplaintStatus, deleteComplaint } from '../controllers/admin/complaint.controller.js';
import { addCourse, getCourses, getCourseById, updateCourse, deleteCourse } from "../controllers/admin/course.controller.js";
import { addStudent, getStudents, getStudentById, setStudentStatus, updateStudent, deleteStudent, resetStudentPassword } from '../controllers/admin/student.controller.js'
import { getGuardianById, getGuardians, setGuardianStatus, updateGuardian, deleteGuardian, resetGuardianPassword } from '../controllers/admin/guardian.controller.js'
import { addTeacher, getTeachers, getTeacherById, setTeacherStatus, updateTeacher, deleteTeacher, resetTeacherPassword } from '../controllers/admin/teacher.controller.js'
import {createInvoice, getPayments, getPaymentById, updatePayment, resendInvoice, cancelPayment} from '../controllers/admin/payment.controller.js'
import { handleStudentUpload, handleTeacherUpload   } from "../middleware/multer.middleware.js";

const router = Router()

//public
router.post('/login',loginAdmin)

//protected
router.post('/test-email', async (req, res) => {
    try {
        const to = req.body?.to || 'farhadnuri559@gmail.com';
        const result = await mailer.sendEmail({
            to,
            subject: 'School Management Email Test',
            text: 'This is a test email from the Admin Portal.',
            html: '<p>This is a test email verifying email delivery.</p>',
        });
        res.json({ success: true, message: 'Email delivered successfully', result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.use(admminProtector)

//admin profile & dashboard
router.get('/me',getMe)
router.patch('/me/password',changePassword)
router.get('/dashboard',getAdminDashboard)
router.patch('/me/photo',handleUserPhotoUpload, updateMyPhoto)

//admin announcements
router.post('/announcements', handleAnnouncementUpload, addAnnouncement)
router.get('/announcements',getAnnouncements)
router.get('/announcements/:id',getAnnouncementById)
router.patch('/announcements/:id', handleAnnouncementUpload, updateAnnouncement)
router.delete('/announcements/:id', deleteAnnouncement)


//class routes
router.post('/classes',handleClassUpload,addClass)
router.get('/classes',getClasses)
router.get('/classes/:id',getClassById)
router.patch('/classes/:id',handleClassUpload,updateClass)
router.delete('/classes/:id', deleteClass)

//complaint route
router.get('/complaints',getComplaints)
router.get('/complaints/:id',getComplaintById)
router.patch('/complaints/:id/status', updateComplaintStatus)
router.delete('/complaints/:id', deleteComplaint)

//course routes
router.post('/courses', handleCourseUpload, addCourse)
router.get('/courses',getCourses)
router.get('/courses/:id',getCourseById)
router.patch('/courses/:id', handleCourseUpload, updateCourse)
router.delete('/courses/:id', deleteCourse)


// STUDENT ROUTES FOR admin
router.post('/students', handleStudentUpload, addStudent);
router.get('/students', getStudents);
router.get('/students/:id', getStudentById);
router.patch('/students/:id/status', setStudentStatus);
router.patch('/students/:id', handleStudentUpload, updateStudent);
router.delete('/students/:id', deleteStudent);
router.patch('/students/:id/reset-password', resetStudentPassword);

// GUARDIAN ROUTES for admin
router.get('/guardians', getGuardians);
router.get('/guardians/:id', getGuardianById);
router.patch('/guardians/:id/status', setGuardianStatus);
router.patch('/guardians/:id', updateGuardian);
router.delete('/guardians/:id', deleteGuardian);
router.patch('/guardians/:id/reset-password', resetGuardianPassword);

// TEACHER ROUTES for admin
router.post('/teachers', handleTeacherUpload, addTeacher);
router.get('/teachers', getTeachers);
router.get('/teachers/:id', getTeacherById);
router.patch('/teachers/:id/status', setTeacherStatus);
router.patch('/teachers/:id', handleTeacherUpload, updateTeacher);
router.delete('/teachers/:id', deleteTeacher);
router.patch('/teachers/:id/reset-password', resetTeacherPassword);


// PAYMENT / INVOICE ROUTES for admin
router.post('/payments', createInvoice);
router.get('/payments', getPayments);
router.get('/payments/:id', getPaymentById);
router.patch('/payments/:id', updatePayment);
router.post('/payments/:id/resend', resendInvoice);
router.post('/payments/:id/cancel', cancelPayment);



// ROUTINE ROUTES
router.get('/routines', admminProtector, getAdminRoutines);
router.get('/routines/:id', admminProtector, getAdminRoutineById);
router.post('/routines', admminProtector, createAdminRoutine);
router.put('/routines/:id', admminProtector, updateAdminRoutine);
router.patch('/routines/:id', admminProtector, updateAdminRoutine);
router.delete('/routines/:id', admminProtector, deleteAdminRoutine);

export default router
// Publish Grades / Gradebooks Management
router.get('/grades', admminProtector, getAdminGradebooks);
router.get('/grades/:id', admminProtector, getAdminGradebookById);
router.put('/grades/:id', admminProtector, updateAdminGradebook);
router.patch('/grades/:id/publish', admminProtector, togglePublishGradebook);
