import express from "express";
import cors from "cors";
import { registerRoutes } from "./routes";
import { DatabaseService } from "./services/database";

const app = express();
const PORT = 5000;

// Enable CORS
app.use(cors());

// Parse JSON bodies
app.use(express.json());

// Increase request size limit for chart images
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Start server
async function startServer() {
  try {
    // Test database connection
    const version = await DatabaseService.getInstance().testConnection();
    console.log("Connected to database:", version);

    // Register routes and start server
    await registerRoutes(app);
    console.log(`Server running on port ${PORT}`);
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
