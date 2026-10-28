import LessonModel from "../../models/lesson.model.js";
import ClassModel from "../../models/class.model.js";
import CourseModel from "../../models/course.model.js";
import {
  assertValidObjectId,
  isAssignedClass,
  serializeLesson,
  lessonPopulate,
} from "../../utils/lessonAccess.js";
import {
  uploadFileList,
  deleteFromCloudinaryMany,
} from "../../middleware/multer.middleware.js";

const MAX_MATERIALS = 10;
const NOTES_MAX = 5000;
const TEACHER_NOTES_MAX = 1000;

const toBoundedText = (value, maxLength) => {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  return String(raw ?? '')
    .trim()
    .slice(0, maxLength);
};

const parseMaybeJson = (value) => {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  if (!trimmed) return value;

  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
};

const toMaterialUrls = (value) => {
  if (value == null || value === '') return [];

  const parsed = parseMaybeJson(value);
  const items = Array.isArray(parsed) ? parsed : [parsed];

  return [
    ...new Set(
      items
        .map((item) => String(item || '').trim())
        .filter((item) => item.length > 0 && item.length <= 500)
    ),
  ].slice(0, MAX_MATERIALS);
};

const getAssignedClassOrThrow = async (classId, teacher) => {
  assertValidObjectId(classId, 'class ID');

  const classItem = await ClassModel.findById(classId)
    .select('className classCode grade academicYear isActive teachers courses')
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

const resolveCourseForClass = async (courseId, classItem, teacherId) => {
  assertValidObjectId(courseId, 'course ID');

  const course = await CourseModel.findById(courseId)
    .select('courseName courseCode courseStatus courseClass courseTeachers')
    .lean();

  if (!course || course.courseStatus !== 'Active') {
    const error = new Error('Course not found or inactive');
    error.statusCode = 404;
    throw error;
  }

  const teachesCourse = (course.courseTeachers || []).some(
    (id) => String(id) === String(teacherId)
  );

  if (!teachesCourse) {
    const error = new Error('You are not assigned to teach this subject/course.');
    error.statusCode = 403;
    throw error;
  }

  return course;
};

const parseLessonInput = async (
  body,
  teacher,
  { existingMaterials = [] } = {}
) => {
  const {
    title,
    subject,
    classId,
    courseId,
    scheduledAt,
    durationMinutes,
    notes,
    teacherNotes,
    materials,
  } = body || {};

  const cleanTitle = toBoundedText(title, 100);
  if (!cleanTitle) {
    const error = new Error('Title is required');
    error.statusCode = 400;
    throw error;
  }

  const scheduled = scheduledAt ? new Date(scheduledAt) : new Date();
  if (Number.isNaN(scheduled.getTime())) {
    const error = new Error('Invalid scheduled date/time');
    error.statusCode = 400;
    throw error;
  }

  const duration = durationMinutes ? Number(durationMinutes) : 45;
  if (Number.isNaN(duration) || duration < 1 || duration > 480) {
    const error = new Error('Duration must be between 1 and 480 minutes');
    error.statusCode = 400;
    throw error;
  }

  const classItem = await getAssignedClassOrThrow(classId, teacher);

  let course = null;
  let subjectName = toBoundedText(subject, 50);

  if (courseId) {
    course = await resolveCourseForClass(courseId, classItem, teacher._id);
    subjectName = course.courseCode ? `${course.courseCode} - ${course.courseName}` : course.courseName;
  }

  if (!subjectName) {
    // If subject is omitted, default to class code or general
    subjectName = classItem.className || 'General';
  }

  const parsedMaterials = toMaterialUrls(materials);
  const combinedMaterials = [
    ...new Set([...existingMaterials, ...parsedMaterials]),
  ].slice(0, MAX_MATERIALS);

  return {
    title: cleanTitle,
    subject: subjectName,
    classId: classItem._id,
    courseId: course ? course._id : null,
    scheduledAt: scheduled,
    durationMinutes: duration,
    notes: toBoundedText(notes, NOTES_MAX),
    teacherNotes: toBoundedText(teacherNotes, TEACHER_NOTES_MAX),
    materials: combinedMaterials,
  };
};

const createLesson = async (req, res, next) => {
  const uploadedUrls = [];

  try {
    const payload = await parseLessonInput(req.body, req.teacher);
    const uploaded = await uploadFileList(req.files || [], 'lessons');
    uploadedUrls.push(...uploaded);

    const materials = [...payload.materials, ...uploaded].slice(0, MAX_MATERIALS);

    const lesson = await LessonModel.create({
      title: payload.title,
      subject: payload.subject,
      course: payload.courseId,
      class: payload.classId,
      teacher: req.teacher._id,
      scheduledAt: payload.scheduledAt,
      durationMinutes: payload.durationMinutes,
      notes: payload.notes,
      teacherNotes: payload.teacherNotes,
      materials,
    });

    uploadedUrls.length = 0;

    const populated = await LessonModel.findById(lesson._id)
      .populate(lessonPopulate)
      .lean();

    res.status(201).json({
      message: 'Material uploaded successfully',
      lesson: serializeLesson(populated),
    });
  } catch (error) {
    if (uploadedUrls.length) {
      await deleteFromCloudinaryMany(uploadedUrls);
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    next(error);
  }
};

const updateLesson = async (req, res, next) => {
  const uploadedUrls = [];

  try {
    const { id } = req.params;
    assertValidObjectId(id, 'material ID');

    const existing = await LessonModel.findOne({
      _id: id,
      teacher: req.teacher._id,
      isActive: true,
    });

    if (!existing) {
      return res.status(404).json({ message: 'Material not found' });
    }

    const classId = req.body.classId || req.body.class || existing.class;
    const courseId = req.body.courseId !== undefined ? req.body.courseId : (existing.course || null);
    const title = req.body.title !== undefined ? req.body.title : existing.title;
    const subject = req.body.subject !== undefined ? req.body.subject : existing.subject;
    const scheduledAt = req.body.scheduledAt !== undefined ? req.body.scheduledAt : existing.scheduledAt;
    const durationMinutes = req.body.durationMinutes !== undefined ? req.body.durationMinutes : existing.durationMinutes;
    const notes = req.body.notes !== undefined ? req.body.notes : existing.notes;
    const teacherNotes = req.body.teacherNotes !== undefined ? req.body.teacherNotes : existing.teacherNotes;

    const payload = await parseLessonInput(
      {
        title,
        subject,
        classId,
        courseId,
        scheduledAt,
        durationMinutes,
        notes,
        teacherNotes,
        materials: req.body.materials !== undefined ? req.body.materials : existing.materials,
      },
      req.teacher,
      { existingMaterials: req.body.materials !== undefined ? [] : (existing.materials || []) }
    );

    const uploaded = await uploadFileList(req.files || [], 'lessons');
    uploadedUrls.push(...uploaded);

    const materials = [...payload.materials, ...uploaded].slice(0, MAX_MATERIALS);

    const removedMaterials = (existing.materials || []).filter(
      (url) => !materials.includes(url)
    );

    existing.title = payload.title;
    existing.subject = payload.subject;
    existing.class = payload.classId;
    existing.course = payload.courseId;
    existing.scheduledAt = payload.scheduledAt;
    existing.durationMinutes = payload.durationMinutes;
    existing.notes = payload.notes;
    existing.teacherNotes = payload.teacherNotes;
    existing.materials = materials;

    await existing.save();
    uploadedUrls.length = 0;

    if (removedMaterials.length) {
      await deleteFromCloudinaryMany(removedMaterials);
    }

    const populated = await LessonModel.findById(existing._id)
      .populate(lessonPopulate)
      .lean();

    res.json({
      message: 'Material updated successfully',
      lesson: serializeLesson(populated),
    });
  } catch (error) {
    if (uploadedUrls.length) {
      await deleteFromCloudinaryMany(uploadedUrls);
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    next(error);
  }
};

const deleteLesson = async (req, res, next) => {
  try {
    const { id } = req.params;
    assertValidObjectId(id, 'material ID');

    const existing = await LessonModel.findOne({
      _id: id,
      teacher: req.teacher._id,
      isActive: true,
    });

    if (!existing) {
      return res.status(404).json({ message: 'Material not found' });
    }

    if (existing.materials && existing.materials.length > 0) {
      await deleteFromCloudinaryMany(existing.materials);
    }

    existing.isActive = false;
    await existing.save();

    res.json({
      message: 'Material deleted successfully',
      id,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    next(error);
  }
};

const getTeacherLessons = async (req, res, next) => {
  try {
    const { classId, courseId, startDate, endDate, search } = req.query;

    const filter = {
      teacher: req.teacher._id,
      isActive: true,
    };

    if (classId) {
      assertValidObjectId(classId, 'class ID');
      filter.class = classId;
    }

    if (courseId) {
      assertValidObjectId(courseId, 'course ID');
      filter.course = courseId;
    }

    if (startDate || endDate) {
      filter.scheduledAt = {};
      if (startDate) filter.scheduledAt.$gte = new Date(startDate);
      if (endDate) filter.scheduledAt.$lte = new Date(endDate);
    }

    if (search?.trim()) {
      const term = search.trim();
      const regex = new RegExp(
        term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'i'
      );
      filter.$or = [{ title: regex }, { subject: regex }];
    }

    const lessons = await LessonModel.find(filter)
      .populate(lessonPopulate)
      .sort({ createdAt: -1, scheduledAt: -1 })
      .lean();

    const serialized = lessons.map(serializeLesson);

    res.json({
      count: serialized.length,
      lessons: serialized,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    next(error);
  }
};

const getTeacherLessonById = async (req, res, next) => {
  try {
    const { id } = req.params;
    assertValidObjectId(id, 'material ID');

    const lesson = await LessonModel.findOne({
      _id: id,
      teacher: req.teacher._id,
      isActive: true,
    })
      .populate(lessonPopulate)
      .lean();

    if (!lesson) {
      return res.status(404).json({ message: 'Material not found' });
    }

    res.json({
      lesson: serializeLesson(lesson),
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    next(error);
  }
};

export {
  createLesson,
  updateLesson,
  deleteLesson,
  getTeacherLessons,
  getTeacherLessonById,
};
