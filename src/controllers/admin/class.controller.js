import Class from "../../models/class.model.js";
import Student from "../../models/student.model.js";
import Teacher from "../../models/teacher.model.js";
import Course from "../../models/course.model.js";
import {uploadFiles, deleteFromCloudinaryMany} from '../../middleware/multer.middleware.js'
import ENV from "../../config/env.js";  
import mongoose from "mongoose";



// array string, or a comma-separated string, drops invalid IDs and duplicates.
const parseObjectIds = (value) => {
    if (!value) return [];

    let items = value;
    if (typeof value === 'string') {
        try {
            items = JSON.parse(value);
        } catch {
            items = value.split(',').map((item) => item.trim()).filter(Boolean);
        }
    }

    if (!Array.isArray(items)) return [];

    return [
        ...new Set(
            items
                .map((item) => String(item).trim())
                .filter((id) => mongoose.Types.ObjectId.isValid(id))
        ),
    ];
};


// Used by addClass / updateClass to turn the request's course IDs into real
// Course docs. Parses IDs, 404s if any are missing, and returns them in the
// same order as the request (with courseClass) so syncClassCourses can relink.
const resolveCourseIds = async (courses) => {
    const courseIds = parseObjectIds(courses);
    if (!courseIds.length) return [];

    const foundCourses = await Course.find({ _id: { $in: courseIds } }).select(
        '_id courseClass'
    );

    if (foundCourses.length !== courseIds.length) {
        const error = new Error('One or more selected courses were not found');
        error.statusCode = 404;
        throw error;
    }

    // Preserve the request order while returning full course docs for linking.
    const byId = new Map(foundCourses.map((course) => [course._id.toString(), course]));
    return courseIds.map((id) => byId.get(id)).filter(Boolean);
};

// Keep Class.courses and Course.courseClass in sync after addClass / updateClass.
// Diffs previous vs next course IDs: unlinks removed courses (courseClass = null),
// and for newly added ones, pulls them off any other class first so a course
// belongs to only one class, then sets courseClass to this class.
const syncClassCourses = async (classId, previousCourseIds, nextCourses) => {
    const previousIds = previousCourseIds.map((id) => id.toString());
    const nextIds = nextCourses.map((course) => course._id.toString());
    const previousSet = new Set(previousIds);
    const nextSet = new Set(nextIds);

    const removedIds = previousIds.filter((id) => !nextSet.has(id));
    const addedCourses = nextCourses.filter(
        (course) => !previousSet.has(course._id.toString())
    );

    if (removedIds.length) {
        await Course.updateMany(
            { _id: { $in: removedIds }, courseClass: classId },
            { $set: { courseClass: null } }
        );
    }

    if (addedCourses.length) {
        const pullUpdates = addedCourses
            .filter(
                (course) =>
                    course.courseClass && course.courseClass.toString() !== classId.toString()
            )
            .map((course) =>
                Class.findByIdAndUpdate(course.courseClass, {
                    $pull: { courses: course._id },
                })
            );

        if (pullUpdates.length) {
            await Promise.all(pullUpdates);
        }

        await Course.updateMany(
            { _id: { $in: addedCourses.map((course) => course._id) } },
            { $set: { courseClass: classId } }
        );
    }
};

