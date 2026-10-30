import express from "express";
import cors from "cors"
import ENV from "./config/env.js";
import connectDB from "./config/database.js";
import {notFound, errorHandler} from "./middleware/error.middleware.js"
import userRoutes from "./routes/user.route.js"
import adminRoutes from "./routes/admin.route.js"
import teacherRoutes from "./routes/teacher.route.js"
import seedAdmin from "./config/seedAmin.js";
import { mountWebhooks } from "./webhooks/index.js";
import mailer from "./utils/Mailer.js";

const app = express()

const allowedOrigins = [
    ENV.FRONTEND_URL,
    ENV.ADMIN_URL,
    "http://localhost:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
].filter(Boolean).map(url => url.replace(/\/$/, ""));

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl) or if in allowed list
        if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ""))) {
            callback(null, true);
        } else {
            callback(new Error(`CORS blocked for origin: ${origin}`));
        }
    },
    credentials: true
}))

// Mount inbound webhook routes before express.json() for raw body verification
mountWebhooks(app);

app.use(express.json())
app.use(express.static('public'))

app.use('/api/health',(req, res) => {
    res.status(200).json({
        message: "API is Running",
        version: "1.0.0",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        status: "OK"
    })
})



app.all('/api/test-email', async (req, res) => {
    try {
        const to = req.body?.to || req.query?.to || 'farhadnuri559@gmail.com';
        const resendKeyConfigured = Boolean(process.env.RESEND_API_KEY);
        const resendKeyMasked = process.env.RESEND_API_KEY
            ? process.env.RESEND_API_KEY.slice(0, 5) + '...' + process.env.RESEND_API_KEY.slice(-4)
            : 'NOT_SET';
        const resendFrom = process.env.RESEND_FROM || 'onboarding@resend.dev';

        console.log(`🧪 Testing email send to ${to} (RESEND_API_KEY: ${resendKeyMasked}, FROM: ${resendFrom})`);
        const result = await mailer.sendEmail({
            to,
            subject: 'School Management Email Delivery Test',
            text: 'This is a test email verifying that Resend / email delivery is working on your production host.',
            html: '<h3>School Management Email Test</h3><p>This is a test email verifying that your email configuration is working on Render.</p>',
        });

        res.status(200).json({
            success: true,
            message: 'Email delivered successfully',
            resendKeyConfigured,
            resendKeyMasked,
            resendFrom,
            result,
        });
    } catch (error) {
        console.error('Test email failed:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            resendKeyConfigured: Boolean(process.env.RESEND_API_KEY),
            resendKeyMasked: process.env.RESEND_API_KEY
                ? process.env.RESEND_API_KEY.slice(0, 5) + '...' + process.env.RESEND_API_KEY.slice(-4)
                : 'NOT_SET',
            resendFrom: process.env.RESEND_FROM || 'onboarding@resend.dev',
        });
    }
});

app.use('/api/admin',adminRoutes)
app.use('/api/user',userRoutes)
app.use('/api/teacher',teacherRoutes)




app.use(notFound)
app.use(errorHandler)

const startDB = async () => {
    try {
        const conn = await connectDB()
        if(conn.readyState === 1) {
            console.log("😊 Database Connected Successfully")
            await seedAdmin()
            app.listen(ENV.PORT, () => {
                console.log(`😊 Server Running On Port ${ENV.PORT}`)
            })
        } else {
            console.log("😭 Database Connection Failed")
        }
        
        return conn;
    } catch(error) {
        console.log("Fail To Start The Server")
        process.exit(1)
    }
}

startDB()