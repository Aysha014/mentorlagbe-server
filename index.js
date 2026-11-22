
import express from "express";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import cors from "cors";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();
const port = process.env.PORT || 8000;

// Better Auth JWT verification
const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL?.replace(/\/$/, "");

if (!BETTER_AUTH_URL) {
    throw new Error("BETTER_AUTH_URL is missing.");
}

const JWKS = createRemoteJWKSet(
    new URL(`${BETTER_AUTH_URL}/api/auth/jwks`)
);

// CORS
const allowedOrigins = [
  "http://localhost:3000",
  "https://mentorlagbe-client-sandy.vercel.app",
];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

app.use(express.json());

// MongoDB connection
const uri = process.env.MONGODB_URI;

if (!uri && (!process.env.DB_USER || !process.env.DB_PASSWORD)) {
    throw new Error("MongoDB environment variables are missing.");
}

const connectionString =
    uri ||
    `mongodb+srv://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(process.env.DB_PASSWORD)}@ac-bysscth.rbebje6.mongodb.net/?retryWrites=true&w=majority`;

const client = new MongoClient(connectionString);

let db;
let dbPromise;

async function connectToMongoDB() {
    if (!dbPromise) {
        dbPromise = client
            .connect()
            .then(() => {
                console.log("Connected to MongoDB");
                db = client.db("mentorlagbe");
                return db;
            })
            .catch((error) => {
                dbPromise = null;
                console.error("MongoDB connection error:", error.message);
                throw error;
            });
    }

    return dbPromise;
}

// Root route
app.get("/", (req, res) => {
    res.send("MentorLagbe API is running!");
});

// Database middleware
app.use(async (req, res, next) => {
    try {
        await connectToMongoDB();
        next();
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Database connection failed.",
        });
    }
});

// Exactly four collections
const users = () => db.collection("users");
const tuitions = () => db.collection("tuitions");
const applications = () => db.collection("applications");
const payments = () => db.collection("payments");

// Authentication middleware
async function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
        return res.status(401).json({
            success: false,
            message: "Authentication token is required.",
        });
    }

    try {
        const token = authHeader.slice(7);

        const { payload } = await jwtVerify(token, JWKS, {
            issuer: BETTER_AUTH_URL,
            audience: BETTER_AUTH_URL,
        });

        if (!payload.sub || !payload.email) {
            return res.status(401).json({
                success: false,
                message: "Invalid user information.",
            });
        }

        const user = await users().findOne({
            $or: [
                { _id: payload.sub },
                { email: payload.email },
            ],
        });

        if (!user) {
            return res.status(401).json({
                success: false,
                message: "User account not found.",
            });
        }

        req.user = {
            id: payload.sub,
            email: payload.email,
            name: user.name || user.fullName || "Tutor",
            role: user.role,
        };

        next();
    } catch (error) {
        console.error("JWT verification failed:", error.message);

        return res.status(401).json({
            success: false,
            message: "Invalid or expired token.",
        });
    }
}

// Role middleware
function verifyStudent(req, res, next) {
    if (req.user?.role !== "student") {
        return res.status(403).json({
            success: false,
            message: "Student access only.",
        });
    }

    next();
}

function verifyTutor(req, res, next) {
    if (req.user?.role !== "tutor") {
        return res.status(403).json({
            success: false,
            message: "Tutor access only.",
        });
    }

    next();
}

function verifyAdmin(req, res, next) {
    if (req.user?.role !== "admin") {
        return res.status(403).json({
            success: false,
            message: "Admin access only.",
        });
    }

    next();
}

// Health check
app.get("/health", async (req, res) => {
    try {
        await db.command({ ping: 1 });

        res.status(200).json({
            success: true,
            message: "Server and database are healthy.",
        });
    } catch (error) {
        console.error("Health check error:", error.message);

        res.status(500).json({
            success: false,
            message: "Database connection failed.",
        });
    }
});

// Public tuition filter
const publicTuitionFilter = {
    approvalStatus: "approved",
    status: "active",
};

