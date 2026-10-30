import mailer from '../../utils/Mailer.js'
import { studentCredentialsEmail, guardianCredentialsEmail } from '../../utils/emailTemplate.js'
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

import { UserModel } from '../../models/user.model.js';
import StudentModel from '../../models/student.model.js';
import GuardianModel from '../../models/guardian.model.js';
import ClassModel from '../../models/class.model.js';
import Course from '../../models/course.model.js';
import { uploadFiles, deleteFromCloudinaryMany } from '../../middleware/multer.middleware.js';
import generatePassword from '../../utils/generatePassword.js';


import {
    parseJson,
    isTrue,
    normalizeAddress,
    hasCompleteAddress,
    normalizeContactInfo,
    normalizeGender,
    emailTaken,
    findUserIds,
    populateUser,
} from '../../utils/userHelpers.js';

import {
    ID_TYPES,
    isValidIdType,
    needsIdBack,
} from '../../utils/idTypes.js';

const isValidEmail = (value) => /^\S+@\S+\.\S+$/.test(String(value).trim());

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

const splitFullName = (fullName) => {
    const trimmed = String(fullName).trim();
    if (!trimmed) return { firstName: '', lastName: '' };

    const spaceIndex = trimmed.indexOf(' ');
    if (spaceIndex === -1) return { firstName: trimmed, lastName: trimmed };

    return {
        firstName: trimmed.slice(0, spaceIndex),
        lastName: trimmed.slice(spaceIndex + 1).trim() || trimmed,
    };
};

const resolveGuardianInput = (body) => {
    const guardianPayload = parseJson(body.guardian, null);

    if (guardianPayload) {
        return {
            firstName: guardianPayload.firstName?.trim() || '',
            lastName: guardianPayload.lastName?.trim() || '',
            email: guardianPayload.email?.trim() || '',
            idType: guardianPayload.idType?.trim() || '',
            contactInfo: normalizeContactInfo(guardianPayload.contactInfo || {}),
            address: normalizeAddress(guardianPayload.address || {}),
        };
    }

    const fromParentName = splitFullName(body.parentName || '');

    return {
        firstName: (body.guardianFirstName || fromParentName.firstName).trim(),
        lastName: (body.guardianLastName || fromParentName.lastName).trim(),
        email: (body.guardianEmail || body.parentEmail || '').trim(),
        idType: (body.guardianIdType || '').trim(),
        contactInfo: normalizeContactInfo(parseJson(body.guardianContactInfo, {})),
        address: normalizeAddress(parseJson(body.guardianAddress, {})),
    };
};

const studentPopulate = [
    populateUser,
    {
        path: 'guardian',
        populate: populateUser,
    },
    {
        path: 'class',
        select: 'className classCode grade academicYear isActive teachers',
        populate: {
            path: 'teachers',
            populate: {
                path: 'user',
                select: 'firstName lastName email photo isActive',
            },
        },
    },
];

const cleanupUsers = async (userIds = []) => {
    const ids = userIds.filter(Boolean);
    if (!ids.length) return;
    await UserModel.deleteMany({ _id: { $in: ids } }).catch(() => { });
};

const rollbackStudentCreation = async ({
    studentId,
    guardianId,
    createdGuardianId,
    createdUserIds,
    classId,
}) => {
    if (studentId) {
        if (classId) {
            await ClassModel.findByIdAndUpdate(classId, {
                $pull: { students: studentId },
            }).catch(() => { });
        }

        if (guardianId) {
            await GuardianModel.findByIdAndUpdate(guardianId, {
                $pull: { students: studentId },
            }).catch(() => { });
        }

        await StudentModel.findByIdAndDelete(studentId).catch(() => { });
    }

    if (createdGuardianId) {
        await GuardianModel.findByIdAndDelete(createdGuardianId).catch(() => { });
    }

    await cleanupUsers(createdUserIds);
};

const ensureGuardianRecord = async ({ userId, idType, identification }) => {
    let guardianDoc = await GuardianModel.findOne({ user: userId });
    if (guardianDoc) {
        return { guardianDoc, created: false };
    }

    guardianDoc = await GuardianModel.create({
        user: userId,
        idType,
        identification: identification || { front: '', back: '' },
        students: [],
    });

    return { guardianDoc, created: true };
};


