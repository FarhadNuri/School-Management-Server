import jwt from 'jsonwebtoken';
import { UserModel } from '../models/user.model.js';
import Teacher from '../models/teacher.model.js';
import ENV from '../config/env.js';

/**
 * Middleware to protect teacher routes.
 * Verifies JWT token, ensures user is an active teacher,
 * and attaches both req.user and req.teacher to the request object.
 */
export const protectTeacher = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Not authorized. No token provided.' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'Not authorized. No token provided.' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, ENV.JWT_SECRET);
    } catch (error) {
      return res.status(401).json({ message: 'Not authorized. Invalid or expired token.' });
    }

    if (!decoded?.id) {
      return res.status(401).json({ message: 'Not authorized. Invalid token payload.' });
    }

    // Lookup user by decoded token ID
    let user = await UserModel.findById(decoded.id);
    let teacher = null;

    if (user) {
      if (user.isDeleted) {
        return res.status(401).json({ message: 'Not authorized. User not found.' });
      }

      if (!user.isActive) {
        return res.status(403).json({
          message: 'Account is deactivated. Contact the school administration.',
        });
      }

      if (user.role !== 'teacher') {
        return res.status(403).json({
          message: 'Access denied. Teacher privileges required.',
        });
      }

      teacher = await Teacher.findOne({ user: user._id });
    } else {
      // Fallback: in case token id was issued with teacher._id directly
      teacher = await Teacher.findById(decoded.id).populate('user');
      if (teacher?.user) {
        user = teacher.user;
        if (user.isDeleted) {
          return res.status(401).json({ message: 'Not authorized. User not found.' });
        }
        if (!user.isActive) {
          return res.status(403).json({
            message: 'Account is deactivated. Contact the school administration.',
          });
        }
      }
    }

    if (!teacher) {
      return res.status(404).json({ message: 'Teacher profile not found.' });
    }

    // Attach user and teacher to request object
    req.user = user;
    req.teacher = teacher;

    next();
  } catch (error) {
    next(error);
  }
};

export const authorizeTeacher = protectTeacher;

export default protectTeacher;
