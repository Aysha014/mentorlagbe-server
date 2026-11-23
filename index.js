
import express from "express";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import cors from "cors";
import { createRemoteJWKSet, jwtVerify } from "jose";
import Stripe from "stripe";

const app = express();
const port = process.env.PORT || 8000;

const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null;

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

app.use(
    express.json({
        verify: (req, res, buf) => {
            if (req.originalUrl === "/stripe/webhook") {
                req.rawBody = buf;
            }
        },
    })
);

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


// ==========================================
// STRIPE SUBSCRIPTION APIs
// ==========================================

// Create monthly subscription checkout
app.post("/payments/create-checkout-session", verifyToken, async (req, res) => {
    try {
        if (!stripe) {
            return res.status(500).json({
                success: false,
                message: "Stripe is not configured on the server.",
            });
        }

        const user = await users().findOne({ email: req.user.email });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User account not found.",
            });
        }

        const role = user.role;
        const prices = {
            student: 1000, // $10/month
            tutor: 1500,   // $15/month
        };

        if (!prices[role]) {
            return res.status(403).json({
                success: false,
                message: "Only students and tutors can purchase Pro.",
            });
        }

        if (String(user.plan || user.subscriptionPlan || "free").toLowerCase() === "pro") {
            return res.status(409).json({
                success: false,
                message: "You already have a Pro plan.",
            });
        }

        const requestOrigin = req.headers.origin;

        const frontendUrl = allowedOrigins.includes(requestOrigin)
            ? requestOrigin
            : "https://mentorlagbe-client-sandy.vercel.app";

        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            customer_email: user.email,
            client_reference_id: req.user.id,
            line_items: [
                {
                    price_data: {
                        currency: "usd",
                        unit_amount: prices[role],
                        recurring: { interval: "month" },
                        product_data: {
                            name: `${role === "student" ? "Student" : "Tutor"} Pro`,
                            description: "MentorLagbe monthly Pro subscription",
                        },
                    },
                    quantity: 1,
                },
            ],
            metadata: {
                userId: req.user.id,
                email: user.email,
                role,
                plan: "pro",
            },
            subscription_data: {
                metadata: {
                    userId: req.user.id,
                    email: user.email,
                    role,
                    plan: "pro",
                },
            },
            success_url: `${frontendUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${frontendUrl}/payment/cancel`,
        });

        res.json({
            success: true,
            url: session.url,
        });
    } catch (error) {
        console.error("Stripe checkout error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to create Stripe checkout session.",
        });
    }
});