const addStudent = async (req, res, next) => {
    const uploadedUrls = [];
    const createdUserIds = [];
    let createdGuardianId = null;
    let createdStudentId = null;
    let linkedGuardianId = null;
    let classId = null;

    try {
        // Core student fields from the request body[cite: 43]
        const {
            firstName,
            lastName,
            email,
            dateOfBirth,
            gender,
            emergencyContact,
            isActive,
            idType,
        } = req.body;

        // Normalize JSON/nested fields; class accepts either `class` or `classId`
        classId = req.body.class || req.body.classId;
        const contactInfo = normalizeContactInfo(parseJson(req.body.contactInfo, {}));
        const studentAddress = normalizeAddress(
            parseJson(req.body.address || req.body.studentAddress, {})
        );
        const sameAsStudentAddress = isTrue(req.body.sameAsStudentAddress);
        const guardian = resolveGuardianInput(req.body);
        const studentIdType = (idType || '').trim();
        const normalizedGender = normalizeGender(gender);

        // Copy the student's address onto the guardian when that flag is set
        if (sameAsStudentAddress) {
            guardian.address = studentAddress;
        }

        // Student identity fields are all required
        if (
            !firstName?.trim() ||
            !lastName?.trim() ||
            !email?.trim() ||
            !dateOfBirth ||
            !normalizedGender ||
            !emergencyContact?.trim()
        ) {
            return res.status(400).json({
                message:
                    'First name, last name, email, date of birth, gender, and emergency contact are required',
            });
        }

        if (!isValidEmail(email)) {
            return res.status(400).json({
                message: 'Please provide a valid student email address',
            });
        }

        if (!isValidIdType(studentIdType)) {
            return res.status(400).json({ message: 'Valid student ID type is required' });
        }

        if (!hasCompleteAddress(studentAddress)) {
            return res.status(400).json({ message: 'Complete student address is required' });
        }

        // Class is optional, but a provided ID must be valid and exist
        if (classId) {
            if (!mongoose.Types.ObjectId.isValid(classId)) {
                return res.status(400).json({ message: 'Invalid class ID' });
            }

            const classExists = await ClassModel.exists({ _id: classId });
            if (!classExists) {
                return res.status(404).json({ message: 'Class not found' });
            }
        }

        const studentEmail = email.toLowerCase().trim();
        const existingGuardianId = (req.body.existingGuardianId || '').trim();

        let existingGuardianUser = null;
        let linkedGuardianDoc = null;

        // Admin picked an existing guardian: load the Guardian + User and confirm they are valid
        if (existingGuardianId) {
            if (!mongoose.Types.ObjectId.isValid(existingGuardianId)) {
                return res.status(400).json({ message: 'Invalid guardian ID' });
            }

            linkedGuardianDoc = await GuardianModel.findById(existingGuardianId);
            if (!linkedGuardianDoc) {
                return res.status(404).json({ message: 'Selected guardian not found' });
            }

            existingGuardianUser = await UserModel.findById(linkedGuardianDoc.user).select(
                '+password'
            );
            if (
                !existingGuardianUser ||
                existingGuardianUser.isDeleted ||
                existingGuardianUser.role !== 'guardian'
            ) {
                return res.status(404).json({ message: 'Selected guardian not found' });
            }
        }

        // Use the existing guardian's email if linking; otherwise the one from the form
        const guardianEmail = (
            existingGuardianUser?.email || guardian.email || ''
        )
            .toLowerCase()
            .trim();

        if (!guardianEmail || !isValidEmail(guardianEmail)) {
            return res.status(400).json({
                message: 'Please provide a valid guardian email address',
            });
        }

        // Two User accounts cannot share an email
        if (studentEmail === guardianEmail) {
            return res.status(400).json({
                message: 'Student and guardian must have different emails',
            });
        }

        if (await emailTaken(studentEmail)) {
            return res.status(409).json({
                message: 'A user with this student email already exists',
            });
        }

        // New guardian: require their details, then see if that email already belongs to a user[cite: 49]
        if (!existingGuardianUser) {
            if (!guardian.firstName || !guardian.lastName) {
                return res.status(400).json({
                    message: 'Guardian first name, last name, and email are required',
                });
            }

            if (!guardian.contactInfo?.phone?.trim()) {
                return res.status(400).json({
                    message: 'Guardian phone number is required',
                });
            }

            if (!isValidIdType(guardian.idType)) {
                return res.status(400).json({
                    message: 'Valid guardian ID type is required',
                });
            }

            if (!hasCompleteAddress(guardian.address)) {
                return res.status(400).json({
                    message: 'Complete guardian address is required',
                });
            }

            existingGuardianUser = await UserModel.findOne({
                email: guardianEmail,
                isDeleted: { $ne: true },
            }).select('+password');

            if (existingGuardianUser && existingGuardianUser.role !== 'guardian') {
                return res.status(409).json({
                    message: 'A user with this guardian email already exists',
                });
            }
        }

        const linkingExistingGuardian = Boolean(existingGuardianUser);
        const guardianHasPassword = Boolean(existingGuardianUser?.password);
        // if the guardian user does not have a password,then it means this student is
        // his first student so we should email the guardian with his credentials after
        // creating the student and his(guardian) account[cite: 51]
        const shouldEmailGuardian = !existingGuardianUser || !guardianHasPassword;

        // Upload photos and ID scans; keep URLs so we can delete them if validation fails next
        const uploaded = await uploadFiles(req.files, 'students');
        uploadedUrls.push(...Object.values(uploaded).filter(Boolean));

        if (!uploaded.photo) {
            await deleteFromCloudinaryMany(uploadedUrls);
            return res.status(400).json({ message: 'Student profile photo is required' });
        }

        // New guardians need a photo; an existing guardian already has one on file
        if (!linkingExistingGuardian && !uploaded.guardianPhoto) {
            await deleteFromCloudinaryMany(uploadedUrls);
            return res.status(400).json({ message: 'Guardian photo is required' });
        }
        const studentIdDocs = resolveIdentification({
            idType: studentIdType,
            uploadedFront: uploaded.idFront,
            uploadedBack: uploaded.idBack,
            required: true,
        });
        if (studentIdDocs.error) {
            await deleteFromCloudinaryMany(uploadedUrls);
            return res.status(400).json({ message: studentIdDocs.error });
        }

        // New guardian: ID docs required. Existing: reuse stored docs and allow
        // optional replacements
        const guardianIdDocs = resolveIdentification({
            idType: linkingExistingGuardian
                ? linkedGuardianDoc?.idType || guardian.idType || 'National ID'
                : guardian.idType,
            uploadedFront: uploaded.guardianIdFront,
            uploadedBack: uploaded.guardianIdBack,
            existing: {
                ...(linkedGuardianDoc?.identification?.toObject?.() ||
                    linkedGuardianDoc?.identification ||
                    {}),
                idPhoto: linkedGuardianDoc?.idPhoto,
            },
            required: !linkingExistingGuardian,
        });
        if (guardianIdDocs.error) {
            await deleteFromCloudinaryMany(uploadedUrls);
            return res.status(400).json({
                message: `Guardian ${guardianIdDocs.error.charAt(0).toLowerCase()}${guardianIdDocs.error.slice(1)}`,
            });
        }

        // Temp student password always. Guardian password only if they do not already
        // have one
        const studentPassword = generatePassword();
        const studentName = `${firstName.trim()} ${lastName.trim()}`;
        let guardianPassword = null;
        let pendingGuardianPasswordHash = null;
        let guardianUser;
        let guardianDoc;

        if (existingGuardianUser) {
            guardianUser = existingGuardianUser;

            // Hash now, but do not save yet - wait until credential emails succeed
            if (!guardianHasPassword) {
                guardianPassword = generatePassword();
                pendingGuardianPasswordHash = await bcrypt.hash(guardianPassword, 10);
            }

            if (linkedGuardianDoc) {
                // Admin selected this guardian by ID
                guardianDoc = linkedGuardianDoc;
            } else {
                // Email matched an existing guardian user; create a Guardian record if missing
                const ensured = await ensureGuardianRecord({
                    userId: guardianUser._id,
                    idType: guardian.idType,
                    identification: guardianIdDocs.identification,
                });
                guardianDoc = ensured.guardianDoc;
                if (ensured.created) {
                    createdGuardianId = guardianDoc._id;
                }
            }
        } else {
            // Brand-new guardian: create the User account, then the Guardian profile
            guardianPassword = generatePassword();
            const hashedGuardianPassword = await bcrypt.hash(guardianPassword, 10);

            guardianUser = await UserModel.create({
                firstName: guardian.firstName,
                lastName: guardian.lastName,
                email: guardianEmail,
                password: hashedGuardianPassword,
                photo: uploaded.guardianPhoto || '',
                contactInfo: guardian.contactInfo,
                address: guardian.address,
                role: 'guardian',
                isActive: true,
            });
            createdUserIds.push(guardianUser._id);

            guardianDoc = await GuardianModel.create({
                user: guardianUser._id,
                idType: guardian.idType,
                identification: guardianIdDocs.identification,
                students: [],
            });
            createdGuardianId = guardianDoc._id;
        }

        // Create the student User, then the Student profile that points at it and the guardian
        const hashedStudentPassword = await bcrypt.hash(studentPassword, 10);

        const studentUser = await UserModel.create({
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            email: studentEmail,
            password: hashedStudentPassword,
            photo: uploaded.photo || '',
            contactInfo,
            address: studentAddress,
            gender: normalizedGender,
            dateOfBirth,
            role: 'student',
            isActive: isActive === undefined ? true : isTrue(isActive),
        });
        createdUserIds.push(studentUser._id);

        const student = await StudentModel.create({
            user: studentUser._id,
            idType: studentIdType,
            identification: studentIdDocs.identification,
            class: classId || undefined,
            guardian: guardianDoc._id,
            emergencyContact: emergencyContact.trim(),
        });
        createdStudentId = student._id;
        linkedGuardianId = guardianDoc._id;

        // Keep the guardian's students[] list in sync
        await GuardianModel.findByIdAndUpdate(guardianDoc._id, {
            $addToSet: { students: student._id },
        });

        // Enroll in the class roster when a class was provided
        if (classId) {
            await ClassModel.findByIdAndUpdate(classId, {
                $addToSet: { students: student._id },
            });
        }

        // Files are now attached to saved records - do not delete them if a later step fails
        uploadedUrls.length = 0;

        // Always email the student their login. Email the guardian only if they need credentials
        const studentMail = studentCredentialsEmail({
            firstName: studentUser.firstName,
            email: studentEmail,
            password: studentPassword,
        });

        const emailJobs = [
            mailer.sendEmail({
                to: studentEmail,
                subject: studentMail.subject,
                text: studentMail.text,
                html: studentMail.html,
            }),
        ];

        if (shouldEmailGuardian) {
            const guardianMail = guardianCredentialsEmail({
                firstName: guardianUser.firstName,
                email: guardianEmail,
                password: guardianPassword,
                studentName,
            });

            emailJobs.push(
                mailer.sendEmail({
                    to: guardianEmail,
                    subject: guardianMail.subject,
                    text: guardianMail.text,
                    html: guardianMail.html,
                })
            );
        }

        // Persist the new guardian password
        if (pendingGuardianPasswordHash) {
            guardianUser.password = pendingGuardianPasswordHash;
            await guardianUser.save();
        }

        let emailSent = true;
        try {
            await Promise.all(emailJobs);
        } catch (emailError) {
            console.error('Credential email failed after account creation (continuing student creation):', emailError.message);
            emailSent = false;
        }

        // Return the populated student (user, guardian, class) without heavy related collections
        const studentData = await StudentModel.findById(student._id)
            .select('-assignments -announcements -events -resources -exams -quizzes')
            .populate(studentPopulate)
            .lean();

        res.status(201).json({
            message: existingGuardianUser
                ? 'Student created and linked to existing guardian successfully'
                : 'Student and guardian created successfully',
            student: studentData,
            credentials: {
                student: {
                    name: studentName,
                    email: studentEmail,
                    password: studentPassword,
                    role: 'student',
                },
                ...(guardianPassword ? {
                    guardian: {
                        name: `${guardianUser.firstName} ${guardianUser.lastName}`.trim(),
                        email: guardianEmail,
                        password: guardianPassword,
                        role: 'guardian',
                    }
                } : {}),
            },
            emailSent,
            guardianEmailSent: Boolean(shouldEmailGuardian && emailSent),
        });
    } catch (error) {
        // Undo any DB writes from this request and delete orphaned Cloudinary uploads
        await rollbackStudentCreation({
            studentId: createdStudentId,
            guardianId: linkedGuardianId,
            createdGuardianId,
            createdUserIds,
            classId,
        });
        await deleteFromCloudinaryMany(uploadedUrls);
        next(error);
    }
};

