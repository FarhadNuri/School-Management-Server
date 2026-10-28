import Admin from "../../models/admin.model.js";
import ENV from "../../config/env.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { uploadFiles, deleteFromCloudinaryMany } from "../../middleware/multer.middleware.js";

const serializeAdmin = (admin) => {
  return {
    id: admin._id,
    firstName: admin.firstName,
    lastName: admin.lastName,
    photo: admin.photo || "",
    email: admin.email,
    role: admin.role,
    isActive: admin.isActive,
    createdAt: admin.createdAt,
    updatedAt: admin.updatedAt,
  };
};


const loginAdmin = async (req,res,next) => {
    try {
        const {email,password} = req.body
        if(!email || !password) {
            return res.status(400).json({message: "Email and Password are required"})
        }
        const admin = await Admin.findOne({ email }).select('+password');
        if (!admin) {
        return res.status(401).json({ message: 'Invalid email or password' });
        }

        const isMatch = await bcrypt.compare(password, admin.password);
        if (!isMatch) {
        return res.status(401).json({ message: 'Invalid email or password' });
        }

        if (!admin.isActive) {
        return res.status(403).json({ 
            message: 'Account is deactivated. Contact support.' 
        });
        }

        const token = jwt.sign(
        { id: admin._id },
        ENV.JWT_SECRET,
        { expiresIn: ENV.JWT_EXPIRES_IN }
        );
        res.json({
            message: " Admin login successful",
            token,
            admin: serializeAdmin(admin)
        });
    } catch(error) {
        next(error)
    }

    
}

const getMe = async (req,res,next) => {
    try {
        res.json({admin:serializeAdmin(req.admin)})
    } catch (error) {
        next(error)
    } 
}

const changePassword = async (req,res,next) => {
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

        const admin = await Admin.findById(req.admin._id).select('+password');
        if (!admin) {
        return res.status(404).json({ message: 'Admin not found' });
        }

        const isMatch = await bcrypt.compare(currentPassword, admin.password);
        if (!isMatch) {
        return res.status(401).json({ message: 'Current password is incorrect' });
        }

        admin.password = await bcrypt.hash(newPassword, 10);
        await admin.save();
        res.json({message:'Password updated successfully.'})
    } catch(error) {
            next(error)
        }
}

const getAdminDashboard = async (req,res,next) => {

}
const updateMyPhoto = async (req, res, next) => {
  try {
    const uploadedUrls = [];

    try {
      if (!req.files?.photo?.[0]) {
        return res.status(400).json({ message: 'Profile photo is required' });
      }

      const uploaded = await uploadFiles(req.files, 'admins');
      uploadedUrls.push(...Object.values(uploaded).filter(Boolean));

      const admin = await Admin.findById(req.admin._id);
      if (!admin) {
        await deleteFromCloudinaryMany(uploadedUrls);
        return res.status(404).json({ message: 'Admin not found' });
      }

      const previousPhoto = admin.photo;
      admin.photo = uploaded.photo;
      await admin.save();

      if (previousPhoto) {
        await deleteFromCloudinaryMany([previousPhoto]);
      }

      res.json({
        message: 'Profile photo updated successfully',
        admin: serializeAdmin(admin),
      });
    } catch (error) {
      await deleteFromCloudinaryMany(uploadedUrls);
      next(error);
    }
  } catch (error) {
    next(error);
  }
};

export {loginAdmin, getMe, changePassword,getAdminDashboard,updateMyPhoto}