import multer from "multer";
import cloudinary from '../config/cloudinary.js'


const ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/jpg',
  'appliocation/pdf'
]


const storage = multer.memoryStorage();

const fileFilter = (_req, file, cb) => {
  if (ALLOWED_TYPES.includes(file.mimetype)) {
    cb(null, true);
    return;
  }
  cb(new Error('Only Images and PDF files are allowes.'))
}

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter,
})


const uploadTeacherFiles = upload.fields([
  { name: 'picture', maxCount: 1 },
  { name: 'qualification0', maxCount: 1 },
  { name: 'qualification1', maxCount: 1 },
  { name: 'qualification2', maxCount: 1 },
  { name: 'idFront', maxCount: 1 },
  { name: 'idBack', maxCount: 1 },
])

/*
@param {object} file
@param {string} folder
@returns {Promise<string>}

*/
const uploadToCloudinary = (file, folder = 'teachers') => new Promise((resolve, reject) => {
  const isImage = String(file.mimetype || '').startsWith('image/')
  cloudinary.uploader
    .upload_stream({
      folder: `school-webapp/${folder}`,
      resource_type: isImage ? 'image' : 'raw',
      public_id: (String(file.mimetype || '').startsWith('image/') ? (file.originalname ? file.originalname.replace(/\.[^.]+$/, '') : undefined) : (file.originalname || 'document')),
      use_filename: true,
      unique_filename: true
    },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url)
      }
    )
    .end(file.buffer)
})

const LESSON_ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/jpg',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
];

// Separate Multer config for lessons/homework: same memory storage, larger 10MB limit.
const lessonUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (LESSON_ALLOWED_TYPES.includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(
      new Error(
        'Only images, PDFs, Word, PowerPoint, Excel, and text files are allowed'
      )
    );
  },
});


const LESSON_ALLOWED_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg',
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt', '.csv'
];

const uploadLessonFiles = lessonUpload.fields([
  { name: 'materials', maxCount: 10 },
  { name: 'files', maxCount: 10 },
]);
/**
 * Uploads an array of Multer files to Cloudinary in parallel.
 *
 * Used by lesson & homework controllers because those routes use .array(),
 * so req.files is [file, file, ...] instead of { fieldName: [file] }.
 *
 * @param {Array} files - Array from req.files after handleLessonUpload
 * @param {string} folder - Cloudinary subfolder (e.g. 'lessons', 'homeworks')
 * @returns {Promise<string[]>} Array of secure URLs
 */
const uploadFileList = async (files = [], folder = 'lessons') => {
  let list = [];
  if (Array.isArray(files)) {
    list = files;
  } else if (files && typeof files === 'object') {
    list = [
      ...(files.materials || []),
      ...(files.files || []),
      ...Object.values(files).flat(),
    ];
  }
  const uniqueFiles = [...new Set(list.filter(Boolean))];
  return Promise.all(uniqueFiles.map((file) => uploadToCloudinary(file, folder)));
};

const uploadClassFiles = upload.fields([
  { name: 'coverImage', maxCount: 1 }
])


const uploadStudentFiles = upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'idFront', maxCount: 1 },
  { name: 'idBack', maxCount: 1 },
  { name: 'guardianPhoto', maxCount: 1 },
  { name: 'guardianIdFront', maxCount: 1 },
  { name: 'guardianIdBack', maxCount: 1 },
]);

const uploadCourseFiles = upload.fields([
  { name: 'coverImage', maxCount: 1 },
  { name: 'image', maxCount: 1 },
  { name: 'photo', maxCount: 1 },
  { name: 'courseImage', maxCount: 1 },
]);


const uploadGuardianFiles = upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'idFront', maxCount: 1 },
  { name: 'idBack', maxCount: 1 },
]);

/**
 * Multer field map for complaint photo evidence (user complaint
 */
const uploadComplaintFiles = upload.fields([
  { name: 'photoEvidence', maxCount: 1 },
]);



const uploadFiles = async (files = {}, folder = 'teachers') => {
  const uploaded = {};

  // Flat-map every field's file list into parallel upload tasks
  const tasks = Object.entries(files).flatMap(([field, fileList]) =>
    (fileList || []).map(async (file) => {
      uploaded[field] = await uploadToCloudinary(file, folder);
    })
  );

  await Promise.all(tasks);
  return uploaded;
};