// Escape search text
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// API 1: Get approved and active tuitions
app.get("/tuitions", async (req, res) => {
    try {
        const {
            search = "",
            subject = "",
            classLevel = "",
            mode = "",
        } = req.query;

        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const requestedLimit = parseInt(req.query.limit, 10) || 9;
        const limit = Math.min(24, Math.max(1, requestedLimit));

        const filter = { ...publicTuitionFilter };

        if (typeof search === "string" && search.trim()) {
            const searchRegex = new RegExp(
                escapeRegex(search.trim()),
                "i"
            );

            filter.$or = [
                { title: searchRegex },
                { subject: searchRegex },
            ];
        }

        if (typeof subject === "string" && subject.trim()) {
            filter.subject = subject.trim();
        }

        if (typeof classLevel === "string" && classLevel.trim()) {
            filter.classLevel = classLevel.trim();
        }

        if (typeof mode === "string" && mode.trim()) {
            filter.mode = mode.trim();
        }

        const total = await tuitions().countDocuments(filter);
        const totalPages = Math.ceil(total / limit);

        const results = await tuitions()
            .find(filter)
            .sort({ createdAt: -1, _id: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray();

        res.status(200).json({
            success: true,
            data: results.map((tuition) => ({
                ...tuition,
                id: tuition._id.toString(),
            })),
            pagination: {
                total,
                page,
                limit,
                totalPages,
                hasNextPage: page < totalPages,
                hasPreviousPage: page > 1,
            },
        });
    } catch (error) {
        console.error("Error fetching tuitions:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch tuitions.",
        });
    }
});

// API 2: Get single tuition
app.get("/tuitions/:id", async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid tuition ID.",
            });
        }

        const tuition = await tuitions().findOne({
            _id: new ObjectId(id),
            ...publicTuitionFilter,
        });

        if (!tuition) {
            return res.status(404).json({
                success: false,
                message: "Tuition not found or unavailable.",
            });
        }

        res.status(200).json({
            success: true,
            data: {
                ...tuition,
                id: tuition._id.toString(),
            },
        });
    } catch (error) {
        console.error("Error fetching tuition:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch tuition details.",
        });
    }
});



// API: Create a tuition (Tutors only)
app.post("/tuitions", verifyToken, verifyTutor, async (req, res) => {
    try {
        const {
            title,
            subject,
            classLevel,
            mode,
            location,
            salary,
            daysPerWeek,
            description,
            schedule,
            bannerImage,
        } = req.body;

        if (
            typeof title !== "string" || !title.trim() ||
            typeof subject !== "string" || !subject.trim() ||
            typeof classLevel !== "string" || !classLevel.trim() ||
            typeof mode !== "string" || !mode.trim() ||
            !Number.isFinite(Number(salary)) || Number(salary) <= 0 ||
            !Number.isInteger(Number(daysPerWeek)) ||
            Number(daysPerWeek) < 1 || Number(daysPerWeek) > 7
        ) {
            return res.status(400).json({
                success: false,
                message: "Please provide valid tuition information.",
            });
        }

        const tutor = await users().findOne({
            email: req.user.email,
        });

        const plan = String(
            tutor?.plan || tutor?.subscriptionPlan || "free"
        ).toLowerCase();

        const isPro = plan === "pro";

        if (!isPro) {
            const existingPosts = await tuitions().countDocuments({
                tutorId: req.user.id,
            });

            if (existingPosts >= 2) {
                return res.status(403).json({
                    success: false,
                    message: "Free Plan allows a maximum of 2 tuition posts. Upgrade to Pro for unlimited posts.",
                    code: "FREE_PLAN_LIMIT",
                });
            }
        }

        const tuition = {
            title: title.trim(),
            subject: subject.trim(),
            classLevel: classLevel.trim(),
            mode: mode.trim(),
            location: typeof location === "string" ? location.trim() : "",
            salary: Number(salary),
            daysPerWeek: Number(daysPerWeek),
            description: typeof description === "string" ? description.trim() : "",
            schedule: typeof schedule === "string" ? schedule.trim() : "",
            bannerImage: typeof bannerImage === "string" ? bannerImage : "",
            tutorId: req.user.id,
            tutorName: req.user.name,
            tutorEmail: req.user.email,
            approvalStatus: "pending",
            status: "active",
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        const result = await tuitions().insertOne(tuition);

        res.status(201).json({
            success: true,
            message: "Tuition posted successfully. Awaiting admin approval.",
            data: {
                ...tuition,
                id: result.insertedId.toString(),
            },
        });
    } catch (error) {
        console.error("Error creating tuition:", error);

        res.status(500).json({
            success: false,
            message: "Failed to create tuition.",
        });
    }
});


// ==========================================
// TUTOR DASHBOARD APIs
// ==========================================

// API: Tutor dashboard overview
app.get("/tutor/dashboard", verifyToken, verifyTutor, async (req, res) => {
    try {
        const tutorTuitions = await tuitions()
            .find({ tutorId: req.user.id })
            .toArray();

        const tuitionIds = tutorTuitions.map((item) =>
            item._id.toString()
        );

        const totalApplicants = tuitionIds.length
            ? await applications().countDocuments({
                tuitionId: { $in: tuitionIds },
            })
            : 0;

        const tutor = await users().findOne(
            { email: req.user.email },
            { projection: { plan: 1, subscriptionPlan: 1 } }
        );

        const plan = String(
            tutor?.plan || tutor?.subscriptionPlan || "free"
        ).toLowerCase();

        res.json({
            success: true,
            data: {
                totalTuitions: tutorTuitions.length,
                activeTuitions: tutorTuitions.filter(
                    (item) =>
                        item.status === "active" &&
                        item.approvalStatus === "approved"
                ).length,
                totalApplicants,
                currentPlan: plan === "pro" ? "Pro" : "Free",
            },
        });
    } catch (error) {
        console.error("Tutor dashboard error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch tutor dashboard.",
        });
    }
});


