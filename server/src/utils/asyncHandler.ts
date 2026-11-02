import { Request, Response, NextFunction } from "express";
import { AppError } from "../errors/AppError.js"; // custom error class

type AsyncFn = (req: Request, res: Response) => Promise<void>;
// defines a reusable type alias, takes req and res and returns a promise that resolves to nothing
// all the controller functions match this type

export const asyncHandler =
  (fn: AsyncFn) => async (req: Request, res: Response, next: NextFunction) => {
    // higher order function , take one and return one
    try {
      await fn(req, res); // calls the original controller
    } catch (err) {
      if (err instanceof AppError) {
        res.status(err.statusCode).json({ error: err.message }); // App_error
      } else if (err && typeof err === 'object' && 'code' in err && err.code === 'P0001' && err instanceof Error) {
        res.status(/not authorized/i.test(err.message) ? 403 : 400).json({ error: err.message });
      } else if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
        res.status(409).json({ error: 'A conflicting record already exists. Refresh and try again.' });
      } else {
        console.error('Request failed', err instanceof Error ? err.name : 'unknown_error');
        res.status(500).json({ error: "something went wrong" });
      }
    }
  };
// every route handler needs try catch, so we write this once here and wrap every controller with it in the router files
