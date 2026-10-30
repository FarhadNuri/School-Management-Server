import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

import Teacher from '../../models/teacher.model.js';
import Class from '../../models/class.model.js';
import Course from '../../models/course.model.js';
import { User } from '../../models/user.model.js';
import { uploadFiles, deleteFromCloudinaryMany } from '../../middleware/multer.middleware.js';
import generatePassword from '../../utils/generatePassword.js';
import mailer from '../../utils/Mailer.js';
import { teacherCredentialsEmail } from '../../utils/emailTemplate.js';

import {
  parseJson,
  isTrue,
  normalizeAddress,
  normalizeContactInfo,
  normalizeSocialMedia,
  normalizeGender,
  emailTaken,
  findUserIds,
  populateUser,
} from '../../utils/userHelpers.js';

import {
  ID_TYPES,
  isValidIdType,
  needsIdBack,
  normalizeIdType,
} from '../../utils/idTypes.js';

const isValidEmail = (value) => /^\S+@\S+\.\S+$/.test(String(value).trim());

const teacherPopulate = [
  populateUser,
  {
    path: 'classes',
    select: 'className classCode grade academicYear isActive',
  },
];

const calculateAge = (dobString) => {
  if (!dobString) return 0;
  const birthDate = new Date(dobString);
  if (isNaN(birthDate.getTime())) return 0;
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
};

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
        .map((item) => {
          if (item && typeof item === 'object') {
            return String(item._id || item.id || '').trim();
          }
          return String(item).trim();
        })
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    ),
  ];
};

const resolveClassIds = async (classes) => {
  const classIds = parseObjectIds(classes);

  if (!classIds.length) {
    const error = new Error('At least one class is required');
    error.statusCode = 400;
    throw error;
  }

  const foundClasses = await Class.find({ _id: { $in: classIds } }).select('_id');

  if (foundClasses.length !== classIds.length) {
    const error = new Error('One or more selected classes were not found');
    error.statusCode = 404;
    throw error;
  }

  return classIds;
};

const syncTeacherClasses = async (teacherId, previousClassIds = [], nextClassIds = []) => {
  const previousIds = previousClassIds.map((id) => id.toString());
  const nextIds = nextClassIds.map((id) => id.toString());
  const previousSet = new Set(previousIds);
  const nextSet = new Set(nextIds);

  const removedIds = previousIds.filter((id) => !nextSet.has(id));
  const addedIds = nextIds.filter((id) => !previousSet.has(id));

  const updates = [];

  if (removedIds.length) {
    updates.push(
      Class.updateMany(
        { _id: { $in: removedIds } },
        { $pull: { teachers: teacherId } }
      )
    );
  }

  if (addedIds.length) {
    updates.push(
      Class.updateMany(
        { _id: { $in: addedIds } },
        { $addToSet: { teachers: teacherId } }
      )
    );
  }

  if (updates.length) {
    await Promise.all(updates);
  }
};

