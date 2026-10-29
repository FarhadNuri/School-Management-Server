import Routine from '../../models/routine.model.js';
import Student from '../../models/student.model.js';
import Guardian from '../../models/guardian.model.js';
import Teacher from '../../models/teacher.model.js';

export const getMyRoutine = async (req, res, next) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    // Role: STUDENT
    if (user.role === 'student') {
      const student = await Student.findOne({ user: user._id })
        .populate('class')
        .lean();

      if (!student || !student.class) {
        return res.json({
          success: true,
          role: 'student',
          routine: null,
          message: 'No class assigned to student'
        });
      }

      const routine = await Routine.findOne({
        type: 'class',
        class: student.class._id
      })
        .populate('class')
        .lean();

      return res.json({
        success: true,
        role: 'student',
        student: {
          id: student._id,
          classId: student.class._id,
          className: student.class.className,
          classCode: student.class.classCode
        },
        routine
      });
    }

    // Role: GUARDIAN
    if (user.role === 'guardian') {
      const guardian = await Guardian.findOne({ user: user._id })
        .populate({
          path: 'students',
          populate: [
            { path: 'user', select: 'firstName lastName photo' },
            { path: 'class', select: 'className classCode grade' }
          ]
        })
        .lean();

      if (!guardian || !guardian.students || guardian.students.length === 0) {
        return res.json({
          success: true,
          role: 'guardian',
          wards: [],
          routine: null
        });
      }

      // Collect routines for all linked wards
      const wardsWithRoutines = await Promise.all(
        guardian.students.map(async (st) => {
          let wardRoutine = null;
          if (st.class && st.class._id) {
            wardRoutine = await Routine.findOne({
              type: 'class',
              class: st.class._id
            }).lean();
          }

          const studentName = st.user
            ? [st.user.firstName, st.user.lastName].filter(Boolean).join(' ')
            : 'Child';

          return {
            studentId: String(st._id),
            studentName,
            photo: st.user?.photo || '',
            classId: st.class?._id ? String(st.class._id) : null,
            className: st.class?.className || 'Unassigned',
            classCode: st.class?.classCode || '',
            routine: wardRoutine
          };
        })
      );

      const requestedStudentId = req.query.studentId;
      let activeWard = wardsWithRoutines[0];
      if (requestedStudentId) {
        const found = wardsWithRoutines.find((w) => w.studentId === requestedStudentId);
        if (found) activeWard = found;
      }

      return res.json({
        success: true,
        role: 'guardian',
        wards: wardsWithRoutines,
        activeStudentId: activeWard?.studentId || null,
        routine: activeWard?.routine || null
      });
    }

    // Role: TEACHER
    if (user.role === 'teacher') {
      const teacher = await Teacher.findOne({ user: user._id }).lean();
      if (!teacher) {
        return res.json({
          success: true,
          role: 'teacher',
          routine: null
        });
      }

      const routine = await Routine.findOne({
        type: 'teacher',
        teacher: teacher._id
      }).lean();

      return res.json({
        success: true,
        role: 'teacher',
        routine
      });
    }

    return res.status(403).json({ success: false, message: 'Invalid role for routine access' });
  } catch (error) {
    next(error);
  }
};