// Stripe webhook
app.post("/stripe/webhook", async (req, res) => {
    console.log("Stripe webhook received:", req.headers["stripe-signature"] ? "Signature present" : "Signature missing");
    console.log("Stripe configured:", !!stripe);
    console.log("Webhook secret configured:", !!process.env.STRIPE_WEBHOOK_SECRET);
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
        console.error("Stripe webhook configuration is missing.");
        return res.status(500).send("Stripe webhook is not configured.");
    }

    let event;

    try {
        event = stripe.webhooks.constructEvent(
            req.rawBody,
            req.headers["stripe-signature"],
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (error) {
        console.error("Stripe webhook signature error:", error.message);
        return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    console.log("Stripe signature verified. Event type:", event.type);

    try {
        // Checkout completed: activate Pro
        if (event.type === "checkout.session.completed") {
            const session = event.data.object;

            const email = session.metadata?.email || session.customer_details?.email;

            const subscriptionId =
                typeof session.subscription === "string"
                    ? session.subscription
                    : session.subscription?.id;

            console.log("Checkout completed:", {
                email,
                subscriptionId,
                userId: session.metadata?.userId,
            });

            if (email && subscriptionId) {
                const result = await users().updateOne(
                    { email },
                    {
                        $set: {
                            plan: "pro",
                            subscriptionPlan: "pro",
                            stripeCustomerId: session.customer,
                            stripeSubscriptionId: subscriptionId,
                            subscriptionStatus: "active",
                            updatedAt: new Date(),
                        },
                    }
                );

                console.log("User Pro update result:", {
                    matchedCount: result.matchedCount,
                    modifiedCount: result.modifiedCount,
                });
            } else {
                console.error("Checkout metadata or subscription ID is missing.");
            }
        }

        // Subscription changed or cancelled
        if (
            event.type === "customer.subscription.updated" ||
            event.type === "customer.subscription.deleted"
        ) {
            const subscription = event.data.object;
            const email = subscription.metadata?.email;
            const status = subscription.status;
            const isActive = ["active", "trialing"].includes(status);

            if (email) {
                await users().updateOne(
                    { email },
                    {
                        $set: {
                            plan: isActive ? "pro" : "free",
                            subscriptionPlan: isActive ? "pro" : "free",
                            subscriptionStatus: status,
                            stripeSubscriptionId: subscription.id,
                            updatedAt: new Date(),
                        },
                    }
                );
            }
        }

        // Record successful subscription invoices (including renewals)

        if (
            event.type === "invoice.paid" ||
            event.type === "invoice_payment.paid"
        ) {
            let invoice;
            let paymentIntentId = "";

            if (event.type === "invoice_payment.paid") {
                const invoicePayment = event.data.object;

                invoice = await stripe.invoices.retrieve(
                    invoicePayment.invoice
                );

                const paymentIntent = invoicePayment.payment?.payment_intent;

                paymentIntentId =
                    typeof paymentIntent === "string"
                        ? paymentIntent
                        : paymentIntent?.id || "";
            } else {
                invoice = event.data.object;
                paymentIntentId =
                    typeof invoice.payment_intent === "string"
                        ? invoice.payment_intent
                        : invoice.payment_intent?.id || "";
            }

            const subscriptionId =
                typeof invoice.subscription === "string"
                    ? invoice.subscription
                    : invoice.parent?.subscription_details?.subscription;

            if (subscriptionId) {
                const subscription = await stripe.subscriptions.retrieve(
                    subscriptionId
                );

                const email = subscription.metadata?.email;

                const user = email
                    ? await users().findOne({ email })
                    : null;

                const existingPayment = await payments().findOne({
                    stripeInvoiceId: invoice.id,
                });

                if (user && !existingPayment) {
                    await payments().insertOne({
                        userId: user._id.toString(),
                        userName: user.name || user.fullName || "User",
                        email: user.email,
                        role: user.role,
                        planName: `${user.role === "student" ? "Student" : "Tutor"} Pro`,
                        amount: (invoice.amount_paid || 0) / 100,
                        currency: invoice.currency || "usd",
                        transactionId: paymentIntentId || invoice.id,
                        stripeInvoiceId: invoice.id,
                        stripeSubscriptionId: subscriptionId,
                        sessionId: "",
                        status: "paid",
                        createdAt: new Date(invoice.created * 1000),
                    });

                    console.log("Payment recorded:", email, invoice.id);
                } else if (!user) {
                    console.error("Payment user not found:", email);
                } else {
                    console.log("Payment already recorded:", invoice.id);
                }
            } else {
                console.error("Subscription ID missing for invoice:", invoice.id);
            }
        }


        res.json({ received: true });
    } catch (error) {
        console.error("Stripe webhook processing error:", error.message);
        console.error(error.stack);
        res.status(500).json({
            success: false,
            message: "Webhook processing failed.",
        });
    }
});


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



// API: Get tutor profile
app.get("/tutor/profile", verifyToken, verifyTutor, async (req, res) => {
    try {
        const tutor = await users().findOne(
            { email: req.user.email },
            {
                projection: {
                    name: 1,
                    email: 1,
                    image: 1,
                    phone: 1,
                    bio: 1,
                    subjects: 1,
                    education: 1,
                    experience: 1,
                    location: 1,
                },
            }
        );

        if (!tutor) {
            return res.status(404).json({
                success: false,
                message: "Tutor profile not found.",
            });
        }

        res.json({
            success: true,
            data: {
                name: tutor.name || "",
                email: tutor.email || "",
                image: tutor.image || "",
                phone: tutor.phone || "",
                bio: tutor.bio || "",
                subjects: tutor.subjects || "",
                education: tutor.education || "",
                experience: tutor.experience || "",
                location: tutor.location || "",
            },
        });
    } catch (error) {
        console.error("Get tutor profile error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch tutor profile.",
        });
    }
});

// API: Update tutor profile
app.patch("/tutor/profile", verifyToken, verifyTutor, async (req, res) => {
    try {
        const allowedFields = [
            "name",
            "image",
            "phone",
            "bio",
            "subjects",
            "education",
            "experience",
            "location",
        ];

        const updates = {};

        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                if (typeof req.body[field] !== "string") {
                    return res.status(400).json({
                        success: false,
                        message: `Invalid ${field} value.`,
                    });
                }

                updates[field] = req.body[field].trim();
            }
        }

        if (!Object.keys(updates).length) {
            return res.status(400).json({
                success: false,
                message: "No valid profile information provided.",
            });
        }

        if (updates.name !== undefined && !updates.name) {
            return res.status(400).json({
                success: false,
                message: "Name is required.",
            });
        }

        updates.updatedAt = new Date();

        await users().updateOne(
            { email: req.user.email },
            { $set: updates }
        );

        res.json({
            success: true,
            message: "Profile updated successfully.",
        });
    } catch (error) {
        console.error("Update tutor profile error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to update tutor profile.",
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


// ==========================================
// STUDENT BOOKMARK APIs
// ==========================================

// Get student's bookmarked tuitions
app.get("/student/bookmarks", verifyToken, verifyStudent, async (req, res) => {
    try {
        const student = await users().findOne(
            { email: req.user.email },
            { projection: { bookmarks: 1 } }
        );

        const bookmarkIds = (student?.bookmarks || [])
            .filter((id) => ObjectId.isValid(id))
            .map((id) => new ObjectId(id));

        if (!bookmarkIds.length) {
            return res.json({
                success: true,
                data: [],
            });
        }

        const results = await tuitions()
            .find({
                _id: { $in: bookmarkIds },
                ...publicTuitionFilter,
            })
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
        console.error("Get bookmarks error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch bookmarks.",
        });
    }
});

// Add a tuition to bookmarks
app.post(
    "/student/bookmarks/:tuitionId",
    verifyToken,
    verifyStudent,
    async (req, res) => {
        try {
            const { tuitionId } = req.params;

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

            const student = await users().findOne({
                email: req.user.email,
            });

            if (!student) {
                return res.status(404).json({
                    success: false,
                    message: "Student account not found.",
                });
            }

            const bookmarks = student.bookmarks || [];

            if (bookmarks.includes(tuitionId)) {
                return res.status(409).json({
                    success: false,
                    message: "This tuition is already bookmarked.",
                });
            }

            const plan = String(
                student.plan || student.subscriptionPlan || "free"
            ).toLowerCase();

            const isPro = plan === "pro";

            if (!isPro && bookmarks.length >= 5) {
                return res.status(403).json({
                    success: false,
                    code: "BOOKMARK_LIMIT",
                    message: "Free Plan allows a maximum of 5 bookmarks. Upgrade to Pro for unlimited bookmarks.",
                });
            }

            const filter = { email: req.user.email };

            // Enforce the free-plan limit in the database update too.
            if (!isPro) {
                filter.$expr = {
                    $lt: [
                        { $size: { $ifNull: ["$bookmarks", []] } },
                        5,
                    ],
                };
            }

            const result = await users().updateOne(
                filter,
                {
                    $addToSet: {
                        bookmarks: tuitionId,
                    },
                    $set: {
                        updatedAt: new Date(),
                    },
                }
            );

            if (!result.matchedCount) {
                return res.status(403).json({
                    success: false,
                    code: "BOOKMARK_LIMIT",
                    message: "You have reached the 5-bookmark free-plan limit.",
                });
            }

            res.json({
                success: true,
                message: "Tuition bookmarked successfully.",
            });
        } catch (error) {
            console.error("Add bookmark error:", error);
            res.status(500).json({
                success: false,
                message: "Failed to bookmark tuition.",
            });
        }
    }
);

// Remove a tuition from bookmarks
app.delete(
    "/student/bookmarks/:tuitionId",
    verifyToken,
    verifyStudent,
    async (req, res) => {
        try {
            const { tuitionId } = req.params;

            if (!ObjectId.isValid(tuitionId)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid tuition ID.",
                });
            }

            const result = await users().updateOne(
                { email: req.user.email },
                {
                    $pull: {
                        bookmarks: tuitionId,
                    },
                    $set: {
                        updatedAt: new Date(),
                    },
                }
            );

            if (!result.matchedCount) {
                return res.status(404).json({
                    success: false,
                    message: "Student account not found.",
                });
            }

            res.json({
                success: true,
                message: "Bookmark removed successfully.",
            });
        } catch (error) {
            console.error("Remove bookmark error:", error);
            res.status(500).json({
                success: false,
                message: "Failed to remove bookmark.",
            });
        }
    }
);


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
// REVIEW SYSTEM APIs
// ==========================================

