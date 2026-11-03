import { createContext, useContext } from "react";
import type { Area } from "../utils/areaLookup";

export const AreaContext = createContext<{ areas: Area[]; loading: boolean; error: string | null }>({
  areas: [], loading: true, error: null,
});

export function useAreas() {
  return useContext(AreaContext);
}