const getStudents = async (req, res, next) => {
    try {
        const { search, isActive } = req.query;
        const userIds = await findUserIds({ role: 'student', search, isActive });

        const students = await StudentModel.find({ user: { $in: userIds } })
            .select('-assignments -announcements -events -resources -exams -quizzes')
            .populate(studentPopulate)
            .sort({ createdAt: -1 })
            .lean();

        res.json({
            count: students.length,
            students,
        });
    } catch (error) {
        next(error);
    }
};

const getStudentById = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid student ID' });
        }

        const student = await StudentModel.findById(id)
            .select('-assignments -announcements -events -resources -exams -quizzes')
            .populate(studentPopulate)
            .lean();

        if (!student || !student.user || student.user.isDeleted) {
            return res.status(404).json({ message: 'Student not found' });
        }

        res.json({ student });
    } catch (error) {
        next(error);
    }
};

const setStudentStatus = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { isActive } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid student ID' });
        }

        if (isActive === undefined) {
            return res.status(400).json({ message: 'isActive is required' });
        }

        const student = await StudentModel.findById(id);
        if (!student) {
            return res.status(404).json({ message: 'Student not found' });
        }

        const user = await UserModel.findById(student.user);
        if (!user || user.isDeleted) {
            return res.status(404).json({ message: 'Student not found' });
        }

        user.isActive = isTrue(isActive);
        await user.save();

        const studentData = await StudentModel.findById(id)
            .select('-assignments -announcements -events -resources -exams -quizzes')
            .populate(studentPopulate);

        res.json({
            message: user.isActive
                ? 'Student unbanned successfully'
                : 'Student banned successfully',
            student: studentData,
        });
    } catch (error) {
        next(error);
    }
};

