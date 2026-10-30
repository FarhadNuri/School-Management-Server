import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

import Guardian from '../../models/guardian.model.js';
import User from '../../models/user.model.js';
import { uploadFiles, deleteFromCloudinaryMany } from '../../middleware/multer.middleware.js';
import generatePassword from '../../utils/generatePassword.js';
import mailer from '../../utils/Mailer.js';
import { guardianCredentialsEmail } from '../../utils/emailTemplate.js';

import {
    parseJson,
    isTrue,
    normalizeAddress,
    hasCompleteAddress,
    normalizeContactInfo,
    normalizeSocialMedia,
    emailTaken,
    findUserIds,
    populateUser,
} from '../../utils/userHelpers.js';
import {
    isValidIdType,
    needsIdBack,
} from '../../utils/idTypes.js';
const resolveIdentification = ({
    idType,
    uploadedFront,
    uploadedBack,
    existing = {},
    required = false,
}) => {
    const front =
        uploadedFront || existing.front || existing.idPhoto || '';
    const back =
        idType === 'Passport'
            ? ''
            : uploadedBack || existing.back || '';

    if (required && !front) {
        return { error: 'ID front document is required' };
    }

    if (required && needsIdBack(idType) && !back) {
        return { error: 'ID back document is required' };
    }

    return {
        identification: {
            front,
            back: needsIdBack(idType) ? back : '',
        },
    };
};

const guardianPopulate = [
    populateUser,
    {
        path: 'students',
        select: 'class user',
        populate: [
            {
                path: 'user',
                select: 'firstName lastName email photo isActive',
            },
            {
                path: 'class',
                select: 'className classCode grade academicYear isActive',
            },
        ],
    },
];
export const getGuardians = async (req, res, next) => {
    try {
        const { search, isActive } = req.query;
        const userIds = await findUserIds({
            role: 'guardian',
            search,
            isActive,
            includePhoneSearch: true,
        });
        const guardians = await Guardian.find({ user: { $in: userIds } })
            .populate(guardianPopulate)
            .sort({ createdAt: -1 })
            .lean();
        res.json({ count: guardians.length, guardians });
    } catch (error) {
        next(error);
    }
};

export const getGuardianById = async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid guardian ID' });
        }

        const guardian = await Guardian.findById(id)
            .populate(guardianPopulate)
            .lean();
        if (!guardian || !guardian.user || guardian.user.isDeleted) {
            return res.status(404).json({ message: 'Guardian not found' });
        }
        res.status(200).json({ guardian });
    } catch (error) {
        next(error);
    }
};

export const setGuardianStatus = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { isActive } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid guardian ID' });
        }

        if (isActive === undefined) {
            return res.status(400).json({ message: 'isActive is required' });
        }

        const guardian = await Guardian.findById(id);
        if (!guardian) {
            return res.status(404).json({ message: 'Guardian not found' });
        }

        const user = await User.findById(guardian.user);
        if (!user || user.isDeleted) {
            return res.status(404).json({ message: 'Guardian not found' });
        }

        user.isActive = isTrue(isActive);
        await user.save();

        const guardianData = await Guardian.findById(id).populate(
            guardianPopulate
        );

        res.json({
            message: user.isActive
                ? 'Guardian unbanned successfully'
                : 'Guardian banned successfully',
            guardian: guardianData,
        });
    } catch (error) {
        next(error);
    }
};