// Get reviews submitted by the logged-in student
app.get("/student/reviews", verifyToken, verifyStudent, async (req, res) => {
    try {
        const tutors = await users()
            .find(
                {
                    role: "tutor",
                    "reviews.studentId": req.user.id,
                },
                {
                    projection: {
                        name: 1,
                        fullName: 1,
                        reviews: 1,
                    },
                }
            )
            .toArray();

        const myReviews = tutors.flatMap((tutor) =>
            (tutor.reviews || [])
                .filter((review) => review.studentId === req.user.id)
                .map((review) => ({
                    ...review,
                    tutorName:
                        tutor.name ||
                        tutor.fullName ||
                        "Tutor",
                }))
        );

        myReviews.sort(
            (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime()
        );

        res.json({
            success: true,
            data: myReviews,
        });
    } catch (error) {
        console.error("Get student reviews error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch your reviews.",
        });
    }
});


// Get reviews received by the logged-in tutor
app.get("/tutor/reviews", verifyToken, verifyTutor, async (req, res) => {
    try {
        const tutor = await users().findOne(
            { email: req.user.email },
            { projection: { reviews: 1 } }
        );

        res.json({
            success: true,
            data: tutor?.reviews || [],
        });
    } catch (error) {
        console.error("Get tutor reviews error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch reviews.",
        });
    }
});