const updateStudent = async (req, res, next) => {
    const uploadedUrls = [];

    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid student ID' });
        }

        const student = await StudentModel.findById(id);
        if (!student) {
            return res.status(404).json({ message: 'Student not found' });
        }

        const studentUser = await UserModel.findById(student.user);
        if (!studentUser || studentUser.isDeleted) {
            return res.status(404).json({ message: 'Student user account not found' });
        }

        const guardianDoc = student.guardian
            ? await GuardianModel.findById(student.guardian)
            : null;

        if (!guardianDoc) {
            return res.status(404).json({ message: 'Guardian not found for this student' });
        }

        const guardianUser = await UserModel.findById(guardianDoc.user);
        if (!guardianUser || guardianUser.isDeleted) {
            return res.status(404).json({ message: 'Guardian user account not found' });
        }

        const {
            firstName,
            lastName,
            email,
            dateOfBirth,
            gender,
            emergencyContact,
            isActive,
            idType,
        } = req.body;

        const classId = req.body.class || req.body.classId || '';
        const contactInfo = parseJson(req.body.contactInfo, null);
        const studentAddress = normalizeAddress(
            parseJson(req.body.address || req.body.studentAddress, {})
        );
        const sameAsStudentAddress = isTrue(req.body.sameAsStudentAddress);
        const guardian = resolveGuardianInput(req.body);
        const studentIdType = (idType || '').trim();
        const normalizedGender = normalizeGender(gender);

        if (sameAsStudentAddress) {
            guardian.address = studentAddress;
        }

        if (
            !firstName?.trim() ||
            !lastName?.trim() ||
            !email?.trim() ||
            !dateOfBirth ||
            !normalizedGender ||
            !emergencyContact?.trim()
        ) {
            return res.status(400).json({
                message:
                    'First name, last name, email, date of birth, gender, and emergency contact are required',
            });
        }

        if (!isValidEmail(email)) {
            return res.status(400).json({
                message: 'Please provide a valid student email address',
            });
        }

        if (!isValidIdType(studentIdType)) {
            return res.status(400).json({ message: 'Valid student ID type is required' });
        }

        if (!guardian.firstName || !guardian.lastName || !guardian.email) {
            return res.status(400).json({
                message: 'Guardian first name, last name, and email are required',
            });
        }

        if (!isValidEmail(guardian.email)) {
            return res.status(400).json({
                message: 'Please provide a valid guardian email address',
            });
        }

        if (!guardian.contactInfo?.phone?.trim()) {
            return res.status(400).json({
                message: 'Guardian phone number is required',
            });
        }

        if (!isValidIdType(guardian.idType)) {
            return res.status(400).json({ message: 'Valid guardian ID type is required' });
        }

        if (!hasCompleteAddress(studentAddress)) {
            return res.status(400).json({ message: 'Complete student address is required' });
        }

        if (!hasCompleteAddress(guardian.address)) {
            return res.status(400).json({ message: 'Complete guardian address is required' });
        }

        if (classId) {
            if (!mongoose.Types.ObjectId.isValid(classId)) {
                return res.status(400).json({ message: 'Invalid class ID' });
            }

            const classExists = await ClassModel.exists({ _id: classId });
            if (!classExists) {
                return res.status(404).json({ message: 'Class not found' });
            }
        }

        const studentEmail = email.toLowerCase().trim();
        const guardianEmail = guardian.email.toLowerCase().trim();

        if (studentEmail === guardianEmail) {
            return res.status(400).json({
                message: 'Student and guardian must have different emails',
            });
        }

        const [duplicateStudentEmail, duplicateGuardianEmail] = await Promise.all([
            emailTaken(studentEmail, studentUser._id),
            emailTaken(guardianEmail, guardianUser._id),
        ]);

        if (duplicateStudentEmail) {
            return res.status(409).json({ message: 'A user with this student email already exists' });
        }

        if (duplicateGuardianEmail) {
            return res.status(409).json({ message: 'A user with this guardian email already exists' });
        }

        const uploaded = await uploadFiles(req.files, 'students');
        uploadedUrls.push(...Object.values(uploaded).filter(Boolean));
        const urlsToDelete = [];
        if (!uploaded.guardianPhoto && !guardianUser.photo) {
            await deleteFromCloudinaryMany(uploadedUrls);
            return res.status(400).json({ message: 'Guardian photo is required' });
        }

        const previousClassId = student.class?.toString() || '';
        const nextClassId = classId || '';

        studentUser.firstName = firstName.trim();
        studentUser.lastName = lastName.trim();
        studentUser.email = studentEmail;
        studentUser.dateOfBirth = dateOfBirth;
        studentUser.gender = normalizedGender;
        studentUser.address = studentAddress;

        if (contactInfo) {
            studentUser.contactInfo = normalizeContactInfo(contactInfo);
        }

        if (isActive !== undefined) {
            studentUser.isActive = isTrue(isActive);
        }

        if (uploaded.photo) {
            if (studentUser.photo) urlsToDelete.push(studentUser.photo);
            studentUser.photo = uploaded.photo;
        }

        student.emergencyContact = emergencyContact.trim();
        student.idType = studentIdType;
        student.class = nextClassId || undefined;

        const studentIdDocs = resolveIdentification({
            idType: studentIdType,
            uploadedFront: uploaded.idFront,
            uploadedBack: uploaded.idBack,
            existing: {
                ...(student.identification?.toObject?.() ||
                    student.identification ||
                    {}),
                idPhoto: student.idPhoto,
            },
            required: true,
        });
        if (studentIdDocs.error) {
            await deleteFromCloudinaryMany(uploadedUrls);
            return res.status(400).json({ message: studentIdDocs.error });
        }

        if (uploaded.idFront && (student.identification?.front || student.idPhoto)) {
            urlsToDelete.push(student.identification?.front || student.idPhoto);
        }
        if (
            (uploaded.idBack || (studentIdType === 'Passport' || studentIdType === 'Birth Certificate')) &&
            student.identification?.back
        ) {
            urlsToDelete.push(student.identification.back);
        }

        student.identification = studentIdDocs.identification;
        student.idPhoto = '';

        guardianUser.firstName = guardian.firstName;
        guardianUser.lastName = guardian.lastName;
        guardianUser.email = guardianEmail;
        guardianUser.contactInfo = guardian.contactInfo;
        guardianUser.address = guardian.address;

        if (uploaded.guardianPhoto) {
            if (guardianUser.photo) urlsToDelete.push(guardianUser.photo);
            guardianUser.photo = uploaded.guardianPhoto;
        }

        guardianDoc.idType = guardian.idType;

        const guardianIdDocs = resolveIdentification({
            idType: guardian.idType,
            uploadedFront: uploaded.guardianIdFront,
            uploadedBack: uploaded.guardianIdBack,
            existing: {
                ...(guardianDoc.identification?.toObject?.() ||
                    guardianDoc.identification ||
                    {}),
                idPhoto: guardianDoc.idPhoto,
            },
            required: true,
        });
        if (guardianIdDocs.error) {
            await deleteFromCloudinaryMany(uploadedUrls);
            return res.status(400).json({
                message: `Guardian ${guardianIdDocs.error.charAt(0).toLowerCase()}${guardianIdDocs.error.slice(1)}`,
            });
        }

        if (
            uploaded.guardianIdFront &&
            (guardianDoc.identification?.front || guardianDoc.idPhoto)
        ) {
            urlsToDelete.push(
                guardianDoc.identification?.front || guardianDoc.idPhoto
            );
        }
        if (
            (uploaded.guardianIdBack || guardian.idType === 'Passport') &&
            guardianDoc.identification?.back
        ) {
            urlsToDelete.push(guardianDoc.identification.back);
        }
        guardianDoc.identification = guardianIdDocs.identification;
        guardianDoc.idPhoto = '';

        await Promise.all([
            studentUser.save(),
            student.save(),
            guardianUser.save(),
            guardianDoc.save(),
        ]);
        uploadedUrls.length = 0;

        const linkUpdates = [];

        if (previousClassId && previousClassId !== nextClassId) {
            linkUpdates.push(
                ClassModel.findByIdAndUpdate(previousClassId, {
                    $pull: { students: student._id },
                })
            );
        }

        if (nextClassId && previousClassId !== nextClassId) {
            linkUpdates.push(
                ClassModel.findByIdAndUpdate(nextClassId, {
                    $addToSet: { students: student._id },
                })
            );
        }

        if (linkUpdates.length) {
            await Promise.all(linkUpdates);
        }

        await deleteFromCloudinaryMany(urlsToDelete);

        const studentData = await StudentModel.findById(student._id)
            .select('-assignments -announcements -events -resources -exams -quizzes')
            .populate(studentPopulate);

        res.json({
            message: 'Student updated successfully',
            student: studentData,
        });
    } catch (error) {
        await deleteFromCloudinaryMany(uploadedUrls);
        next(error);
    }
};

