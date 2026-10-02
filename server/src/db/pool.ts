import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

const isLocalhost =
  !process.env.DATABASE_URL ||
  process.env.DATABASE_URL.includes("localhost") ||
  process.env.DATABASE_URL.includes("127.0.0.1");

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalhost ? false : { rejectUnauthorized: false },
});
// start with actual 0 connections
// as requests come in, it opens connections up to the max limit
// if an extra connection is requested beyond the max limit, it will wait until a connection is released back to the pool
// idle connections are closed after 10 seconds of inactivity by default, but this can be configured with the idleTimeoutMillis option
