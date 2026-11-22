
import express from "express";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import cors from "cors";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();
const port = process.env.PORT || 8000;

// Better Auth JWT verification
const JWKS = createRemoteJWKSet(
  new URL(
    `${process.env.BETTER_AUTH_URL.replace(/\/$/, "")}/api/auth/jwks`
  )
);

// CORS
app.use(
  cors({
    origin: [
      process.env.CLIENT_URL,
      process.env.PRODUCTION_CLIENT_URL,
      "http://localhost:3000",
    ].filter(Boolean),
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
      issuer: process.env.BETTER_AUTH_URL.replace(/\/$/, ""),
      audience: process.env.BETTER_AUTH_URL.replace(/\/$/, ""),
    });

    if (!payload.sub || !payload.email) {
      return res.status(401).json({
        success: false,
        message: "Invalid user information.",
      });
    }

    // Get current user role from database
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

// API 3: Apply for a tuition (Students only)
app.post("/applications", verifyToken, verifyStudent, async (req, res) => {
  try {
    const {
      tuitionId,
      phone,
      preferredSchedule,
      learningNote = "",
    } = req.body;

    // Validate required fields
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

    // Check whether tuition exists and is available
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

    // Prevent duplicate applications
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

// Local development server
if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`MentorLagbe server running on port ${port}`);
  });
}

export default app;
