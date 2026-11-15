import { createContext } from "react";

// Hybrid release: the public website (AppLayout) keeps the Friday 13 Nov
// button look, the Console keeps the new one. AppLayout provides "website".
export const ButtonSurfaceContext = createContext("console");
