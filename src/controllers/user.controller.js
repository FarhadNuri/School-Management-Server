import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { UserModel } from '../models/user.model.js';
import StudentModel from '../models/student.model.js';
import '../models/class.model.js';
import ENV from '../config/env.js';
import { uploadFiles, deleteFromCloudinaryMany } from '../middleware/multer.middleware.js';

const serializeUser = async (user) => {
  const base = {
    id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'User',
    email: user.email,
    photo: user.photo,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };

  if (user.role === 'student') {
    try {
      const student = await StudentModel.findOne({ user: user._id })
        .populate('class', 'className classCode grade academicYear')
        .lean();
      if (student) {
        base.studentId = student._id;
        base.classId = student.class?._id || null;
        base.className = student.class?.className || '';
        base.classCode = student.class?.classCode || '';
        base.grade = student.class?.grade || null;
        base.classGrade = student.class?.className || (student.class?.grade ? `Grade ${student.class.grade}` : '');
        base.class = student.class || null;
      }
    } catch (e) {
      console.error('Error populating student profile:', e.message);
    }
  }

  return base;
};

export const loginUser = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const user = await UserModel.findOne({
      email: email.toLowerCase().trim(),
      isDeleted: { $ne: true },
    }).select('+password');

    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (!user.isActive) {
      return res.status(403).json({
        message: 'Account is banned. Contact the school administration.',
      });
    }

    const token = jwt.sign({ id: user._id }, ENV.JWT_SECRET, {
      expiresIn: ENV.JWT_EXPIRES_IN,
    });

    const serialized = await serializeUser(user);

    res.json({
      message: 'Login successful',
      token,
      user: serialized,
    });
  } catch (error) {
    next(error);
  }
};

export const getMe = async (req, res, next) => {
  try {
    const serialized = await serializeUser(req.user);
    res.json({ user: serialized });
  } catch (error) {
    next(error);
  }
};

export const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({
        message: 'Current password, new password, and confirmation are required',
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: 'New password and confirmation do not match' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ message: 'New password must be at least 8 characters' });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({
        message: 'New password must be different from your current password',
      });
    }

    const user = await UserModel.findById(req.user._id).select('+password');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    next(error);
  }
};

export const updateMyPhoto = async (req, res, next) => {
  try {
    const uploadedUrls = [];

    try {
      if (!req.files?.photo?.[0]) {
        return res.status(400).json({ message: 'Profile photo is required' });
      }

      const uploaded = await uploadFiles(req.files, 'users');
      uploadedUrls.push(...Object.values(uploaded).filter(Boolean));

      const user = await UserModel.findById(req.user._id);
      if (!user) {
        await deleteFromCloudinaryMany(uploadedUrls);
        return res.status(404).json({ message: 'User not found' });
      }

      const previousPhoto = user.photo;
      user.photo = uploaded.photo;
      await user.save();

      if (previousPhoto) {
        await deleteFromCloudinaryMany([previousPhoto]);
      }

      const serialized = await serializeUser(user);

      res.json({
        message: 'Profile photo updated successfully',
        photo: user.photo,
        user: serialized,
      });
    } catch (uploadError) {
      if (uploadedUrls.length > 0) {
        await deleteFromCloudinaryMany(uploadedUrls);
      }
      throw uploadError;
    }
  } catch (error) {
    next(error);
  }
};
