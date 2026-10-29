import Class from "../../models/class.model.js";
import Student from "../../models/student.model.js";
import Teacher from "../../models/teacher.model.js";
import Course from "../../models/course.model.js";
import { uploadFiles, deleteFromCloudinaryMany } from '../../middleware/multer.middleware.js'
import ENV from "../../config/env.js";
import mongoose from "mongoose";



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

    return items
        .map((item) => String(item).trim())
        .filter((id) => mongoose.Types.ObjectId.isValid(id));
};

const addCourse = async (req, res, next) => {
    try {
        const {
            courseName,
            courseCode,
            courseDescription,
            courseType,
            courseStatus,
            courseClass,
            courseTeachers,
        } = req.body;

        if (!courseName?.trim() || !courseCode?.trim()) {
            return res.status(400).json({
                message: 'Course name and course code are required',
            });
        }

        const normalizedCode = courseCode.trim().toUpperCase();

        const existing = await Course.findOne({ courseCode: normalizedCode });
        if (existing) {
            return res.status(409).json({
                message: 'A course with this code already exists',
            });
        }

        let classId;
        if (courseClass) {
            if (!mongoose.Types.ObjectId.isValid(courseClass)) {
                return res.status(400).json({ message: 'Invalid class ID' });
            }

            const linkedClass = await Class.findById(courseClass).select('_id');
            if (!linkedClass) {
                return res.status(404).json({ message: 'Class not found' });
            }

            classId = linkedClass._id;
        }

        let coverImage = req.body.coverImage || req.body.image || '';
        if (req.files && Object.keys(req.files).length > 0) {
            const uploaded = await uploadFiles(req.files, 'courses');
            coverImage = uploaded.coverImage || uploaded.image || uploaded.photo || uploaded.courseImage || coverImage;
        } else if (req.file) {
            const uploaded = await uploadFiles({ image: [req.file] }, 'courses');
            coverImage = uploaded.image || coverImage;
        }

        const course = await Course.create({
            courseName: courseName.trim(),
            courseCode: normalizedCode,
            courseDescription: courseDescription?.trim() || '',
            courseType: courseType || 'Core',
            courseStatus: courseStatus || 'Active',
            courseClass: classId,
            courseTeachers: parseObjectIds(courseTeachers),
            coverImage,
        });

        if (classId) {
            await Class.findByIdAndUpdate(classId, {
                $addToSet: { courses: course._id },
            });
        }

        res.status(201).json({
            message: 'Course created successfully',
            course,
        });
    } catch (error) {
        next(error)
    }
};

const getCourses = async (req, res, next) => {
    try {
        const { search, courseStatus, courseType } = req.query;
        const filter = {};

        if (courseStatus) filter.courseStatus = courseStatus;
        if (courseType) filter.courseType = courseType;

        if (search?.trim()) {
            const term = search.trim();
            const regex = new RegExp(
                term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                'i'
            );

            filter.$or = [
                { courseName: regex },
                { courseCode: regex },
                { courseDescription: regex },
            ];
        }

        const courses = await Course.find(filter)
            .populate('courseClass', 'className classCode grade academicYear isActive')
            .populate({
                path: 'courseTeachers',
                populate: {
                    path: 'user',
                    select: 'firstName lastName email photo isActive',
                },
            })
            .sort({ createdAt: -1 })
            .lean();

        res.json({
            count: courses.length,
            courses,
        });
    } catch (error) {
        next(error);
    }
};

const getCourseById = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid course ID' });
        }

        const course = await Course.findById(id)
            .populate('courseClass', 'className classCode grade academicYear isActive')
            .populate({
                path: 'courseTeachers',
                populate: {
                    path: 'user',
                    select: 'firstName lastName email photo isActive',
                },
            })
            .populate({
                path: 'courseStudents',
                populate: {
                    path: 'user',
                    select: 'firstName lastName email photo isActive',
                },
            })
            .lean();

        if (!course) {
            return res.status(404).json({ message: 'Course not found' });
        }

        res.json({ course });
    } catch (error) {
        next(error);
    }
};