// API: Get tutor's own tuition posts
app.get("/tutor/tuitions", verifyToken, verifyTutor, async (req, res) => {
    try {
        const results = await tuitions()
            .find({ tutorId: req.user.id })
            .sort({ createdAt: -1 })
            .toArray();

        res.json({
            success: true,
            data: results.map((item) => ({
                ...item,
                id: item._id.toString(),
            })),
        });
    } catch (error) {
        console.error("Get tutor tuitions error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch your tuitions.",
        });
    }
});


// API: Update tuition details
app.patch("/tutor/tuitions/:id", verifyToken, verifyTutor, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid tuition ID.",
            });
        }

        const existing = await tuitions().findOne({
            _id: new ObjectId(id),
            tutorId: req.user.id,
        });

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Tuition not found.",
            });
        }

        const allowedFields = [
            "title",
            "subject",
            "classLevel",
            "mode",
            "location",
            "salary",
            "daysPerWeek",
            "description",
            "schedule",
            "bannerImage",
        ];

        const updates = {};

        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                updates[field] = req.body[field];
            }
        }

        if (!Object.keys(updates).length) {
            return res.status(400).json({
                success: false,
                message: "No valid fields provided.",
            });
        }

        for (const field of ["title", "subject", "classLevel", "mode"]) {
            if (
                updates[field] !== undefined &&
                (typeof updates[field] !== "string" ||
                    !updates[field].trim())
            ) {
                return res.status(400).json({
                    success: false,
                    message: `${field} is required.`,
                });
            }

            if (typeof updates[field] === "string") {
                updates[field] = updates[field].trim();
            }
        }

        if (updates.salary !== undefined) {
            updates.salary = Number(updates.salary);

            if (!Number.isFinite(updates.salary) || updates.salary <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Monthly fee must be greater than zero.",
                });
            }
        }

        if (updates.daysPerWeek !== undefined) {
            updates.daysPerWeek = Number(updates.daysPerWeek);

            if (
                !Number.isInteger(updates.daysPerWeek) ||
                updates.daysPerWeek < 1 ||
                updates.daysPerWeek > 7
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Days per week must be between 1 and 7.",
                });
            }
        }

        if (
            updates.bannerImage !== undefined &&
            typeof updates.bannerImage !== "string"
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid banner image.",
            });
        }

        // Re-approval is required after editing tuition details.
        if (existing.approvalStatus === "approved") {
            updates.approvalStatus = "pending";
        }

        updates.updatedAt = new Date();

        await tuitions().updateOne(
            {
                _id: new ObjectId(id),
                tutorId: req.user.id,
            },
            { $set: updates }
        );

        res.json({
            success: true,
            message: "Tuition updated successfully.",
        });
    } catch (error) {
        console.error("Update tuition error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to update tuition.",
        });
    }
});