export const addTeacher = async (req, res, next) => {
  let createdUserId = null;
  let createdTeacherId = null;
  const uploadedUrls = [];

  try {
    const { firstName, lastName, email, isActive, identificationType, gender, dateOfBirth } =
      req.body;

    const contactInfo = normalizeContactInfo(parseJson(req.body.contactInfo, {}));
    const address = normalizeAddress(parseJson(req.body.address, {}));
    const socialMedia = normalizeSocialMedia(parseJson(req.body.socialMedia, {}));
    const qualificationTitles = parseJson(req.body.qualificationTitles, []);

    if (!firstName?.trim() || !lastName?.trim() || !email?.trim()) {
      return res.status(400).json({
        message: 'First name, last name, and email are required',
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        message: 'Please provide a valid teacher email address',
      });
    }

    if (dateOfBirth && calculateAge(dateOfBirth) < 18) {
      return res.status(400).json({
        message: 'Teacher must be at least 18 years old',
      });
    }

    let classIds;
    try {
      classIds = await resolveClassIds(req.body.classes);
    } catch (classError) {
      return res.status(classError.statusCode || 400).json({
        message: classError.message,
      });
    }

    if (!identificationType) {
      return res.status(400).json({ message: 'Identification type is required' });
    }

    const normalizedIdType = normalizeIdType(identificationType);
    if (!isValidIdType(normalizedIdType)) {
      return res.status(400).json({
        message: `Identification type must be one of: ${ID_TYPES.join(', ')}`,
      });
    }

    const emailNormalized = email.toLowerCase().trim();

    if (await emailTaken(emailNormalized)) {
      return res.status(409).json({ message: 'A user with this email already exists' });
    }

    const uploaded = await uploadFiles(req.files);
    uploadedUrls.push(...Object.values(uploaded).filter(Boolean));

    if (!uploaded.picture) {
      await deleteFromCloudinaryMany(uploadedUrls);
      return res.status(400).json({ message: 'Teacher profile photo is required' });
    }

    const qualifications = [];
    for (let i = 0; i < 3; i++) {
      const document = uploaded[`qualification${i}`];
      if (document) {
        qualifications.push({
          title: qualificationTitles[i] || '',
          document,
        });
      }
    }

    if (qualifications.length < 1) {
      return res.status(400).json({
        message: 'At least one qualification document is required',
      });
    }

    if (!uploaded.idFront) {
      return res.status(400).json({ message: 'ID front document is required' });
    }

    if (
      needsIdBack(normalizedIdType) &&
      !uploaded.idBack
    ) {
      return res.status(400).json({ message: 'ID back document is required' });
    }

    const password = generatePassword();
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: emailNormalized,
      password: hashedPassword,
      photo: uploaded.picture || '',
      contactInfo,
      address,
      socialMedia,
      gender: normalizeGender(gender),
      dateOfBirth: dateOfBirth || undefined,
      role: 'teacher',
      isActive: isActive === undefined ? true : isTrue(isActive),
    });
    createdUserId = user._id;

    const teacher = await Teacher.create({
      user: user._id,
      classes: classIds,
      qualifications,
      identification: {
        type: normalizedIdType,
        front: uploaded.idFront,
        back: uploaded.idBack || '',
      },
    });
    createdTeacherId = teacher._id;

    await syncTeacherClasses(teacher._id, [], classIds);

    uploadedUrls.length = 0;

    const mail = teacherCredentialsEmail({
      firstName: user.firstName,
      email: emailNormalized,
      password,
    });

    let emailSent = true;
    try {
      await mailer.sendEmail({
        to: emailNormalized,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    } catch (mailError) {
      console.error('Teacher credentials email failed:', mailError.message);
      emailSent = false;
    }

    const teacherData = await Teacher.findById(teacher._id).populate(teacherPopulate);

    res.status(201).json({
      message: 'Teacher created successfully',
      teacher: teacherData,
      credentials: {
        teacher: {
          name: `${user.firstName} ${user.lastName}`.trim(),
          email: emailNormalized,
          password,
          role: 'teacher',
        },
      },
      emailSent,
    });
  } catch (error) {
      console.error('Error creating teacher:', error.message);
      if (createdTeacherId) {
        await Teacher.findByIdAndDelete(createdTeacherId).catch(() => { });
        await Class.updateMany(
          { teachers: createdTeacherId },
          { $pull: { teachers: createdTeacherId } }
        ).catch(() => { });
      }
      if (createdUserId) {
        await User.findByIdAndDelete(createdUserId).catch(() => { });
      }
      await deleteFromCloudinaryMany(uploadedUrls);
      next(error);
    }
  };

  export const getTeachers = async (req, res, next) => {
    try {
      const { search, isActive } = req.query;
      const userIds = await findUserIds({ role: 'teacher', search, isActive });

      const teachers = await Teacher.find({ user: { $in: userIds } })
        .populate(teacherPopulate)
        .sort({ createdAt: -1 })
        .lean();

      const teacherIds = teachers.map((t) => t._id);
      const courses = await Course.find({ courseTeachers: { $in: teacherIds } })
        .select('courseName courseCode courseClass courseTeachers')
        .populate('courseClass', 'className classCode grade')
        .lean();

      const teacherCoursesMap = {};
      courses.forEach((c) => {
        (c.courseTeachers || []).forEach((tId) => {
          const strId = tId.toString();
          if (!teacherCoursesMap[strId]) teacherCoursesMap[strId] = [];
          teacherCoursesMap[strId].push({
            id: c._id,
            name: c.courseName,
            code: c.courseCode,
            className: c.courseClass?.className,
            classCode: c.courseClass?.classCode,
            grade: c.courseClass?.grade,
          });
        });
      });

      const enrichedTeachers = teachers.map((t) => ({
        ...t,
        courses: teacherCoursesMap[t._id.toString()] || [],
      }));

      res.json({
        count: enrichedTeachers.length,
        teachers: enrichedTeachers,
      });
    } catch (error) {
      next(error);
    }
  };

  export const getTeacherById = async (req, res, next) => {
    try {
      const { id } = req.params;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: 'Invalid teacher ID' });
      }

      const teacher = await Teacher.findById(id).populate(teacherPopulate).lean();

      if (!teacher || !teacher.user || teacher.user.isDeleted) {
        return res.status(404).json({ message: 'Teacher not found' });
      }

      const courses = await Course.find({ courseTeachers: id })
        .select('courseName courseCode courseClass courseTeachers courseType courseStatus')
        .populate('courseClass', 'className classCode grade')
        .lean();

      teacher.courses = courses.map((c) => ({
        id: c._id,
        name: c.courseName,
        code: c.courseCode,
        className: c.courseClass?.className,
        classCode: c.courseClass?.classCode,
        grade: c.courseClass?.grade,
        type: c.courseType,
        status: c.courseStatus,
      }));

      res.json({ teacher });
    } catch (error) {
      next(error);
    }
  };

  export const setTeacherStatus = async (req, res, next) => {
    try {
      const { id } = req.params;
      const { isActive } = req.body;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: 'Invalid teacher ID' });
      }

      if (isActive === undefined) {
        return res.status(400).json({ message: 'isActive is required' });
      }

      const teacher = await Teacher.findById(id);
      if (!teacher) {
        return res.status(404).json({ message: 'Teacher not found' });
      }

      const user = await User.findById(teacher.user);
      if (!user || user.isDeleted) {
        return res.status(404).json({ message: 'Teacher not found' });
      }

      user.isActive = isTrue(isActive);
      await user.save();

      const teacherData = await Teacher.findById(id).populate(teacherPopulate);

      res.json({
        message: user.isActive
          ? 'Teacher unbanned successfully'
          : 'Teacher banned successfully',
        teacher: teacherData,
      });
    } catch (error) {
      next(error);
    }
  };

  export const updateTeacher = async (req, res, next) => {
    const uploadedUrls = [];

    try {
      const { id } = req.params;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: 'Invalid teacher ID' });
      }

      const teacher = await Teacher.findById(id);
      if (!teacher) {
        return res.status(404).json({ message: 'Teacher not found' });
      }

      const user = await User.findById(teacher.user);
      if (!user || user.isDeleted) {
        return res.status(404).json({ message: 'Teacher user account not found' });
      }

      const {
        firstName,
        lastName,
        email,
        password,
        isActive,
        identificationType,
        gender,
        dateOfBirth,
      } = req.body;

      const contactInfo = parseJson(req.body.contactInfo, null);
      const address = parseJson(req.body.address, null);
      const socialMedia = parseJson(req.body.socialMedia, null);
      const qualificationTitles = req.body.qualificationTitles
        ? parseJson(req.body.qualificationTitles, [])
        : null;
      const existingQualifications = req.body.existingQualifications
        ? parseJson(req.body.existingQualifications, [])
        : null;

      if (!firstName?.trim() || !lastName?.trim() || !email?.trim()) {
        return res.status(400).json({
          message: 'First name, last name, and email are required',
        });
      }

      if (!isValidEmail(email)) {
        return res.status(400).json({
          message: 'Please provide a valid teacher email address',
        });
      }

      let classIds;
      try {
        classIds = await resolveClassIds(req.body.classes);
      } catch (classError) {
        return res.status(classError.statusCode || 400).json({
          message: classError.message,
        });
      }

      const emailNormalized = email.toLowerCase().trim();

      if (emailNormalized !== user.email && (await emailTaken(emailNormalized, user._id))) {
        return res.status(409).json({ message: 'A user with this email already exists' });
      }

      const uploaded = await uploadFiles(req.files);
      uploadedUrls.push(...Object.values(uploaded).filter(Boolean));
      const urlsToDelete = [];

      if (!uploaded.picture && !user.photo) {
        await deleteFromCloudinaryMany(uploadedUrls);
        return res.status(400).json({ message: 'Teacher profile photo is required' });
      }

      const hasQualificationFiles = ['qualification0', 'qualification1', 'qualification2'].some(
        (key) => uploaded[key]
      );

      if (qualificationTitles !== null || existingQualifications !== null || hasQualificationFiles) {
        const existing =
          existingQualifications ??
          teacher.qualifications.map((item) => ({
            title: item.title,
            document: item.document,
          }));
        const titles = qualificationTitles ?? existing.map((item) => item.title);
        const qualifications = [];

        for (let i = 0; i < 3; i++) {
          const newDocument = uploaded[`qualification${i}`];
          const oldDocument = existing[i]?.document;

          if (newDocument && oldDocument) {
            urlsToDelete.push(oldDocument);
          }

          const document = newDocument || oldDocument;

          if (document) {
            qualifications.push({
              title: titles[i] || '',
              document,
            });
          }
        }

        if (qualifications.length < 1) {
          return res.status(400).json({
            message: 'At least one qualification document is required',
          });
        }
        teacher.qualifications
          .map((item) => item.document)
          .filter(Boolean)
          .forEach((url) => {
            if (!qualifications.some((item) => item.document === url)) {
              urlsToDelete.push(url);
            }
          });

        teacher.qualifications = qualifications;
      }

      const hasIdUpdate = identificationType || uploaded.idFront || uploaded.idBack;

      if (hasIdUpdate) {
        const type = normalizeIdType(
          identificationType || teacher.identification?.type || ''
        );

        if (identificationType && !isValidIdType(type)) {
          return res.status(400).json({
            message: `Identification type must be one of: ${ID_TYPES.join(', ')}`,
          });
        }

        if (uploaded.idFront && teacher.identification?.front) {
          urlsToDelete.push(teacher.identification.front);
        }

        if (
          (uploaded.idBack || (type === 'Passport' || type === 'Birth Certificate')) &&
          teacher.identification?.back
        ) {
          urlsToDelete.push(teacher.identification.back);
        }

        const front = uploaded.idFront || teacher.identification?.front || '';
        const back =
          (type === 'Passport' || type === 'Birth Certificate')
            ? ''
            : uploaded.idBack || teacher.identification?.back || '';

        if (!front) {
          return res.status(400).json({ message: 'ID front document is required' });
        }

        if (needsIdBack(type) && !back) {
          return res.status(400).json({ message: 'ID back document is required' });
        }

        teacher.identification = { type, front, back };
      }

      user.firstName = firstName.trim();
      user.lastName = lastName.trim();
      user.email = emailNormalized;

      if (password) {
        user.password = await bcrypt.hash(password, 10);
      }

      if (isActive !== undefined) {
        user.isActive = isTrue(isActive);
      }

      if (contactInfo) {
        user.contactInfo = normalizeContactInfo(contactInfo);
      }

      if (address) {
        user.address = normalizeAddress(address);
      }

      if (socialMedia) {
        user.socialMedia = normalizeSocialMedia(socialMedia);
      }

      if (gender !== undefined) {
        user.gender = normalizeGender(gender);
      }

      if (dateOfBirth && calculateAge(dateOfBirth) < 18) {
        return res.status(400).json({
          message: 'Teacher must be at least 18 years old',
        });
      }

      if (dateOfBirth !== undefined) {
        user.dateOfBirth = dateOfBirth || undefined;
      }

      if (uploaded.picture) {
        if (user.photo) urlsToDelete.push(user.photo);
        user.photo = uploaded.picture;
      }

      const previousClassIds = [...(teacher.classes || [])];
      teacher.classes = classIds;

      await Promise.all([user.save(), teacher.save()]);
      await syncTeacherClasses(teacher._id, previousClassIds, classIds);

      uploadedUrls.length = 0;
      await deleteFromCloudinaryMany(urlsToDelete);

      const teacherData = await Teacher.findById(teacher._id).populate(teacherPopulate);

      res.json({
        message: 'Teacher updated successfully',
        teacher: teacherData,
      });
    } catch (error) {
      await deleteFromCloudinaryMany(uploadedUrls);
      next(error);
    }
  };