const updateCourse = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid course ID' });
        }

        const course = await Course.findById(id);
        if (!course) {
            return res.status(404).json({ message: 'Course not found' });
        }

        const {
            courseName,
            courseCode,
            courseDescription,
            courseType,
            courseStatus,
            courseClass,
            courseTeachers,
        } = req.body;

        if (!courseName?.trim() || !courseCode?.trim()) {
            return res.status(400).json({
                message: 'Course name and course code are required',
            });
        }

        const normalizedCode = courseCode.trim().toUpperCase();

        const duplicate = await Course.findOne({
            _id: { $ne: id },
            courseCode: normalizedCode,
        });

        if (duplicate) {
            return res.status(409).json({
                message: 'A course with this code already exists',
            });
        }

        let nextClassId = course.courseClass || null;

        if (courseClass !== undefined) {
            if (!courseClass) {
                nextClassId = null;
            } else {
                if (!mongoose.Types.ObjectId.isValid(courseClass)) {
                    return res.status(400).json({ message: 'Invalid class ID' });
                }

                const linkedClass = await Class.findById(courseClass).select('_id');
                if (!linkedClass) {
                    return res.status(404).json({ message: 'Class not found' });
                }

                nextClassId = linkedClass._id;
            }
        }

        const previousClassId = course.courseClass
            ? course.courseClass.toString()
            : null;
        const nextClassIdStr = nextClassId ? nextClassId.toString() : null;

        course.courseName = courseName.trim();
        course.courseCode = normalizedCode;
        course.courseDescription = courseDescription?.trim() || '';
        if (courseType !== undefined) course.courseType = courseType;
        if (courseStatus !== undefined) course.courseStatus = courseStatus;
        if (courseClass !== undefined) course.courseClass = nextClassId;
        if (courseTeachers !== undefined) {
            course.courseTeachers = parseObjectIds(courseTeachers);
        }

        if (req.files && Object.keys(req.files).length > 0) {
            const uploaded = await uploadFiles(req.files, 'courses');
            const newCover = uploaded.coverImage || uploaded.image || uploaded.photo || uploaded.courseImage;
            if (newCover) {
                if (course.coverImage) {
                    await deleteFromCloudinaryMany([course.coverImage]);
                }
                course.coverImage = newCover;
            }
        } else if (req.file) {
            const uploaded = await uploadFiles({ image: [req.file] }, 'courses');
            const newCover = uploaded.image;
            if (newCover) {
                if (course.coverImage) {
                    await deleteFromCloudinaryMany([course.coverImage]);
                }
                course.coverImage = newCover;
            }
        } else if (req.body.coverImage !== undefined || req.body.image !== undefined) {
            const newCover = req.body.coverImage ?? req.body.image ?? '';
            if (newCover !== course.coverImage) {
                if (course.coverImage && !newCover) {
                    await deleteFromCloudinaryMany([course.coverImage]);
                }
                course.coverImage = newCover;
            }
        }

        await course.save();

        if (nextClassId) {
            await Class.findByIdAndUpdate(nextClassId, {
                $addToSet: { courses: course._id },
            });
        }
        const populated = await Course.findById(course._id)
            .populate('courseClass', 'className classCode grade academicYear isActive')
            .populate({
                path: 'courseTeachers',
                populate: {
                    path: 'user',
                    select: 'firstName lastName email photo isActive',
                },
            })
            .populate({
                path: 'courseStudents',
                populate: {
                    path: 'user',
                    select: 'firstName lastName email photo isActive',
                },
            })
            .lean();

        res.json({
            message: 'Course updated successfully',
            course: populated,
        });
    } catch (error) {
        next(error);
    }
};


const deleteCourse = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid course ID' });
        }

        const course = await Course.findById(id);

        if (!course) {
            return res.status(404).json({ message: 'Course not found' });
        }

        // 1. Remove cover image from Cloudinary if exists
        if (course.coverImage) {
            await deleteFromCloudinaryMany([course.coverImage]);
        }

        // 2. Remove course from classes
        await Class.updateMany(
            { courses: id },
            { $pull: { courses: id } }
        );

        // 3. Delete the course record
        await Course.findByIdAndDelete(id);

        res.json({
            message: 'Course deleted successfully',
            id,
        });
    } catch (error) {
        next(error);
    }
};

export { addCourse, getCourses, getCourseById, updateCourse, deleteCourse };