const addClass = async (req, res, next) => {
  try {
    const {
      className,
      classCode,
      description,
      grade,
      academicYear,
      courses,
      teachers,
      isActive,
    } = req.body;

    if (!className?.trim() || !classCode?.trim()) {
      return res.status(400).json({
        message: 'Class name and class code are required',
      });
    }

    const normalizedCode = classCode.trim().toUpperCase();

    const existing = await Class.findOne({
      $or: [
        { className: className.trim() },
        { classCode: normalizedCode },
      ],
    });

    if (existing) {
      const field =
        existing.classCode === normalizedCode
          ? 'code'
          : 'name';
      return res.status(409).json({
        message: `A class with this ${field} already exists`,
      });
    }

    let selectedCourses = [];
    try {
      selectedCourses = await resolveCourseIds(courses);
    } catch (courseError) {
      return res.status(courseError.statusCode || 400).json({
        message: courseError.message,
      });
    }

    const uploaded = await uploadFiles(req.files, 'classes');
    const courseIds = selectedCourses.map((course) => course._id);
    const teacherIds = parseObjectIds(teachers);

    const newClass = await Class.create({
      className: className.trim(),
      classCode: normalizedCode,
      description: description?.trim() || '',
      grade: grade !== undefined && grade !== '' ? Number(grade) : null,
      academicYear: academicYear?.trim() || '',
      coverImage: uploaded.coverImage || '',
      isActive: isActive === undefined ? true : isActive === true || isActive === 'true',
      courses: courseIds,
      teachers: teacherIds,
    });

    if (teacherIds.length) {
      await Teacher.updateMany(
        { _id: { $in: teacherIds } },
        { $addToSet: { classes: newClass._id } }
      );
    }

    if (selectedCourses.length) {
      await syncClassCourses(newClass._id, [], selectedCourses);
    }

    const populated = await Class.findById(newClass._id)
      .select(
        '-assignments -announcements -events -resources -notifications -exams -quizzes -complaints'
      )
      .populate('courses', 'courseName courseCode courseType courseStatus courseDescription')
      .populate({
        path: 'teachers',
        populate: {
          path: 'user',
          select: 'firstName lastName email photo isActive',
        },
      })
      .lean();

    res.status(201).json({
      message: 'Class created successfully',
      class: populated,
    });
  } catch (error) {
    next(error);
  }
};

const getClasses = async (req, res, next) => { 
  try {
    const { search, isActive } = req.query;
    const filter = {};

    if (isActive === 'true' || isActive === 'false') {
      filter.isActive = isActive === 'true';
    }

    if (search?.trim()) {
      const term = search.trim();
      const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

      filter.$or = [
        { className: regex },
        { classCode: regex },
        { academicYear: regex },
        { description: regex },
      ];

      const grade = Number(term);
      if (!Number.isNaN(grade)) {
        filter.$or.push({ grade });
      }
    }

    const classes = await Class.find(filter)
      .select(
        '-assignments -announcements -events -resources -notifications -exams -quizzes -complaints'
      )
      .populate('courses', 'courseName courseCode courseType courseStatus')
      .populate({
        path: 'teachers',
        populate: {
          path: 'user',
          select: 'firstName lastName email photo isActive',
        },
      })
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      count: classes.length,
      classes,
    });
  } catch (error) {
    next(error);
  }
};

const getClassById = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid class ID' });
    }

    const classItem = await Class.findById(id)
      .select(
        '-assignments -announcements -events -resources -notifications -exams -quizzes -complaints'
      )
      .populate('courses', 'courseName courseCode courseType courseStatus courseDescription')
      .populate({
        path: 'teachers',
        populate: {
          path: 'user',
          select: 'firstName lastName email photo isActive',
        },
      })
      .populate({
        path: 'students',
        populate: {
          path: 'user',
          select: 'firstName lastName email photo isActive',
        },
      })
      .lean();

    if (!classItem) {
      return res.status(404).json({ message: 'Class not found' });
    }

    res.json({ class: classItem });
  } catch (error) {
    next(error);
  }
};