export const updateGuardian = async (req, res, next) => {
    const uploadedUrls = [];

    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid guardian ID' });
        }

        const guardian = await Guardian.findById(id);
        if (!guardian) {
            return res.status(404).json({ message: 'Guardian not found' });
        }

        const user = await User.findById(guardian.user);
        if (!user || user.isDeleted) {
            return res.status(404).json({ message: 'Guardian user not found' });
        }

        const { firstName, lastName, email, password, isActive, idType } = req.body;
        const contactInfo = parseJson(req.body.contactInfo, null);
        const socialMedia = parseJson(req.body.socialMedia, null);
        const addressInput = parseJson(req.body.address, null);

        if (!firstName?.trim() || !lastName?.trim() || !email?.trim()) {
            return res.status(400).json({
                message: 'First name, last name, and email are required',
            });
        }

        const nextIdType = (idType || guardian.idType || '').trim();
        if (!isValidIdType(nextIdType)) {
            return res.status(400).json({ message: 'Valid guardian ID type is required' });
        }
        const emailNormalized = email.toLowerCase().trim();
        if (emailNormalized !== user.email && (await emailTaken(emailNormalized, user._id))) {
            return res.status(409).json({
                message: 'A user with this email already exists',
            });
        }

        if (addressInput) {
            const address = normalizeAddress(addressInput);

            if (!hasCompleteAddress(address)) {
                return res.status(400).json({
                    message: 'Complete guardian address is required',
                });
            }

            user.address = address;
        }

        const uploaded = await uploadFiles(req.files, 'guardians');
        uploadedUrls.push(...Object.values(uploaded).filter(Boolean));
        const urlsToDelete = [];

        user.firstName = firstName.trim();
        user.lastName = lastName.trim();
        user.email = emailNormalized;
        guardian.idType = nextIdType;

        if (password) {
            user.password = await bcrypt.hash(password, 10);
        }

        if (isActive !== undefined) {
            user.isActive = isTrue(isActive);
        }

        if (contactInfo) {
            user.contactInfo = normalizeContactInfo(contactInfo);
        }

        if (socialMedia) {
            user.socialMedia = normalizeSocialMedia(socialMedia);
        }

        if (uploaded.photo) {
            if (user.photo) urlsToDelete.push(user.photo);
            user.photo = uploaded.photo;
        }

        const idDocs = resolveIdentification({
            idType: nextIdType,
            uploadedFront: uploaded.idFront,
            uploadedBack: uploaded.idBack,
            existing: {
                ...(guardian.identification?.toObject?.() ||
                    guardian.identification ||
                    {}),
                idPhoto: guardian.idPhoto,
            },
            required: true,
        });

        if (idDocs.error) {
            await deleteFromCloudinaryMany(uploadedUrls);
            return res.status(400).json({ message: idDocs.error });
        }

        if (uploaded.idFront && (guardian.identification?.front || guardian.idPhoto)) {
            urlsToDelete.push(guardian.identification?.front || guardian.idPhoto);
        }
        if (
            (uploaded.idBack || (nextIdType === 'Passport' || nextIdType === 'Birth Certificate')) &&
            guardian.identification?.back
        ) {
            urlsToDelete.push(guardian.identification.back);
        }

        guardian.identification = idDocs.identification;
        guardian.idPhoto = '';

        await Promise.all([user.save(), guardian.save()]);
        uploadedUrls.length = 0;
        await deleteFromCloudinaryMany(urlsToDelete);

        const guardianData = await Guardian.findById(guardian._id).populate(guardianPopulate);

        res.json({
            message: 'Guardian updated successfully',
            guardian: guardianData,
        });
    } catch (error) {
        await deleteFromCloudinaryMany(uploadedUrls);
        next(error);
    }
};
export const addGuardian = async (req, res, next) => {
  const uploadedUrls = [];
  let createdUserId = null;

  try {
    const { firstName, lastName, email, isActive, idType } = req.body;
    const contactInfo = normalizeContactInfo(parseJson(req.body.contactInfo, {}));
    const socialMedia = normalizeSocialMedia(parseJson(req.body.socialMedia, {}));
    const address = normalizeAddress(parseJson(req.body.address, {}));
    const nextIdType = (idType || '').trim();

    if (!firstName?.trim() || !lastName?.trim() || !email?.trim()) {
      return res.status(400).json({
        message: 'First name, last name, and email are required',
      });
    }

    if (!isValidIdType(nextIdType)) {
      return res.status(400).json({ message: 'Valid guardian ID type is required' });
    }

    if (!hasCompleteAddress(address)) {
      return res.status(400).json({
        message: 'Complete guardian address is required',
      });
    }

    const emailNormalized = email.toLowerCase().trim();

    if (await emailTaken(emailNormalized)) {
      return res.status(409).json({
        message: 'A user with this email already exists',
      });
    }

    const uploaded = await uploadFiles(req.files, 'guardians');
    uploadedUrls.push(...Object.values(uploaded).filter(Boolean));

    const idDocs = resolveIdentification({
      idType: nextIdType,
      uploadedFront: uploaded.idFront,
      uploadedBack: uploaded.idBack,
      required: true,
    });

    if (idDocs.error) {
      await deleteFromCloudinaryMany(uploadedUrls);
      return res.status(400).json({ message: idDocs.error });
    }

    const plainPassword = generatePassword();
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    const user = await UserModel.create({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: emailNormalized,
      password: hashedPassword,
      photo: uploaded.photo || '',
      contactInfo,
      address,
      socialMedia,
      role: 'guardian',
      isActive: isActive === undefined ? true : isTrue(isActive),
    });
    createdUserId = user._id;

    const guardian = await GuardianModel.create({
      user: user._id,
      idType: nextIdType,
      identification: idDocs.identification,
      students: [],
    });

    uploadedUrls.length = 0;

    const mail = guardianCredentialsEmail({
      firstName: user.firstName,
      email: emailNormalized,
      password: plainPassword,
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
      console.error('Guardian credentials email failed:', mailError.message);
      emailSent = false;
    }

    const guardianData = await GuardianModel.findById(guardian._id).populate(populateUser);

    res.status(201).json({
      message: 'Guardian created successfully',
      guardian: guardianData,
      credentials: {
        guardian: {
          name: `${user.firstName} ${user.lastName}`.trim(),
          email: emailNormalized,
          password: plainPassword,
          role: 'guardian',
        },
      },
      emailSent,
    });
  } catch (error) {
    if (createdUserId) {
      await UserModel.findByIdAndDelete(createdUserId).catch(() => {});
    }
    await deleteFromCloudinaryMany(uploadedUrls);
    next(error);
  }
};

import StudentModel from '../../models/student.model.js';

export const deleteGuardian = async (req, res) => {
  try {
    const { id } = req.params;
    const guardian = await Guardian.findById(id);
    if (!guardian) {
      return res.status(404).json({ success: false, message: 'Guardian not found' });
    }

    const userId = guardian.user;

    // Cloudinary cleanup
    if (guardian.identification?.front) {
      try {
        const publicId = getPublicIdFromUrl(guardian.identification.front);
        if (publicId) await deleteImageFromCloudinary(publicId);
      } catch (e) {}
    }
    if (guardian.identification?.back) {
      try {
        const publicId = getPublicIdFromUrl(guardian.identification.back);
        if (publicId) await deleteImageFromCloudinary(publicId);
      } catch (e) {}
    }
    if (guardian.idPhoto) {
      try {
        const publicId = getPublicIdFromUrl(guardian.idPhoto);
        if (publicId) await deleteImageFromCloudinary(publicId);
      } catch (e) {}
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

    // Unset guardian from students who reference this guardian
    try {
      const StudentRef = typeof StudentModel !== 'undefined' ? StudentModel : (typeof Student !== 'undefined' ? Student : null);
      if (StudentRef) {
        await StudentRef.updateMany({ guardian: id }, { $unset: { guardian: "" } });
      }
    } catch (e) {
      console.error('Error unsetting guardian from student:', e);
    }

    await Guardian.findByIdAndDelete(id);

    return res.status(200).json({ success: true, message: 'Guardian deleted successfully' });
  } catch (error) {
    console.error('Error in deleteGuardian:', error);
    return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
};


export const resetGuardianPassword = async (req, res, next) => {
  try {
    const { id } = req.params;
    const guardian = await GuardianModel.findById(id).populate('user');
    if (!guardian || !guardian.user) {
      return res.status(404).json({ message: 'Guardian record or user account not found' });
    }

    const newPassword = generatePassword();
    guardian.user.password = await bcrypt.hash(newPassword, 10);
    await guardian.user.save();

    const guardianName = `${guardian.user.firstName} ${guardian.user.lastName}`.trim();
    const mail = guardianCredentialsEmail({
      firstName: guardian.user.firstName,
      email: guardian.user.email,
      password: newPassword,
    });

    let emailSent = true;
    try {
      await mailer.sendEmail({
        to: guardian.user.email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    } catch (err) {
      console.warn('Guardian reset password email delivery warning:', err.message);
      emailSent = false;
    }

    return res.status(200).json({
      message: 'Guardian password reset successfully',
      credentials: {
        guardian: {
          name: guardianName,
          email: guardian.user.email,
          password: newPassword,
          role: 'guardian',
        },
      },
      emailSent,
    });
  } catch (error) {
    next(error);
  }
};
