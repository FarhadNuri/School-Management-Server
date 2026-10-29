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