// API: Toggle tuition status (Active / Closed)
app.patch(
    "/tutor/tuitions/:id/status",
    verifyToken,
    verifyTutor,
    async (req, res) => {
        try {
            const { id } = req.params;
            const { status } = req.body;

            if (!ObjectId.isValid(id)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid tuition ID.",
                });
            }

            if (!["active", "closed"].includes(status)) {
                return res.status(400).json({
                    success: false,
                    message: "Status must be active or closed.",
                });
            }

            const result = await tuitions().updateOne(
                {
                    _id: new ObjectId(id),
                    tutorId: req.user.id,
                },
                {
                    $set: {
                        status,
                        updatedAt: new Date(),
                    },
                }
            );

            if (!result.matchedCount) {
                return res.status(404).json({
                    success: false,
                    message: "Tuition not found.",
                });
            }

            res.json({
                success: true,
                message: `Tuition ${status} successfully.`,
            });
        } catch (error) {
            console.error("Toggle tuition status error:", error);
            res.status(500).json({
                success: false,
                message: "Failed to update tuition status.",
            });
        }
    }
);


// API: Delete tuition post
app.delete("/tutor/tuitions/:id", verifyToken, verifyTutor, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid tuition ID.",
            });
        }

        const tuitionId = id;

        const result = await tuitions().deleteOne({
            _id: new ObjectId(id),
            tutorId: req.user.id,
        });

        if (!result.deletedCount) {
            return res.status(404).json({
                success: false,
                message: "Tuition not found.",
            });
        }

        await applications().deleteMany({ tuitionId });

        res.json({
            success: true,
            message: "Tuition and related applications deleted.",
        });
    } catch (error) {
        console.error("Delete tuition error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to delete tuition.",
        });
    }
});


// API: Get applicants for tutor's tuition posts
app.get("/tutor/applicants", verifyToken, verifyTutor, async (req, res) => {
    try {
        const tutorTuitions = await tuitions()
            .find({ tutorId: req.user.id })
            .toArray();

        const tuitionMap = new Map(
            tutorTuitions.map((item) => [
                item._id.toString(),
                item,
            ])
        );

        const tuitionIds = [...tuitionMap.keys()];

        if (!tuitionIds.length) {
            return res.json({
                success: true,
                data: [],
            });
        }

        const results = await applications()
            .find({ tuitionId: { $in: tuitionIds } })
            .sort({ createdAt: -1 })
            .toArray();

        const data = await Promise.all(
            results.map(async (application) => {
                const student = await users().findOne(
                    { email: application.studentEmail },
                    {
                        projection: {
                            name: 1,
                            fullName: 1,
                            email: 1,
                        },
                    }
                );

                const tuition = tuitionMap.get(application.tuitionId);

                return {
                    id: application._id.toString(),
                    tuitionId: application.tuitionId,
                    tuitionTitle: tuition?.title || "Tuition",
                    studentName:
                        student?.name ||
                        student?.fullName ||
                        "Student",
                    studentEmail:
                        student?.email ||
                        application.studentEmail ||
                        "",
                    phone: application.phone || "",
                    preferredSchedule:
                        application.preferredSchedule || "",
                    learningNote: application.learningNote || "",
                    status: application.status,
                    createdAt: application.createdAt,
                };
            })
        );

        res.json({
            success: true,
            data,
        });
    } catch (error) {
        console.error("Tutor applicants error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch applicants.",
        });
    }
});


// API: Accept or reject an applicant
app.patch(
    "/tutor/applications/:id/status",
    verifyToken,
    verifyTutor,
    async (req, res) => {
        try {
            const { id } = req.params;
            const { status } = req.body;

            if (!ObjectId.isValid(id)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid application ID.",
                });
            }

            if (!["accepted", "rejected"].includes(status)) {
                return res.status(400).json({
                    success: false,
                    message: "Status must be accepted or rejected.",
                });
            }

            const application = await applications().findOne({
                _id: new ObjectId(id),
            });

            if (!application) {
                return res.status(404).json({
                    success: false,
                    message: "Application not found.",
                });
            }

            const tuition = await tuitions().findOne({
                _id: ObjectId.isValid(application.tuitionId)
                    ? new ObjectId(application.tuitionId)
                    : null,
                tutorId: req.user.id,
            });

            if (!tuition) {
                return res.status(403).json({
                    success: false,
                    message: "You cannot manage this application.",
                });
            }

            if (application.status !== "pending") {
                return res.status(409).json({
                    success: false,
                    message: "Only pending applications can be updated.",
                });
            }

            await applications().updateOne(
                {
                    _id: new ObjectId(id),
                    status: "pending",
                },
                {
                    $set: {
                        status,
                        updatedAt: new Date(),
                    },
                }
            );

            res.json({
                success: true,
                message: `Application ${status} successfully.`,
            });
        } catch (error) {
            console.error("Update applicant status error:", error);
            res.status(500).json({
                success: false,
                message: "Failed to update application status.",
            });
        }
    }
);



