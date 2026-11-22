
import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient } from "mongodb";

const app = express();
const port = process.env.PORT || 5000;

// Allowed frontend origins
const allowedOrigins = [
  "http://localhost:3000",
  process.env.CLIENT_URL,
].filter(Boolean);

// Middleware
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

app.use(express.json());

// MongoDB connection
const uri = `mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-bysscth-shard-00-00.rbebje6.mongodb.net:27017,ac-bysscth-shard-00-01.rbebje6.mongodb.net:27017,ac-bysscth-shard-00-02.rbebje6.mongodb.net:27017/?ssl=true&replicaSet=atlas-ijkock-shard-0&authSource=admin`;

const client = new MongoClient(uri);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("Connected to MongoDB");
    return client;
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    throw error;
  }
}

const connectedClient = await connectToMongoDB();

const database = connectedClient.db("mentorlagbe");

// Application collections
const users = database.collection("users");
const tuitions = database.collection("tuitions");
const applications = database.collection("applications");
const payments = database.collection("payments");

console.log("MongoDB collections initialized.");

// Root endpoint
app.get("/", (req, res) => {
  res.send("MentorLagbe API is running!");
});

// Health check
app.get("/health", async (req, res) => {
  try {
    await database.command({ ping: 1 });

    res.status(200).json({
      success: true,
      message: "Server and database are healthy",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Database connection failed",
    });
  }
});

// Start server
app.listen(port, () => {
  console.log(`MentorLagbe server running on port ${port}`);
});