const getCloudinaryMeta = (url) => {
  if (!url || typeof url !== 'string') {
    return null;
  }
  // PDFs/docs were uploaded as "raw"; images as "image"
  const resourceType = url.includes('/raw/upload/') ? 'raw' : 'image';
  const afterUpload = url.split('/upload/').pop();

  if (!afterUpload) return null;

  // Strip version segment (v123456/) then drop the file extension for public_id
  const path = afterUpload.replace(/^v\d+\//, '');
  const dotIndex = path.lastIndexOf('.');
  const publicId = dotIndex > -1 ? path.slice(0, dotIndex) : path;

  return { publicId, resourceType };
};

const deleteFromCloudinary = async (url) => {
  const meta = getCloudinaryMeta(url);
  if (!meta) return;

  return new Promise((resolve, reject) => {
    cloudinary.uploader.destroy(meta.publicId, { type: 'upload', resource_type: meta.resourceType }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
};

const deleteFromCloudinaryMany = async (urls = []) => {
  const unique = [...new Set(urls.filter(Boolean))];
  await Promise.all(unique.map(deleteFromCloudinary));
};


const handleTeacherUpload = (req, res, next) => {
  uploadTeacherFiles(req, res, (error) => {
    if (error) {
      return res.status(400).json({
        message: error.message || 'File upload failed',
      });
    }
    next();
  });
};


const handleClassUpload = (req, res, next) => {
  uploadClassFiles(req, res, (error) => {
    if (error) {
      return res.status(400).json({
        message: error.message || 'File upload failed',
      });
    }
    next();
  });
};

const handleCourseUpload = (req, res, next) => {
  uploadCourseFiles(req, res, (error) => {
    if (error) {
      return res.status(400).json({
        message: error.message || 'File upload failed',
      });
    }
    next();
  });
};

const handleStudentUpload = (req, res, next) => {
  uploadStudentFiles(req, res, (error) => {
    if (error) {
      return res.status(400).json({
        message: error.message || 'File upload failed',
      });
    }
    next();
  });
};
const handleGuardianUpload = (req, res, next) => {
  uploadGuardianFiles(req, res, (error) => {
    if (error) {
      return res.status(400).json({
        message: error.message || 'File upload failed',
      });
    }
    next();
  });
};

const handleComplaintUpload = (req, res, next) => {
  uploadComplaintFiles(req, res, (error) => {
    if (error) {
      return res.status(400).json({
        message: error.message || 'File upload failed',
      });
    }
    next();
  });
};

const handleLessonUpload = (req, res, next) => {
  uploadLessonFiles(req, res, (error) => {
    if (error) {
      return res.status(400).json({
        message: error.message || 'File upload failed',
      });
    }
    if (req.files && !Array.isArray(req.files)) {
      const flattened = [
        ...(req.files.materials || []),
        ...(req.files.files || []),
        ...Object.values(req.files).flat(),
      ];
      req.files = [...new Set(flattened.filter(Boolean))];
    }
    next();
  });
};

const handleHomeworkUpload = handleLessonUpload;

const uploadAnnouncementFiles = lessonUpload.fields([
  { name: 'attachments', maxCount: 10 },
  { name: 'files', maxCount: 10 },
  { name: 'materials', maxCount: 10 },
]);

const handleAnnouncementUpload = (req, res, next) => {
  uploadAnnouncementFiles(req, res, (error) => {
    if (error) {
      return res.status(400).json({
        message: error.message || 'File upload failed',
      });
    }
    if (req.files && !Array.isArray(req.files)) {
      const flattened = [
        ...(req.files.attachments || []),
        ...(req.files.files || []),
        ...(req.files.materials || []),
        ...Object.values(req.files).flat(),
      ];
      req.files = [...new Set(flattened.filter(Boolean))];
    }
    next();
  });
};

// Image-only MIME types for admin profile photo updates.
const IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/jpg',
];

// Multer config that only allows images (no PDFs) for user/admin profile
const imageUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (IMAGE_TYPES.includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
  },
});

const uploadUserPhoto = imageUpload.fields([{ name: 'photo', maxCount: 1 }]);

/**
 * Express middleware for PATCH /admin/me/photo.
 * Admin controller then uploads via uploadFiles(req.files, 'admins') and
 * deletes the previous photo with deleteFromCloudinaryMany.
 */
const handleUserPhotoUpload = (req, res, next) => {
  uploadUserPhoto(req, res, (error) => {
    if (error) {
      return res.status(400).json({
        message: error.message || 'File upload failed',
      });
    }
    next();
  });
};


export {
  handleCourseUpload,
  handleTeacherUpload,
  handleClassUpload,
  handleStudentUpload,
  handleGuardianUpload,
  handleComplaintUpload,
  handleLessonUpload,
  handleHomeworkUpload,
  handleAnnouncementUpload,
  handleUserPhotoUpload,
  uploadFiles,
  uploadFileList,
  deleteFromCloudinaryMany,
};