// API 3: Apply for a tuition (Students only)
app.post("/applications", verifyToken, verifyStudent, async (req, res) => {
    try {
        const {
            tuitionId,
            phone,
            preferredSchedule,
            learningNote = "",
        } = req.body;

        if (
            !tuitionId ||
            !phone?.trim() ||
            !preferredSchedule?.trim()
        ) {
            return res.status(400).json({
                success: false,
                message: "Tuition, phone, and preferred schedule are required.",
            });
        }

        if (!ObjectId.isValid(tuitionId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid tuition ID.",
            });
        }

        const tuition = await tuitions().findOne({
            _id: new ObjectId(tuitionId),
            ...publicTuitionFilter,
        });

        if (!tuition) {
            return res.status(404).json({
                success: false,
                message: "Tuition not found or unavailable.",
            });
        }

        await applications().createIndex(
            { tuitionId: 1, studentId: 1 },
            { unique: true }
        );

        const existingApplication = await applications().findOne({
            tuitionId,
            studentId: req.user.id,
        });

        if (existingApplication) {
            return res.status(409).json({
                success: false,
                message: "You have already applied for this tuition.",
            });
        }

        const application = {
            tuitionId,
            studentId: req.user.id,
            studentEmail: req.user.email,
            phone: phone.trim(),
            preferredSchedule: preferredSchedule.trim(),
            learningNote: learningNote.trim(),
            status: "pending",
            createdAt: new Date(),
        };

        const result = await applications().insertOne(application);

        res.status(201).json({
            success: true,
            message: "Your application has been submitted successfully.",
            data: {
                id: result.insertedId.toString(),
                ...application,
            },
        });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({
                success: false,
                message: "You have already applied for this tuition.",
            });
        }

        console.error("Error submitting application:", error);

        res.status(500).json({
            success: false,
            message: "Failed to submit application.",
        });
    }
});

// API 4: Student dashboard overview
app.get("/student/dashboard", verifyToken, verifyStudent, async (req, res) => {
    try {
        const student = await users().findOne(
            { email: req.user.email },
            {
                projection: {
                    plan: 1,
                    subscriptionPlan: 1,
                },
            }
        );

        const studentApplications = await applications()
            .find({ studentId: req.user.id })
            .toArray();

        const activeApplications = studentApplications.filter(
            (application) => application.status !== "cancelled"
        );

        const plan = String(
            student?.plan ||
            student?.subscriptionPlan ||
            "free"
        ).toLowerCase();

        res.status(200).json({
            success: true,
            data: {
                totalAppliedTuitions: activeApplications.length,
                acceptedApplications: activeApplications.filter(
                    (application) => application.status === "accepted"
                ).length,
                pendingApplications: activeApplications.filter(
                    (application) => application.status === "pending"
                ).length,
                currentPlan: plan === "pro" ? "Pro" : "Free",
            },
        });
    } catch (error) {
        console.error("Error fetching student dashboard:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch student dashboard.",
        });
    }
});