const updateClass = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid class ID' });
    }

    const classItem = await Class.findById(id);

    if (!classItem) {
      return res.status(404).json({ message: 'Class not found' });
    }

    const {
      className,
      classCode,
      description,
      grade,
      academicYear,
      courses,
      teachers,
      isActive,
      removeCoverImage,
    } = req.body;

    if (!className?.trim() || !classCode?.trim()) {
      return res.status(400).json({
        message: 'Class name and class code are required',
      });
    }

    const normalizedCode = classCode.trim().toUpperCase();
    const normalizedName = className.trim();

    const duplicate = await Class.findOne({
      _id: { $ne: id },
      $or: [
        { className: normalizedName },
        { classCode: normalizedCode },
      ],
    });

    if (duplicate) {
      const field =
        duplicate.classCode === normalizedCode ? 'code' : 'name';
      return res.status(409).json({
        message: `A class with this ${field} already exists`,
      });
    }

    const uploaded = await uploadFiles(req.files, 'classes');
    const urlsToDelete = [];

    classItem.className = normalizedName;
    classItem.classCode = normalizedCode;
    classItem.description = description?.trim() || '';
    classItem.grade =
      grade !== undefined && grade !== '' ? Number(grade) : null;
    classItem.academicYear = academicYear?.trim() || '';

    if (isActive !== undefined) {
      classItem.isActive = isActive === true || isActive === 'true';
    }

    if (uploaded.coverImage) {
      if (classItem.coverImage) urlsToDelete.push(classItem.coverImage);
      classItem.coverImage = uploaded.coverImage;
    } else if (removeCoverImage === true || removeCoverImage === 'true') {
      if (classItem.coverImage) urlsToDelete.push(classItem.coverImage);
      classItem.coverImage = '';
    }

    if (courses !== undefined) {
      let selectedCourses = [];
      try {
        selectedCourses = await resolveCourseIds(courses);
      } catch (courseError) {
        return res.status(courseError.statusCode || 400).json({
          message: courseError.message,
        });
      }

      const previousCourseIds = [...classItem.courses];
      classItem.courses = selectedCourses.map((course) => course._id);
      await syncClassCourses(classItem._id, previousCourseIds, selectedCourses);
    }

    if (teachers !== undefined) {
      const teacherIds = parseObjectIds(teachers);
      const previousTeacherIds = (classItem.teachers || []).map((id) => id.toString());
      classItem.teachers = teacherIds;

      const previousSet = new Set(previousTeacherIds);
      const nextSet = new Set(teacherIds);
      const removedTeacherIds = previousTeacherIds.filter((id) => !nextSet.has(id));
      const addedTeacherIds = teacherIds.filter((id) => !previousSet.has(id));

      if (removedTeacherIds.length) {
        await Teacher.updateMany(
          { _id: { $in: removedTeacherIds } },
          { $pull: { classes: classItem._id } }
        );
      }
      if (addedTeacherIds.length) {
        await Teacher.updateMany(
          { _id: { $in: addedTeacherIds } },
          { $addToSet: { classes: classItem._id } }
        );
      }
    }

    await classItem.save();
    await deleteFromCloudinaryMany(urlsToDelete);

        const populated = await Class.findById(classItem._id)
      .select(
        '-assignments -announcements -events -resources -notifications -exams -quizzes -complaints'
      )
      .populate('courses', 'courseName courseCode courseType courseStatus courseDescription')
      .populate({
        path: 'teachers',
        populate: {
          path: 'user',
          select: 'firstName lastName email photo isActive',
        },
      })
      .populate({
        path: 'students',
        populate: {
          path: 'user',
          select: 'firstName lastName email photo isActive',
        },
      })
      .lean();

    res.json({
      message: 'Class updated successfully',
      class: populated,
    });
  } catch (error) {
    next(error);
  }
};



const deleteClass = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid class ID' });
    }

    const classItem = await Class.findById(id);

    if (!classItem) {
      return res.status(404).json({ message: 'Class not found' });
    }

    // 1. Remove cover image from Cloudinary if exists
    if (classItem.coverImage) {
      await deleteFromCloudinaryMany([classItem.coverImage]);
    }

    // 2. Remove class from assigned teachers
    await Teacher.updateMany(
      { classes: id },
      { $pull: { classes: id } }
    );

    // 3. Unlink class from courses
    await Course.updateMany(
      { courseClass: id },
      { $unset: { courseClass: 1 } }
    );

    // 4. Unlink class from students
    await Student.updateMany(
      { class: id },
      { $unset: { class: 1 } }
    );

    // 5. Delete the class record
    await Class.findByIdAndDelete(id);

    res.json({
      message: 'Class deleted successfully',
      id,
    });
  } catch (error) {
    next(error);
  }
};

export { addClass, getClasses, getClassById, updateClass, deleteClass };