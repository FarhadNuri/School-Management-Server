import Routine from '../../models/routine.model.js';
import Class from '../../models/class.model.js';
import Teacher from '../../models/teacher.model.js';
import User from '../../models/user.model.js';

export const getAdminRoutines = async (req, res, next) => {
  try {
    const { type, classId, teacherId } = req.query;
    const filter = {};
    if (type) filter.type = type;
    if (classId) filter.class = classId;
    if (teacherId) filter.teacher = teacherId;

    const routines = await Routine.find(filter)
      .populate({
        path: 'class',
        select: 'className classCode grade academicYear section'
      })
      .populate({
        path: 'teacher',
        select: 'user classes',
        populate: {
          path: 'user',
          select: 'firstName lastName email photo'
        }
      })
      .sort({ createdAt: 1 })
      .lean();

    res.json({
      success: true,
      count: routines.length,
      routines
    });
  } catch (error) {
    next(error);
  }
};

export const getAdminRoutineById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const routine = await Routine.findById(id)
      .populate({
        path: 'class',
        select: 'className classCode grade academicYear section'
      })
      .populate({
        path: 'teacher',
        select: 'user classes',
        populate: {
          path: 'user',
          select: 'firstName lastName email photo'
        }
      })
      .lean();

    if (!routine) {
      return res.status(404).json({ success: false, message: 'Routine not found' });
    }

    res.json({ success: true, routine });
  } catch (error) {
    next(error);
  }
};

export const createAdminRoutine = async (req, res, next) => {
  try {
    const routine = await Routine.create(req.body);
    res.status(201).json({ success: true, routine });
  } catch (error) {
    next(error);
  }
};

export const updateAdminRoutine = async (req, res, next) => {
  try {
    const { id } = req.params;
    const routine = await Routine.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true
    })
      .populate({
        path: 'class',
        select: 'className classCode grade academicYear section'
      })
      .populate({
        path: 'teacher',
        select: 'user classes',
        populate: {
          path: 'user',
          select: 'firstName lastName email photo'
        }
      });

    if (!routine) {
      return res.status(404).json({ success: false, message: 'Routine not found' });
    }

    res.json({ success: true, routine });
  } catch (error) {
    next(error);
  }
};

export const deleteAdminRoutine = async (req, res, next) => {
  try {
    const { id } = req.params;
    const routine = await Routine.findByIdAndDelete(id);
    if (!routine) {
      return res.status(404).json({ success: false, message: 'Routine not found' });
    }
    res.json({ success: true, message: 'Routine deleted successfully' });
  } catch (error) {
    next(error);
  }
};
