import mongoose from 'mongoose';
import GradebookModel from '../../models/gradebook.model.js';
import StudentModel from '../../models/student.model.js';
import ClassModel from '../../models/class.model.js';
import GuardianModel from '../../models/guardian.model.js';
import '../../models/teacher.model.js';
import '../../models/user.model.js';
import { resolveAccessContext } from '../../utils/lessonAccess.js';

const calculateLetterGrade = (obtained, max) => {
  if (!max || max <= 0) return { grade: '—', color: '#94A3B8' };
  const pct = (obtained / max) * 100;
  if (pct >= 90) return { grade: 'A+', color: '#22C55E' };
  if (pct >= 80) return { grade: 'A', color: '#14B8A6' };
  if (pct >= 70) return { grade: 'B', color: '#38BDF8' };
  if (pct >= 60) return { grade: 'C', color: '#FBBF24' };
  if (pct >= 50) return { grade: 'D', color: '#FB923C' };
  return { grade: 'F', color: '#EF4444' };
};

// GET /api/user/grades
export const getMyGrades = async (req, res, next) => {
  try {
    const context = await resolveAccessContext(req.user);

    if (context.role !== 'student' && context.role !== 'guardian') {
      return res.status(403).json({ message: 'Access denied. Student or Guardian role required.' });
    }

    let targetStudentId = context.studentId;
    let classIds = context.classIds || [];

    // If guardian requested specific student or find their wards
    if (context.role === 'guardian') {
      const guardian = await GuardianModel.findOne({ user: req.user._id }).select('students').lean();
      const allWardIds = [
        ...new Set([
          ...(context.wardIds || []),
          ...(guardian?.students || []).map(String)
        ])
      ].filter(Boolean);

      let chosenWardId = req.query.studentId;

      if (!chosenWardId && allWardIds.length > 0) {
        // If guardian has multiple wards, check which ward has published gradebooks!
        const allWards = await StudentModel.find({ _id: { $in: allWardIds } }).select('_id class').lean();
        const wardClassIds = allWards.map(w => w.class).filter(Boolean);
        
        // Find published gradebooks across all wards' classes
        const publishedGbs = await GradebookModel.find({
          class: { $in: wardClassIds },
          isPublished: true
        }).select('class grades.student').lean();

        if (publishedGbs.length > 0) {
          // Find the ward that actually has grades in the published gradebook!
          const wardWithGrades = allWards.find(w => {
            const wIdStr = String(w._id);
            return publishedGbs.some(gb => 
              String(gb.class) === String(w.class) &&
              (gb.grades || []).some(g => String(g.student?._id || g.student) === wIdStr)
            );
          });
          chosenWardId = wardWithGrades?._id || allWardIds[0];
        } else {
          chosenWardId = allWardIds[0];
        }
      }

      if (chosenWardId) {
        targetStudentId = chosenWardId;
        const studentDoc = await StudentModel.findById(chosenWardId).select('class').lean();
        if (studentDoc?.class) classIds = [studentDoc.class.toString()];
      }
    }

    if (!classIds.length || !targetStudentId) {
      return res.json({
        isPublished: false,
        message: 'No enrolled class found for this student.',
        subjects: []
      });
    }

    // Find all gradebooks for the enrolled class
    const gradebooks = await GradebookModel.find({
      class: { $in: classIds.map((id) => new mongoose.Types.ObjectId(id)) }
    })
      .populate('class', 'className classCode grade academicYear')
      .populate({
        path: 'teacher',
        select: 'user',
        populate: {
          path: 'user',
          select: 'firstName lastName email'
        }
      })
      .sort({ subject: 1 })
      .lean();

    // Check publication status:
    // User requirement: "students will by default see Grades not yet published in the Grade Section.
    // when admin clicks publish Gradebook, that student will get to see his individual results from that publish result"
    const publishedGradebooks = gradebooks.filter((g) => Boolean(g.isPublished));

    if (publishedGradebooks.length === 0) {
      return res.json({
        isPublished: false,
        message: 'Grades not yet published',
        subjects: [],
        totalGradebooks: gradebooks.length
      });
    }

    // Process published gradebooks for this student
    const studentObjectIdStr = String(targetStudentId);

    const subjectResults = publishedGradebooks.map((gb) => {
      const teacherUser = gb.teacher?.user || {};
      const teacherName = `${teacherUser.firstName || ''} ${teacherUser.lastName || ''}`.trim() || 'Instructor';

      // Find this student's grade entry
      const studentEntry = (gb.grades || []).find((g) => {
        const sId = String(g.student?._id || g.student || '');
        return sId === studentObjectIdStr;
      });

      const scoresObj = studentEntry?.scores instanceof Map
        ? Object.fromEntries(studentEntry.scores)
        : (studentEntry?.scores && typeof studentEntry.scores === 'object' ? studentEntry.scores : {});

      let totalObtained = 0;
      let totalMax = 0;

      const assessmentBreakdown = (gb.assessments || []).map((asmt) => {
        const rawScore = scoresObj[asmt.id];
        const hasScore = rawScore !== undefined && rawScore !== null && rawScore !== '';
        const obtainedMarks = hasScore ? Number(rawScore) : 0;
        const maxMarks = Number(asmt.maxMarks) || 100;

        if (hasScore) {
          totalObtained += obtainedMarks;
        }
        totalMax += maxMarks;

        return {
          id: asmt.id,
          name: asmt.name,
          type: asmt.type,
          maxMarks,
          score: hasScore ? obtainedMarks : null,
          obtainedMarks: hasScore ? obtainedMarks : null,
          hasScore,
          percentage: maxMarks > 0 && hasScore ? Math.round((obtainedMarks / maxMarks) * 100) : 0,
          date: asmt.date
        };
      });

      const percentage = totalMax > 0 ? Number(((totalObtained / totalMax) * 100).toFixed(1)) : 0;
      const letterInfo = calculateLetterGrade(totalObtained, totalMax);

      return {
        id: gb._id,
        gradebookId: gb._id,
        subject: gb.subject || 'Subject',
        courseCode: gb.courseCode || '',
        className: gb.class?.className || 'Class',
        teacherName,
        assessments: assessmentBreakdown,
        totalObtained,
        totalMax,
        totalMaxMarks: totalMax,
        percentage,
        letterGrade: letterInfo.grade,
        gradeColor: letterInfo.color,
        remarks: studentEntry?.remarks || '',
        publishedAt: gb.publishedAt
      };
    });

    // Compute overall GPA/Average across all published subjects
    const overallMax = subjectResults.reduce((acc, s) => acc + s.totalMax, 0);
    const overallObtained = subjectResults.reduce((acc, s) => acc + s.totalObtained, 0);
    const overallPercentage = overallMax > 0 ? Number(((overallObtained / overallMax) * 100).toFixed(1)) : 0;
    const overallGrade = calculateLetterGrade(overallObtained, overallMax);

    res.json({
      isPublished: true,
      message: 'Published grades retrieved successfully',
      className: gradebooks[0]?.class?.className || '',
      overall: {
        totalObtained: overallObtained,
        totalMax: overallMax,
        percentage: overallPercentage,
        letterGrade: overallGrade.grade,
        gradeColor: overallGrade.color,
        totalSubjects: subjectResults.length
      },
      subjects: subjectResults
    });
  } catch (error) {
    next(error);
  }
};
