import HomeworkModel from "../../models/homework.model.js";
import HomeworkSubmissionModel from "../../models/homeworkSubmission.model.js";
import StudentModel from "../../models/student.model.js";
import GuardianModel from "../../models/guardian.model.js";
import {
  assertValidObjectId,
  resolveAccessContext,
  serializeHomework,
  homeworkPopulate,
  buildHomeworkVisibilityQuery,
  canAccessHomework,
} from "../../utils/homeworkAccess.js";
import { uploadFileList } from "../../middleware/multer.middleware.js";

export const getMyHomeworks = async (req, res, next) => {
  try {
    const context = await resolveAccessContext(req.user);
    const query = buildHomeworkVisibilityQuery(context);

    if (query._id === null) {
      return res.json({ count: 0, homeworks: [] });
    }

    const homeworks = await HomeworkModel.find(query)
      .populate(homeworkPopulate)
      .sort({ dueDate: 1, createdAt: -1 })
      .lean();

    let submissionMap = new Map();
    let studentRecord = null;
    if (context.role === "student" && context.studentId) {
      const submissions = await HomeworkSubmissionModel.find({
        student: context.studentId,
      }).lean();
      submissions.forEach((sub) => {
        submissionMap.set(String(sub.homework), sub);
      });
    } else if (context.role === "student") {
      studentRecord = await StudentModel.findOne({ user: req.user._id }).select("_id").lean();
      if (studentRecord) {
        const submissions = await HomeworkSubmissionModel.find({
          student: studentRecord._id,
        }).lean();
        submissions.forEach((sub) => {
          submissionMap.set(String(sub.homework), sub);
        });
      } 
    } else if (context.role === "guardian") {
      const guardian = await GuardianModel.findOne({ user: req.user._id }).select("_id students").lean();
      if (guardian) {
        const wardDocs = await StudentModel.find({
          $or: [
            { _id: { $in: guardian.students || [] } },
            { guardian: guardian._id },
          ],
        }).select("_id user").populate({ path: "user", select: "firstName lastName" }).lean();

        const wardIds = wardDocs.map((w) => w._id);
        const wardNameMap = new Map();
        wardDocs.forEach((w) => {
          const name = ((w.user?.firstName || "") + " " + (w.user?.lastName || "")).trim() || "Student";
          wardNameMap.set(String(w._id), name);
        });

        if (wardIds.length > 0) {
          const submissions = await HomeworkSubmissionModel.find({
            student: { $in: wardIds },
          }).sort({ submittedAt: -1 }).lean();

          submissions.forEach((sub) => {
            if (!submissionMap.has(String(sub.homework))) {
              sub.studentName = wardNameMap.get(String(sub.student)) || "Student";
              submissionMap.set(String(sub.homework), sub);
            }
          });
        }
      }
    }

    const homeworkIds = homeworks.map((h) => h._id);
    const submissionCounts = await HomeworkSubmissionModel.aggregate([
      { $match: { homework: { $in: homeworkIds } } },
      { $group: { _id: "$homework", count: { $sum: 1 } } },
    ]);
    const countsMap = new Map();
    submissionCounts.forEach((sc) => countsMap.set(String(sc._id), sc.count));

    const now = new Date();

    const serialized = homeworks.map((h) => {
      const base = serializeHomework(h);
      const sub = submissionMap.get(String(h._id));
      const isPastDue = Boolean(h.dueDate && now.getTime() > new Date(h.dueDate).getTime());
      const submittedCount = countsMap.get(String(h._id)) || 0;

      return {
        ...base,
        isSubmitted: Boolean(sub),
        isDone: Boolean(sub),
        isPastDue,
        canSubmit: !isPastDue,
        submittedCount,
        submission: sub
          ? {
              id: String(sub._id),
              studentId: String(sub.student?._id || sub.student || ""),
              studentName: sub.studentName || "",
              link: sub.link || null,
              fileUrl: sub.fileUrl || null,
              fileName: sub.fileName || "Attachment",
              fileType: sub.fileType || "",
              fileSize: sub.fileSize || 0,
              comment: sub.comment || "",
              status: sub.status || "submitted",
              submittedAt: sub.submittedAt,
              resubmittedAt: sub.resubmittedAt,
              isResubmitted: sub.isResubmitted || false,
            }
          : null,
      };
    });

    res.json({
      count: serialized.length,
      homeworks: serialized,
    });
  } catch (error) {
    next(error);
  }
};

