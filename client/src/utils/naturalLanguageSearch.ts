export interface SearchFilters {
  areaId?: number;
  areaName?: string;
  minRent?: number;
  maxRent?: number;
  bedrooms?: number;
  minBedrooms?: number;
  bathrooms?: number;
  floor?: number;
  pets?: boolean;
  amenityNames?: string[];
  keywords?: string;
}

export interface SearchInterpretation {
  status: 'interpreted' | 'fallback';
  filters: SearchFilters;
  preferences: string[];
  unsupported: { requirement: string; mandatory: boolean; reason: string }[];
  warnings: string[];
  latencyMs: number;
}

export interface NaturalSearchState {
  phase: 'idle' | 'interpreting' | 'ready' | 'error';
  interpretation: SearchInterpretation | null;
}

export function getNaturalSearchBlock(state: NaturalSearchState, errors: string[] = []) {
  if (state.phase === 'interpreting') return 'Understanding your requirements…';
  if (state.interpretation?.status === 'fallback') return 'Choose ordinary search or try another description to continue.';
  if (state.phase !== 'ready' || !state.interpretation) return 'Submit a description to find matching apartments.';
  if (state.interpretation.unsupported.some((item) => item.mandatory)) {
    return 'Remove or revise unsupported mandatory requirements before viewing results.';
  }
  return errors.join(' ');
}

export function mergeSearchFilters(ai: SearchFilters, manual: SearchFilters) {
  const filters: SearchFilters = { ...ai };
  const errors: string[] = [];
  const aiArea = ai.areaId;
  const manualArea = manual.areaId;
  const sameName = Boolean(ai.areaName && manual.areaName && ai.areaName.trim().toLowerCase() === manual.areaName.trim().toLowerCase());
  const sameId = aiArea !== undefined && manualArea !== undefined && aiArea === manualArea;
  if ((ai.areaName || aiArea) && (manual.areaName || manualArea) && !sameName && !sameId) {
    errors.push('Area conflicts with your interpreted requirements. Change the manual area or edit the interpreted area.');
  } else if (manual.areaId !== undefined || manual.areaName) {
    filters.areaId = sameName ? aiArea ?? manualArea : manualArea;
    if (manual.areaName) filters.areaName = manual.areaName;
  }
  for (const key of ['bedrooms', 'bathrooms', 'floor', 'pets'] as const) {
    if (ai[key] !== undefined && manual[key] !== undefined && ai[key] !== manual[key]) {
      errors.push(`${key} conflicts with your interpreted requirements. Edit or remove one of the conflicting filters.`);
    } else if (manual[key] !== undefined) Object.assign(filters, { [key]: manual[key] });
  }
  for (const key of ['minRent', 'minBedrooms'] as const) {
    const values = [ai[key], manual[key]].filter((value): value is number => value !== undefined);
    if (values.length) filters[key] = Math.max(...values);
  }
  const maximums = [ai.maxRent, manual.maxRent].filter((value): value is number => value !== undefined);
  if (maximums.length) filters.maxRent = Math.min(...maximums);
  if (filters.minRent !== undefined && filters.maxRent !== undefined && filters.minRent > filters.maxRent) {
    errors.push('Your minimum rent exceeds the maximum budget. Edit the interpreted rent or manual budget.');
  }
  if (filters.bedrooms !== undefined && filters.minBedrooms !== undefined && filters.bedrooms < filters.minBedrooms) {
    errors.push('The selected bedroom count is below your required minimum. Edit one of these filters.');
  }
  if (ai.amenityNames?.length || manual.amenityNames?.length) {
    filters.amenityNames = [...new Set([...(ai.amenityNames || []), ...(manual.amenityNames || [])].map((name) => name.trim()).filter(Boolean))];
  }
  if (manual.keywords?.trim()) filters.keywords = [ai.keywords, manual.keywords].filter(Boolean).join(' ');
  return { filters, errors };
}

export function buildStrictSearchParams(filters: SearchFilters, cursor?: string) {
  const params = new URLSearchParams({ strict: '1' });
  for (const key of ['areaId', 'minRent', 'maxRent', 'bedrooms', 'minBedrooms', 'bathrooms', 'floor', 'pets', 'keywords'] as const) {
    const value = filters[key];
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  if (!filters.areaId && filters.areaName) params.set('area', filters.areaName);
  const amenities = filters.amenityNames?.map((name) => name.trim()).filter(Boolean);
  if (amenities?.length) params.set('amenities', amenities.join(','));
  if (cursor) params.set('cursor', cursor);
  return params;
}
