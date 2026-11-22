
import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient } from "mongodb";

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(express.json());

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);

// MongoDB connection
const client = new MongoClient(process.env.MONGODB_URI);

let database;

export async function connectToMongoDB() {
  await client.connect();

  database = client.db("mentorlagbe");

  console.log("Connected to MongoDB");

  return database;
}

// Health check
app.get("/", (req, res) => {
  res.send("MentorLagbe API is running!");
});

// Start server
async function startServer() {
  try {
    await connectToMongoDB();

    // Exactly four collections
    const users = database.collection("users");
    const tuitions = database.collection("tuitions");
    const applications = database.collection("applications");
    const payments = database.collection("payments");

    console.log("Database collections configured");

    app.listen(port, () => {
      console.log(`MentorLagbe server running on port ${port}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
}

startServer();