export { addStudent, getStudents, getStudentById, setStudentStatus, updateStudent }

export const deleteStudent = async (req, res) => {
  try {
    const { id } = req.params;
    const student = await StudentModel.findById(id);
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const userId = student.user;
    let userPhoto = null;
    if (userId) {
      const user = await UserModel.findById(userId);
      userPhoto = user?.photo;
      await UserModel.findByIdAndDelete(userId);
    }

    // Cloudinary cleanup
    const urlsToDelete = [
      student.identification?.front,
      student.identification?.back,
      userPhoto,
    ].filter(Boolean);

    if (urlsToDelete.length > 0) {
      await deleteFromCloudinaryMany(urlsToDelete).catch(() => {});
    }

    // Clean up references:
    // Remove from Guardian
    await GuardianModel.updateMany({ students: id }, { $pull: { students: id } });
    // Remove from Class
    await ClassModel.updateMany({ students: id }, { $pull: { students: id } });
    // Remove from Course
    await Course.updateMany({ courseStudents: id }, { $pull: { courseStudents: id } });

    // Delete student
    await StudentModel.findByIdAndDelete(id);

    return res.status(200).json({ success: true, message: 'Student deleted successfully' });
  } catch (error) {
    console.error('Error in deleteStudent:', error);
    return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
};

export const resetStudentPassword = async (req, res, next) => {
  try {
    const { id } = req.params;
    const student = await StudentModel.findById(id).populate('user');
    if (!student || !student.user) {
      return res.status(404).json({ message: 'Student record or user account not found' });
    }

    const newPassword = generatePassword();
    student.user.password = await bcrypt.hash(newPassword, 10);
    await student.user.save();

    const studentName = `${student.user.firstName} ${student.user.lastName}`.trim();
    const mail = studentCredentialsEmail({
      firstName: student.user.firstName,
      email: student.user.email,
      password: newPassword,
    });

    let emailSent = true;
    try {
      await mailer.sendEmail({
        to: student.user.email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    } catch (err) {
      console.warn('Student reset password email delivery warning:', err.message);
      emailSent = false;
    }

    return res.status(200).json({
      message: 'Student password reset successfully',
      credentials: {
        student: {
          name: studentName,
          email: student.user.email,
          password: newPassword,
          role: 'student',
        },
      },
      emailSent,
    });
  } catch (error) {
    next(error);
  }
};