// API 5: Get student's applications with tuition and tutor details
app.get("/student/applications", verifyToken, verifyStudent, async (req, res) => {
    try {
        const results = await applications()
            .aggregate([
                {
                    $match: {
                        studentId: req.user.id,
                    },
                },
                {
                    $addFields: {
                        tuitionObjectId: {
                            $convert: {
                                input: "$tuitionId",
                                to: "objectId",
                                onError: null,
                                onNull: null,
                            },
                        },
                    },
                },
                {
                    $lookup: {
                        from: "tuitions",
                        localField: "tuitionObjectId",
                        foreignField: "_id",
                        as: "tuition",
                    },
                },
                {
                    $unwind: {
                        path: "$tuition",
                        preserveNullAndEmptyArrays: true,
                    },
                },
                {
                    $sort: {
                        createdAt: -1,
                    },
                },
                {
                    $project: {
                        _id: 0,
                        id: { $toString: "$_id" },
                        tuitionId: 1,
                        status: 1,
                        createdAt: 1,
                        preferredSchedule: 1,
                        tuition: {
                            id: { $toString: "$tuition._id" },
                            title: "$tuition.title",
                            monthlyFee: {
                                $ifNull: [
                                    "$tuition.monthlyFee",
                                    "$tuition.salary",
                                ],
                            },
                            tutorId: "$tuition.tutorId",
                            tutorEmail: "$tuition.tutorEmail",
                            tutorName: "$tuition.tutorName",
                        },
                    },
                },
            ])
            .toArray();

        const enrichedResults = await Promise.all(
            results.map(async (application) => {
                const tuition = application.tuition || {};
                let tutor = null;

                const tutorQuery = [];

                if (tuition.tutorEmail) {
                    tutorQuery.push({
                        email: tuition.tutorEmail,
                    });
                }

                if (tuition.tutorId) {
                    tutorQuery.push({
                        _id: tuition.tutorId,
                    });

                    if (ObjectId.isValid(String(tuition.tutorId))) {
                        tutorQuery.push({
                            _id: new ObjectId(String(tuition.tutorId)),
                        });
                    }
                }

                if (tutorQuery.length > 0) {
                    tutor = await users().findOne(
                        { $or: tutorQuery },
                        {
                            projection: {
                                name: 1,
                                fullName: 1,
                                email: 1,
                            },
                        }
                    );
                }

                return {
                    ...application,
                    tuition: {
                        ...tuition,
                        tutorName:
                            tutor?.name ||
                            tutor?.fullName ||
                            tuition.tutorName ||
                            "Tutor",
                        tutorEmail:
                            tutor?.email ||
                            tuition.tutorEmail ||
                            "",
                    },
                };
            })
        );

        res.status(200).json({
            success: true,
            data: enrichedResults,
        });
    } catch (error) {
        console.error("Error fetching student applications:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch student applications.",
        });
    }
});

// API 6: Cancel a pending student application
app.patch(
    "/student/applications/:id/cancel",
    verifyToken,
    verifyStudent,
    async (req, res) => {
        try {
            const { id } = req.params;

            if (!ObjectId.isValid(id)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid application ID.",
                });
            }

            const result = await applications().updateOne(
                {
                    _id: new ObjectId(id),
                    studentId: req.user.id,
                    status: "pending",
                },
                {
                    $set: {
                        status: "cancelled",
                        updatedAt: new Date(),
                    },
                }
            );

            if (result.matchedCount === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Pending application not found.",
                });
            }

            res.status(200).json({
                success: true,
                message: "Application cancelled successfully.",
            });
        } catch (error) {
            console.error("Error cancelling application:", error);

            res.status(500).json({
                success: false,
                message: "Failed to cancel application.",
            });
        }
    }
);

// ==========================================
// ADMIN DASHBOARD APIs
// ==========================================

// API 1: Admin dashboard statistics
app.get("/admin/dashboard", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const [
            totalUsers,
            totalTutors,
            pendingTuitions,
            approvedTuitions,
            totalRevenue,
        ] = await Promise.all([
            users().countDocuments(),
            users().countDocuments({ role: "tutor" }),
            tuitions().countDocuments({ approvalStatus: "pending" }),
            tuitions().countDocuments({ approvalStatus: "approved" }),
            payments().aggregate([
                {
                    $group: {
                        _id: null,
                        total: {
                            $sum: {
                                $convert: {
                                    input: { $ifNull: ["$amount", 0] },
                                    to: "double",
                                    onError: 0,
                                    onNull: 0,
                                },
                            },
                        },
                    },
                },
            ]).toArray(),
        ]);

        res.json({
            success: true,
            data: {
                totalUsers,
                totalTutors,
                pendingTuitions,
                approvedTuitions,
                totalRevenue: totalRevenue[0]?.total || 0,
            },
        });
    } catch (error) {
        console.error("Admin dashboard error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch admin dashboard.",
        });
    }
});


