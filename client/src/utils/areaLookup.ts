export interface Area {
  id: number;
  name: string;
  city: string;
}

/** Resolve IDs using the database catalog, never a seed-order assumption. */
export function getAreaName(areaId?: number | string | null, areas: Area[] = []): string {
  if (areaId === undefined || areaId === null || areaId === "") return "Dhaka";
  const numericId = Number(areaId);
  if (Number.isNaN(numericId)) return String(areaId);
  return areas.find(area => area.id === numericId)?.name ?? `Area #${numericId}`;
}

/** Only exact, case-insensitive names resolve locally. The server handles aliases. */
export function getAreaIdByName(name?: string | null, areas: Area[] = []): number | null {
  const clean = name?.trim().toLowerCase();
  if (!clean) return null;
  return areas.find(area => area.name.toLowerCase() === clean)?.id ?? null;
}