export const deleteTeacher = async (req, res) => {
  try {
    const { id } = req.params;
    const teacher = await Teacher.findById(id);
    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher not found' });
    }

    const userId = teacher.user;

    // Cloudinary cleanup
    if (teacher.identification?.front) {
      try {
        const publicId = getPublicIdFromUrl(teacher.identification.front);
        if (publicId) await deleteImageFromCloudinary(publicId);
      } catch (e) {}
    }
    if (teacher.identification?.back) {
      try {
        const publicId = getPublicIdFromUrl(teacher.identification.back);
        if (publicId) await deleteImageFromCloudinary(publicId);
      } catch (e) {}
    }
    if (Array.isArray(teacher.qualifications)) {
      for (const q of teacher.qualifications) {
        if (q.document) {
          try {
            const publicId = getPublicIdFromUrl(q.document);
            if (publicId) await deleteImageFromCloudinary(publicId);
          } catch (e) {}
        }
      }
    }

    if (userId) {
      const user = await User.findById(userId);
      if (user?.photo) {
        try {
          const publicId = getPublicIdFromUrl(user.photo);
          if (publicId) await deleteImageFromCloudinary(publicId);
        } catch (e) {}
      }
      await User.findByIdAndDelete(userId);
    }

    // Clean up references:
    // Remove from Class.teachers
    try {
      const ClassRef = typeof ClassModel !== 'undefined' ? ClassModel : (typeof Class !== 'undefined' ? Class : null);
      if (ClassRef) {
        await ClassRef.updateMany({ teachers: id }, { $pull: { teachers: id } });
      }
    } catch (e) {
      console.error('Error removing teacher from class:', e);
    }

    // Remove from Course.courseTeachers
    try {
      if (typeof Course !== 'undefined') {
        await Course.updateMany({ courseTeachers: id }, { $pull: { courseTeachers: id } });
      }
    } catch (e) {
      console.error('Error removing teacher from course:', e);
    }

    // Delete teacher record
    await Teacher.findByIdAndDelete(id);

    return res.status(200).json({ success: true, message: 'Teacher deleted successfully' });
  } catch (error) {
    console.error('Error in deleteTeacher:', error);
    return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
};

export const resetTeacherPassword = async (req, res, next) => {
  try {
    const { id } = req.params;
    const teacher = await Teacher.findById(id).populate('user');
    if (!teacher || !teacher.user) {
      return res.status(404).json({ message: 'Teacher record or user account not found' });
    }

    const newPassword = generatePassword();
    teacher.user.password = await bcrypt.hash(newPassword, 10);
    await teacher.user.save();

    const teacherName = `${teacher.user.firstName} ${teacher.user.lastName}`.trim();
    const mail = teacherCredentialsEmail({
      firstName: teacher.user.firstName,
      email: teacher.user.email,
      password: newPassword,
    });

    let emailSent = true;
    try {
      await mailer.sendEmail({
        to: teacher.user.email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    } catch (err) {
      console.warn('Teacher reset password email delivery warning:', err.message);
      emailSent = false;
    }

    return res.status(200).json({
      message: 'Teacher password reset successfully',
      credentials: {
        teacher: {
          name: teacherName,
          email: teacher.user.email,
          password: newPassword,
          role: 'teacher',
        },
      },
      emailSent,
    });
  } catch (error) {
    next(error);
  }
};