// API 2: Get all registered users
app.get("/admin/users", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const results = await users()
            .find(
                {},
                {
                    projection: {
                        name: 1,
                        fullName: 1,
                        email: 1,
                        role: 1,
                        plan: 1,
                        createdAt: 1,
                    },
                }
            )
            .sort({ createdAt: -1 })
            .toArray();

        res.json({
            success: true,
            data: results.map((user) => ({
                id: user._id.toString(),
                name: user.name || user.fullName || "User",
                email: user.email || "",
                role: user.role || "student",
                plan: user.plan || "free",
                createdAt: user.createdAt || null,
            })),
        });
    } catch (error) {
        console.error("Admin users error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch users.",
        });
    }
});


// API 3: Update a user's role
app.patch("/admin/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { role } = req.body;

        if (!["student", "tutor", "admin"].includes(role)) {
            return res.status(400).json({
                success: false,
                message: "Invalid user role.",
            });
        }

        if (id === req.user.id) {
            return res.status(400).json({
                success: false,
                message: "You cannot change your own admin role.",
            });
        }

        const userQuery = [{ _id: id }];

        if (ObjectId.isValid(id)) {
            userQuery.push({ _id: new ObjectId(id) });
        }

        const result = await users().updateOne(
            { $or: userQuery },
            {
                $set: {
                    role,
                    updatedAt: new Date(),
                },
            }
        );

        if (!result.matchedCount) {
            return res.status(404).json({
                success: false,
                message: "User not found.",
            });
        }

        res.json({
            success: true,
            message: "User role updated successfully.",
        });
    } catch (error) {
        console.error("Update user role error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to update user role.",
        });
    }
});


// API 4: Get all tuition posts for admin
app.get("/admin/tuitions", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const results = await tuitions()
            .find({})
            .sort({ createdAt: -1 })
            .toArray();

        res.json({
            success: true,
            data: results.map((tuition) => ({
                ...tuition,
                id: tuition._id.toString(),
            })),
        });
    } catch (error) {
        console.error("Admin tuitions error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch tuition posts.",
        });
    }
});


// API 5: Approve or reject a tuition
app.patch(
    "/admin/tuitions/:id/approval",
    verifyToken,
    verifyAdmin,
    async (req, res) => {
        try {
            const { id } = req.params;
            const { approvalStatus } = req.body;

            if (!ObjectId.isValid(id)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid tuition ID.",
                });
            }

            if (!["approved", "rejected"].includes(approvalStatus)) {
                return res.status(400).json({
                    success: false,
                    message: "Approval status must be approved or rejected.",
                });
            }

            const result = await tuitions().updateOne(
                { _id: new ObjectId(id) },
                {
                    $set: {
                        approvalStatus,
                        updatedAt: new Date(),
                    },
                }
            );

            if (!result.matchedCount) {
                return res.status(404).json({
                    success: false,
                    message: "Tuition not found.",
                });
            }

            res.json({
                success: true,
                message: `Tuition ${approvalStatus} successfully.`,
            });
        } catch (error) {
            console.error("Tuition approval error:", error);
            res.status(500).json({
                success: false,
                message: "Failed to update tuition approval.",
            });
        }
    }
);


// API 6: Get Stripe transaction records
app.get("/admin/transactions", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const results = await payments()
            .find({})
            .sort({ createdAt: -1 })
            .toArray();

        res.json({
            success: true,
            data: results.map((payment) => ({
                id: payment._id.toString(),
                userName: payment.userName || payment.name || "User",
                email: payment.email || payment.userEmail || "",
                role: payment.role || "",
                planName: payment.planName || payment.plan || "",
                amount: Number(payment.amount) || 0,
                transactionId:
                    payment.transactionId ||
                    payment.paymentIntentId ||
                    payment.sessionId ||
                    "",
                paymentDate: payment.createdAt || payment.paymentDate || null,
                status: payment.status || "",
            })),
        });
    } catch (error) {
        console.error("Admin transactions error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch transactions.",
        });
    }
});


// Local development server
if (!process.env.VERCEL) {
    app.listen(port, () => {
        console.log(`MentorLagbe server running on port ${port}`);
    });
}

export default app;