export const getMyHomeworkById = async (req, res, next) => {
  try {
    const { id } = req.params;
    assertValidObjectId(id, "homework ID");

    const context = await resolveAccessContext(req.user);
    const homework = await HomeworkModel.findOne({
      _id: id,
      isActive: true,
    })
      .populate(homeworkPopulate)
      .lean();

    if (!homework || !canAccessHomework(homework, context)) {
      return res.status(404).json({ message: "Homework not found" });
    }

    const base = serializeHomework(homework);
    let submission = null;
    let studentId = context.studentId;
    if (!studentId && context.role === "student") {
      const s = await StudentModel.findOne({ user: req.user._id }).select("_id").lean();
      studentId = s ? s._id : null;
    }

    if (studentId) {
      const sub = await HomeworkSubmissionModel.findOne({
        homework: homework._id,
        student: studentId,
      }).lean();
      if (sub) {
        submission = {
          id: String(sub._id),
          studentId: String(sub.student),
          link: sub.link || null,
          fileUrl: sub.fileUrl || null,
          fileName: sub.fileName || "Attachment",
          fileType: sub.fileType || "",
          fileSize: sub.fileSize || 0,
          comment: sub.comment || "",
          status: sub.status || "submitted",
          submittedAt: sub.submittedAt,
          resubmittedAt: sub.resubmittedAt,
          isResubmitted: sub.isResubmitted || false,
        };
      }
    } else if (context.role === "guardian") {
      const guardian = await GuardianModel.findOne({ user: req.user._id }).select("_id students").lean();
      if (guardian) {
        const wardDocs = await StudentModel.find({
          $or: [
            { _id: { $in: guardian.students || [] } },
            { guardian: guardian._id },
          ],
        }).select("_id user").populate({ path: "user", select: "firstName lastName" }).lean();
        const wardIds = wardDocs.map((w) => w._id);
        if (wardIds.length > 0) {
          const sub = await HomeworkSubmissionModel.findOne({
            homework: homework._id,
            student: { $in: wardIds },
          }).sort({ submittedAt: -1 }).lean();
          if (sub) {
            const matchedWard = wardDocs.find((w) => String(w._id) === String(sub.student));
            const studentName = matchedWard
              ? `${matchedWard.user?.firstName || ''} ${matchedWard.user?.lastName || ''}`.trim()
              : 'Student';
            submission = {
              id: String(sub._id),
              studentId: String(sub.student),
              studentName,
              link: sub.link || null,
              fileUrl: sub.fileUrl || null,
              fileName: sub.fileName || "Attachment",
              fileType: sub.fileType || "",
              fileSize: sub.fileSize || 0,
              comment: sub.comment || "",
              status: sub.status || "submitted",
              submittedAt: sub.submittedAt,
              resubmittedAt: sub.resubmittedAt,
              isResubmitted: sub.isResubmitted || false,
            };
          }
        }
      }
    }

    const isPastDue = Boolean(homework.dueDate && new Date() > new Date(homework.dueDate));

    res.json({
      homework: {
        ...base,
        isSubmitted: Boolean(submission),
        isDone: Boolean(submission),
        isPastDue,
        canSubmit: !isPastDue,
        submission,
      },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    next(error);
  }
};

export const submitHomework = async (req, res, next) => {
  try {
    const { id } = req.params;
    assertValidObjectId(id, "homework ID");

    if (req.user.role !== "student") {
      return res.status(403).json({ message: "Only enrolled students can submit homework" });
    }

    const student = await StudentModel.findOne({ user: req.user._id }).lean();
    if (!student) {
      return res.status(403).json({ message: "Student profile not found" });
    }

    const homework = await HomeworkModel.findById(id).lean();
    if (!homework || !homework.isActive) {
      return res.status(404).json({ message: "Homework not found or inactive" });
    }

    if (String(student.class) !== String(homework.class)) {
      return res.status(403).json({ message: "You are not enrolled in the class assigned to this homework" });
    }

    if (homework.dueDate && new Date() > new Date(homework.dueDate)) {
      return res.status(400).json({
        message: "The submission deadline for this homework has passed. Late submissions are not accepted.",
      });
    }

    let fileUrl = "";
    let fileName = "";
    let fileType = "";
    let fileSize = 0;

    if (req.files && req.files.length > 0) {
      const uploaded = await uploadFileList(req.files, "submissions");
      if (uploaded && uploaded.length > 0) {
        fileUrl = uploaded[0];
        fileName = req.files[0].originalname || "Submission Document";
        fileType = req.files[0].mimetype || "";
        fileSize = req.files[0].size || 0;
      }
    }

    const link = (req.body.link || "").trim();
    const comment = (req.body.comment || req.body.notes || "").trim();

    let submission = await HomeworkSubmissionModel.findOne({
      homework: homework._id,
      student: student._id,
    });

    if (!fileUrl && !link && !submission) {
      return res.status(400).json({
        message: "Please provide either a submission link or upload an image, PDF, or Word document.",
      });
    }

    if (submission) {
      if (fileUrl) {
        submission.fileUrl = fileUrl;
        submission.fileName = fileName;
        submission.fileType = fileType;
        submission.fileSize = fileSize;
      }
      if (link) {
        submission.link = link;
      }
      if (comment !== undefined) {
        submission.comment = comment;
      }
      submission.isResubmitted = true;
      submission.resubmittedAt = new Date();
      submission.status = "submitted";
      await submission.save();
    } else {
      submission = await HomeworkSubmissionModel.create({
        homework: homework._id,
        student: student._id,
        class: homework.class,
        link,
        fileUrl,
        fileName,
        fileType,
        fileSize,
        comment,
        submittedAt: new Date(),
        status: "submitted",
      });
    }

    res.json({
      message: submission.isResubmitted
        ? "Homework resubmitted successfully"
        : "Homework submitted successfully",
      submission: {
        id: String(submission._id),
        link: submission.link,
        fileUrl: submission.fileUrl,
        fileName: submission.fileName,
        fileType: submission.fileType,
        fileSize: submission.fileSize,
        comment: submission.comment,
        submittedAt: submission.submittedAt,
        resubmittedAt: submission.resubmittedAt,
        isResubmitted: submission.isResubmitted,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getHomeworkSubmissions = async (req, res, next) => {
  try {
    const { id } = req.params;
    assertValidObjectId(id, "homework ID");

    const homework = await HomeworkModel.findById(id)
      .populate("class", "className classCode grade")
      .populate("course", "courseName courseCode")
      .populate({
        path: "teacher",
        populate: { path: "user", select: "firstName lastName email photo" },
      })
      .lean();

    if (!homework) {
      return res.status(404).json({ message: "Homework not found" });
    }

    const targetClassId = homework.class ? (homework.class._id || homework.class) : null;
    const students = await StudentModel.find({ class: targetClassId })
      .populate({
        path: "user",
        select: "firstName lastName email photo isActive isDeleted",
      })
      .sort({ createdAt: 1 })
      .lean();

    const submissions = await HomeworkSubmissionModel.find({ homework: homework._id }).lean();
    const submissionMap = new Map();
    submissions.forEach((sub) => {
      submissionMap.set(String(sub.student), sub);
    });

    const studentList = students
      .filter((s) => s.user && !s.user.isDeleted)
      .map((s) => {
        const sub = submissionMap.get(String(s._id));
        const isSubmitted = Boolean(sub);
        const fullName = ((s.user.firstName || "") + " " + (s.user.lastName || "")).trim() || "Student";

        return {
          studentId: String(s._id),
          studentName: fullName,
          email: s.user.email || "",
          photo: s.user.photo || null,
          isSubmitted,
          statusTag: isSubmitted ? "Submitted" : "Not Submitted",
          submission: sub
            ? {
                id: String(sub._id),
                link: sub.link || null,
                fileUrl: sub.fileUrl || null,
                fileName: sub.fileName || "Submission Attachment",
                fileType: sub.fileType || "",
                fileSize: sub.fileSize || 0,
                comment: sub.comment || "",
                submittedAt: sub.submittedAt,
                resubmittedAt: sub.resubmittedAt,
                isResubmitted: sub.isResubmitted || false,
              }
            : null,
        };
      });

    const totalAssigned = studentList.length;
    const submittedCount = studentList.filter((s) => s.isSubmitted).length;
    const notSubmittedCount = totalAssigned - submittedCount;

    res.json({
      homework: {
        id: String(homework._id),
        title: homework.title,
        subject: homework.subject,
        className: homework.class ? (homework.class.className || "") : "",
        classCode: homework.class ? (homework.class.classCode || "") : "",
        dueDate: homework.dueDate,
        instructions: homework.instructions,
      },
      totalAssigned,
      submittedCount,
      notSubmittedCount,
      students: studentList,
    });
  } catch (error) {
    next(error);
  }
};