// Student submits a review for a tutor
app.post("/reviews", verifyToken, verifyStudent, async (req, res) => {
    try {
        const { tuitionId, rating, comment } = req.body;

        if (
            !ObjectId.isValid(tuitionId) ||
            !Number.isInteger(rating) ||
            rating < 1 ||
            rating > 5 ||
            typeof comment !== "string" ||
            !comment.trim()
        ) {
            return res.status(400).json({
                success: false,
                message: "Please provide a valid rating and review.",
            });
        }

        const application = await applications().findOne({
            tuitionId,
            studentId: req.user.id,
            status: "accepted",
        });

        if (!application) {
            return res.status(403).json({
                success: false,
                message:
                    "You can only review a tutor after your application is accepted.",
            });
        }

        const tuition = await tuitions().findOne({
            _id: new ObjectId(tuitionId),
        });

        if (!tuition?.tutorEmail) {
            return res.status(404).json({
                success: false,
                message: "Tutor not found.",
            });
        }

        const tutor = await users().findOne({
            email: tuition.tutorEmail,
            role: "tutor",
        });

        if (!tutor) {
            return res.status(404).json({
                success: false,
                message: "Tutor account not found.",
            });
        }

        const existingReview = (tutor.reviews || []).some(
            (review) =>
                review.studentId === req.user.id &&
                review.tuitionId === tuitionId
        );

        if (existingReview) {
            return res.status(409).json({
                success: false,
                message:
                    "You have already reviewed this tutor for this tuition.",
            });
        }

        const review = {
            studentId: req.user.id,
            studentName: req.user.name,
            tuitionId,
            tuitionTitle: tuition.title,
            rating,
            comment: comment.trim(),
            createdAt: new Date(),
        };

        await users().updateOne(
            { _id: tutor._id },
            {
                $push: { reviews: review },
                $set: { updatedAt: new Date() },
            }
        );

        res.status(201).json({
            success: true,
            message: "Review submitted successfully.",
            data: review,
        });
    } catch (error) {
        console.error("Submit review error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to submit review.",
        });
    }
});


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
